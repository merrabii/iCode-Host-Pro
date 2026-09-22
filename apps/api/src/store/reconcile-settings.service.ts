import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateReconcileSettingDto } from './dto/update-reconcile-setting.dto';
import {
  ReconcileResolved,
  ReconcileSettings,
  ReconcileSettingOverrides,
  ReconcileSource,
  RECONCILE_ENV_KEYS,
  RECONCILE_OVERRIDE_KEYS,
  RECONCILE_SETTING_SINGLETON_ID,
  resolveReconcileSettings,
  resolveReconcileSettingsFull,
  validateReconcileSettings,
} from './reconcile-settings';

/** Vue exposée par GET/PATCH/RESET — overrides persistés + réglage effectif +
 *  source exacte de chaque valeur (DATABASE | ENV | DEFAULT). Aucun secret. */
export interface ReconcileSettingsView {
  overrides: ReconcileSettingOverrides;
  effective: ReconcileSettings;
  sources: Record<keyof ReconcileSettings, ReconcileSource>;
  createdAt: string | null;
  updatedAt: string | null;
}

type ReconcileRow = {
  id: string;
  enabled: boolean | null;
  scanIntervalMs: number | null;
  batchSize: number | null;
  leaseMs: number | null;
  attemptAlertThreshold: number | null;
  backoffInitialMs: number | null;
  maxBackoffMs: number | null;
  createdAt: Date;
  updatedAt: Date;
};

const EMPTY_OVERRIDES: ReconcileSettingOverrides = {};

/**
 * 17B.4B → 17B.4C1 — résolveur de configuration du moteur de réconciliation.
 *
 * LIT L'ENVIRONNEMENT via ConfigService (JAMAIS process.env côté moteur) et les
 * OVERRIDES ADMIN via le singleton PostgreSQL `ReconcileSetting`, et expose des
 * settings VALIDÉS au reste du code. Chaîne champ par champ :
 *   1. override non null en base (DATABASE) ;
 *   2. sinon valeur ConfigService/env (ENV) ;
 *   3. sinon défaut du code (DEFAULT).
 *
 * Lecture DB à CHAQUE appel (aucun cache persistant) : un changement admin est
 * visible au prochain `getSettings()` sans redémarrage. Absence de ligne
 * parfaitement supportée (→ env/défauts). Ligne/override invalide → warn sans
 * secret + fallback sûr env/défaut. La politique de fallback env→défaut reste
 * celle de 17B.4B (`resolveReconcileSettings`).
 *
 * AUCUNE boucle ni timer ici : modifier `enabled` en base ne démarre encore
 * aucun worker (activation réelle = 17B.4C2).
 */
@Injectable()
export class ReconcileSettingsService {
  private readonly log = new Logger(ReconcileSettingsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Overrides persistés (null après un PATCH null/absent). */
  private toOverrides(row: ReconcileRow | null): ReconcileSettingOverrides {
    if (!row) return { ...EMPTY_OVERRIDES };
    return {
      enabled: row.enabled,
      scanIntervalMs: row.scanIntervalMs,
      batchSize: row.batchSize,
      leaseMs: row.leaseMs,
      attemptAlertThreshold: row.attemptAlertThreshold,
      backoffInitialMs: row.backoffInitialMs,
      maxBackoffMs: row.maxBackoffMs,
    };
  }

  private async readEnv(): Promise<Record<string, string | undefined>> {
    const env: Record<string, string | undefined> = {};
    for (const key of Object.values(RECONCILE_ENV_KEYS)) {
      env[key] = this.config.get<string>(key);
    }
    return env;
  }

  private async row(): Promise<ReconcileRow | null> {
    const found = await this.prisma.reconcileSetting.findUnique({
      where: { id: RECONCILE_SETTING_SINGLETON_ID },
    });
    if (!found) return null;
    return {
      id: found.id,
      enabled: found.enabled,
      scanIntervalMs: found.scanIntervalMs,
      batchSize: found.batchSize,
      leaseMs: found.leaseMs,
      attemptAlertThreshold: found.attemptAlertThreshold,
      backoffInitialMs: found.backoffInitialMs,
      maxBackoffMs: found.maxBackoffMs,
      createdAt: found.createdAt,
      updatedAt: found.updatedAt,
    };
  }

  private async resolve(): Promise<ReconcileResolved> {
    const env = await this.readEnv();
    let overrides: ReconcileSettingOverrides;
    try {
      overrides = this.toOverrides(await this.row());
    } catch (e) {
      // base injoignable/invalide → fallback sûr env/défaut, warn sans secret.
      this.log.warn(`reconcile: lecture overrides DB impossible (${String(e)}) -> env/défauts`);
      overrides = { ...EMPTY_OVERRIDES };
    }
    return resolveReconcileSettingsFull(env, overrides, (message) => this.log.warn(message));
  }

  private toView(row: ReconcileRow | null, resolved: ReconcileResolved): ReconcileSettingsView {
    return {
      overrides: this.toOverrides(row),
      effective: resolved.settings,
      sources: resolved.sources,
      createdAt: row ? row.createdAt.toISOString() : null,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    };
  }

  /**
   * Settings VALIDÉS du moteur — DB → env → défauts. Appelée à chaque cycle par
   * ReconcileService (`await`), jamais mise en cache ici.
   */
  async getSettings(): Promise<ReconcileSettings> {
    return (await this.resolve()).settings;
  }

  /** Vue admin — overrides + effectif + sources (GET/PATCH/RESET). */
  async getView(): Promise<ReconcileSettingsView> {
    const env = await this.readEnv();
    let row: ReconcileRow | null = null;
    try {
      row = await this.row();
    } catch (e) {
      this.log.warn(`reconcile: lecture overrides DB impossible (${String(e)}) -> env/défauts`);
    }
    return this.toView(row, resolveReconcileSettingsFull(env, this.toOverrides(row), (m) => this.log.warn(m)));
  }

  /**
   * PATCH semantics — seuls les champs fournis changent ; `null` supprime un
   * override et revient au fallback env/défaut. Validation GLOBALE avant écriture
   * (aucune écriture partielle : un upsert unique et atomique). En concurrence,
   * l'id fixe garantit une seule ligne. Écriture puis audit best-effort (échec
   * audit ≠ échec d'écriture).
   */
  async update(
    dto: UpdateReconcileSettingDto,
    actor: { sub: string; email: string },
  ): Promise<ReconcileSettingsView> {
    const env = await this.readEnv();
    let prev: ReconcileRow | null = null;
    try {
      prev = await this.row();
    } catch (e) {
      this.log.warn(`reconcile: lecture overrides DB impossible (${String(e)}) -> env/défauts`);
    }
    const prevOverrides = this.toOverrides(prev);

    // Validation GLOBALE : on simule l'état post-PATCH complet puis on valide les
    // bornes + la paire. En cas d'issue → HTTP 400, AUCUNE écriture.
    const nextOverrides: ReconcileSettingOverrides = { ...prevOverrides };
    let touched: Array<keyof ReconcileSettingOverrides> = [];
    for (const key of RECONCILE_OVERRIDE_KEYS) {
      const value = dto[key];
      if (value === undefined) continue;
      nextOverrides[key] = value as never;
      touched.push(key);
    }
    if (touched.length === 0) {
      return this.toView(prev, resolveReconcileSettingsFull(env, prevOverrides, (m) => this.log.warn(m)));
    }

    // Validation GLOBALE sur la configuration EFFECTIVE qui résulterait du
    // PATCH : DB actuelle (overrides déjà persistés) + champs fournis + fallback
    // ENV/défauts pour le reste. On part de `nextOverrides` (= prev DB + patch),
    // jamais de `dto` seul ni de l'env seul : une incohérence née de
    // l'ACCUMULATION (ex. backoffInitialMs déjà en base + maxBackoffMs du patch)
    // doit être rejetée. `null` = override retiré → fallback. Aucune écriture
    // si une issue (l'upsert reste unique et atomique).
    const envBase = resolveReconcileSettings(env, (message) => this.log.warn(message));
    const candidate: ReconcileSettings = { ...envBase };
    for (const key of RECONCILE_OVERRIDE_KEYS) {
      const value = nextOverrides[key];
      if (value === undefined || value === null) continue;
      candidate[key] = value as never;
    }
    const issues = validateReconcileSettings(candidate);
    if (issues.length > 0) {
      throw new BadRequestException(`Réglages de réconciliation invalides : ${issues.join(' ; ')}`);
    }

    const resolved = resolveReconcileSettingsFull(env, nextOverrides, (message) => this.log.warn(message));

    const data = {
      enabled: nextOverrides.enabled ?? null,
      scanIntervalMs: nextOverrides.scanIntervalMs ?? null,
      batchSize: nextOverrides.batchSize ?? null,
      leaseMs: nextOverrides.leaseMs ?? null,
      attemptAlertThreshold: nextOverrides.attemptAlertThreshold ?? null,
      backoffInitialMs: nextOverrides.backoffInitialMs ?? null,
      maxBackoffMs: nextOverrides.maxBackoffMs ?? null,
    };
    const updated = await this.prisma.reconcileSetting.upsert({
      where: { id: RECONCILE_SETTING_SINGLETON_ID },
      create: { id: RECONCILE_SETTING_SINGLETON_ID, ...data },
      update: data,
    });

    // Audit best-effort (record() ne jette jamais) — détails sans secret.
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of touched) {
      changes[key] = { from: prevOverrides[key] ?? null, to: nextOverrides[key] ?? null };
    }
    try {
      await this.audit.record({
        actorId: actor.sub,
        actorEmail: actor.email,
        action: 'reconcile.settings.update',
        resourceType: 'reconcileSetting',
        resourceId: RECONCILE_SETTING_SINGLETON_ID,
        details: { fields: changes } as Prisma.InputJsonValue,
      });
    } catch (e) {
      // l'écriture DB est déjà commitée — un échec d'audit n'en fait pas un échec.
      this.log.warn(`reconcile: audit update non journalisé (${String(e)})`);
    }

    const row: ReconcileRow = {
      id: updated.id,
      enabled: updated.enabled,
      scanIntervalMs: updated.scanIntervalMs,
      batchSize: updated.batchSize,
      leaseMs: updated.leaseMs,
      attemptAlertThreshold: updated.attemptAlertThreshold,
      backoffInitialMs: updated.backoffInitialMs,
      maxBackoffMs: updated.maxBackoffMs,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
    return this.toView(row, resolveReconcileSettingsFull(env, this.toOverrides(row), (m) => this.log.warn(m)));
  }

  /**
   * Réinitialisation IDEMPOTENTE des overrides de réconciliation uniquement :
   * suppression de la ligne singleton → retour env/défauts. Ne touche à AUCUN
   * autre réglage (SecuritySetting etc.). Puis audit best-effort.
   */
  async reset(actor: { sub: string; email: string }): Promise<ReconcileSettingsView> {
    const env = await this.readEnv();
    let prev: ReconcileRow | null = null;
    try {
      prev = await this.row();
    } catch (e) {
      this.log.warn(`reconcile: lecture overrides DB impossible (${String(e)}) -> env/défauts`);
    }
    await this.prisma.reconcileSetting.deleteMany({ where: { id: RECONCILE_SETTING_SINGLETON_ID } });

    try {
      await this.audit.record({
        actorId: actor.sub,
        actorEmail: actor.email,
        action: 'reconcile.settings.reset',
        resourceType: 'reconcileSetting',
        resourceId: RECONCILE_SETTING_SINGLETON_ID,
        details: {
          fields: RECONCILE_OVERRIDE_KEYS.map((key) => ({
            name: key,
            from: prev?.[key] ?? null,
            to: null,
          })),
        } as Prisma.InputJsonValue,
      });
    } catch (e) {
      this.log.warn(`reconcile: audit reset non journalisé (${String(e)})`);
    }

    const resolved = resolveReconcileSettingsFull(env, {}, (message) => this.log.warn(message));
    return this.toView(null, resolved);
  }
}