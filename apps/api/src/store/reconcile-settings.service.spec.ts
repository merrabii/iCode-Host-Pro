import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateReconcileSettingDto } from './dto/update-reconcile-setting.dto';
import {
  RECONCILE_DEFAULT_SETTINGS,
  RECONCILE_ENV_KEYS,
  RECONCILE_SETTINGS_BOUNDS,
  RECONCILE_SETTING_SINGLETON_ID,
} from './reconcile-settings';
import { ReconcileSettingsService } from './reconcile-settings.service';

// 17B.4C1 — persistance PostgreSQL + résolution DB → env → défauts + API service.
// Politique : override DB non null prioritaire ; null/absent → env/défaut ;
// ligne/valeur invalide → fallback sûr + warn sans secret ; validation GLOBALE
// avant écriture (aucune écriture partielle) ; audit best-effort.
describe('ReconcileSettingsService — persistance + résolution (17B.4C1)', () => {
  const act = { sub: 'adm-1', email: 'admin@example.com' };

  let configGet: jest.Mock;
  let findUnique: jest.Mock;
  let upsert: jest.Mock;
  let deleteMany: jest.Mock;
  let auditRecord: jest.Mock;
  let service: ReconcileSettingsService;

  function build(envMap: Record<string, string | undefined> = {}) {
    configGet = jest.fn((key: string) => envMap[key]);
    findUnique = jest.fn(async () => null);
    upsert = jest.fn(async (args: { create: Record<string, unknown> }) => ({
      id: RECONCILE_SETTING_SINGLETON_ID,
      enabled: (args.create.enabled as boolean) ?? null,
      scanIntervalMs: (args.create.scanIntervalMs as number) ?? null,
      batchSize: (args.create.batchSize as number) ?? null,
      leaseMs: (args.create.leaseMs as number) ?? null,
      attemptAlertThreshold: (args.create.attemptAlertThreshold as number) ?? null,
      backoffInitialMs: (args.create.backoffInitialMs as number) ?? null,
      maxBackoffMs: (args.create.maxBackoffMs as number) ?? null,
      createdAt: new Date('2026-09-22T00:00:00Z'),
      updatedAt: new Date('2026-09-22T00:00:00Z'),
    }));
    deleteMany = jest.fn(async () => ({ count: 1 }));
    auditRecord = jest.fn(async () => undefined);
    const prisma = {
      reconcileSetting: { findUnique, upsert, deleteMany },
    };
    service = new ReconcileSettingsService(
      { get: configGet } as never,
      prisma as unknown as PrismaService,
      { record: auditRecord } as unknown as AuditService,
    );
    return service;
  }

  const env = (o: Record<string, string>): Record<string, string | undefined> => ({ ...o });

  function row(over: Record<string, unknown>) {
    findUnique.mockResolvedValue({
      id: RECONCILE_SETTING_SINGLETON_ID,
      enabled: over.enabled ?? null,
      scanIntervalMs: over.scanIntervalMs ?? null,
      batchSize: over.batchSize ?? null,
      leaseMs: over.leaseMs ?? null,
      attemptAlertThreshold: over.attemptAlertThreshold ?? null,
      backoffInitialMs: over.backoffInitialMs ?? null,
      maxBackoffMs: over.maxBackoffMs ?? null,
      createdAt: new Date('2026-09-22T00:00:00Z'),
      updatedAt: new Date('2026-09-22T00:10:00Z'),
    });
  }

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('1. aucune ligne DB → env puis défaut (et jamais de crash)', async () => {
    const s = build(env({ [RECONCILE_ENV_KEYS.batchSize]: '25' }));
    const out = await s.getSettings();
    expect(out).toEqual({ ...RECONCILE_DEFAULT_SETTINGS, batchSize: 25 });
    expect(out.enabled).toBe(false);
  });

  it('2. override DB prioritaire sur env et défaut', async () => {
    const s = build(env({ [RECONCILE_ENV_KEYS.batchSize]: '25' }));
    row({ batchSize: 7 });
    const out = await s.getSettings();
    expect(out.batchSize).toBe(7);
  });

  it('3. résolution champ par champ (mix DB/env/défaut)', async () => {
    const s = build(
      env({
        [RECONCILE_ENV_KEYS.scanIntervalMs]: '60000',
        [RECONCILE_ENV_KEYS.batchSize]: '25',
      }),
    );
    row({ batchSize: 7 });
    const out = await s.getSettings();
    expect(out.scanIntervalMs).toBe(60_000); // ENV
    expect(out.batchSize).toBe(7); // DB
    expect(out.leaseMs).toBe(RECONCILE_DEFAULT_SETTINGS.leaseMs); // DEFAULT
  });

  it('4. null en base → fallback env/défaut', async () => {
    const s = build(env({ [RECONCILE_ENV_KEYS.enabled]: 'true' }));
    row({ enabled: null });
    const out = await s.getSettings();
    expect(out.enabled).toBe(true);
  });

  it('5. enabled=false explicite en base prioritaire', async () => {
    const s = build(env({ [RECONCILE_ENV_KEYS.enabled]: 'true' }));
    row({ enabled: false });
    expect((await s.getSettings()).enabled).toBe(false);
  });

  it('6. enabled=true explicite en base prioritaire', async () => {
    const s = build(env({ [RECONCILE_ENV_KEYS.enabled]: 'false' }));
    row({ enabled: true });
    expect((await s.getSettings()).enabled).toBe(true);
  });

  it('7. ligne DB invalide (hors bornes) → fallback sûr env/défaut + warn sans secret', async () => {
    const s = build(env({ [RECONCILE_ENV_KEYS.batchSize]: '25' }));
    row({ batchSize: 5000, leaseMs: 1 });
    const out = await s.getSettings();
    expect(out.batchSize).toBe(25);
    expect(out.leaseMs).toBe(RECONCILE_DEFAULT_SETTINGS.leaseMs);
  });

  it('8. bornes minimales/maximales exactes acceptées (DTO → update)', async () => {
    const s = build();
    const dto: UpdateReconcileSettingDto = {
      scanIntervalMs: RECONCILE_SETTINGS_BOUNDS.scanIntervalMs.min,
      batchSize: RECONCILE_SETTINGS_BOUNDS.batchSize.max,
      leaseMs: RECONCILE_SETTINGS_BOUNDS.leaseMs.max,
      attemptAlertThreshold: RECONCILE_SETTINGS_BOUNDS.attemptAlertThreshold.min,
      backoffInitialMs: RECONCILE_SETTINGS_BOUNDS.backoffInitialMs.min,
      maxBackoffMs: RECONCILE_SETTINGS_BOUNDS.maxBackoffMs.max,
    };
    const view = await s.update(dto, act);
    expect(view.effective.scanIntervalMs).toBe(RECONCILE_SETTINGS_BOUNDS.scanIntervalMs.min);
    expect(view.effective.maxBackoffMs).toBe(RECONCILE_SETTINGS_BOUNDS.maxBackoffMs.max);
  });

  it('9. valeurs hors bornes rejetées → HTTP 400 et AUCUNE écriture', async () => {
    const s = build();
    await expect(s.update({ leaseMs: 5 }, act)).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('10. maxBackoff < initial rejeté (même individuels valides) → aucun écriture', async () => {
    const s = build();
    await expect(
      s.update({ backoffInitialMs: 1_800_000, maxBackoffMs: 1_000_000 }, act),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('11. lease insuffisant rejeté (hors borne min) → aucun écriture', async () => {
    const s = build();
    await expect(s.update({ leaseMs: 20_000 }, act)).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('12. PATCH partiel ne modifie pas les champs absents', async () => {
    const s = build();
    row({ batchSize: 7 });
    const view = await s.update({ enabled: true }, act);
    expect(view.effective.enabled).toBe(true);
    expect(view.overrides.batchSize).toBe(7);
    expect(view.effective.batchSize).toBe(7);
  });

  it('13. PATCH invalide → aucune valeur modifiée (upsert non appelé)', async () => {
    const s = build();
    row({ batchSize: 7 });
    await s.update({ batchSize: 7 }, act); // ligne saine préexistante
    upsert.mockClear();
    await expect(s.update({ batchSize: 7, leaseMs: 5 }, act)).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('14. upsert singleton sur l\'id fixe (concurrence : une seule ligne)', async () => {
    const s = build();
    await s.update({ batchSize: 9 }, act);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: RECONCILE_SETTING_SINGLETON_ID } }),
    );
    const view = (await s.update({ batchSize: 11 }, act)) as { overrides: { batchSize: number | null } };
    expect(view.overrides.batchSize).toBe(11);
  });

  it('15. reset idempotent : suppression + retour env/défauts, DELETE appelé', async () => {
    const s = build(env({ [RECONCILE_ENV_KEYS.enabled]: 'true' }));
    row({ enabled: false });
    const view = await s.reset(act);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: RECONCILE_SETTING_SINGLETON_ID } });
    expect(view.effective.enabled).toBe(true);
    expect(view.overrides).toEqual({});
  });

  it('16. sources DATABASE/ENV/DEFAULT exactes dans la vue', async () => {
    const s = build(env({ [RECONCILE_ENV_KEYS.batchSize]: '25', [RECONCILE_ENV_KEYS.leaseMs]: '60000' }));
    row({ batchSize: 7 });
    const view = await s.getView();
    expect(view.sources.batchSize).toBe('DATABASE');
    expect(view.sources.leaseMs).toBe('ENV');
    expect(view.sources.enabled).toBe('DEFAULT');
    expect(view.sources.scanIntervalMs).toBe('DEFAULT');
  });

  it('17. audit modification : action, acteur, champs modifiés, anciennes/nouvelles valeurs', async () => {
    const s = build();
    row({ batchSize: 7 });
    await s.update({ batchSize: 7, enabled: true }, act);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'adm-1',
        actorEmail: 'admin@example.com',
        action: 'reconcile.settings.update',
        resourceId: RECONCILE_SETTING_SINGLETON_ID,
        details: expect.objectContaining({
          fields: expect.objectContaining({
            batchSize: { from: 7, to: 7 },
            enabled: { from: null, to: true },
          }),
        }),
      }),
    );
  });

  it('18. audit reset : action reset + liste des champs réinitialisés', async () => {
    const s = build();
    row({ batchSize: 7, enabled: false });
    await s.reset(act);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'reconcile.settings.reset',
        details: expect.objectContaining({ fields: expect.any(Array) }),
      }),
    );
    const details = (auditRecord.mock.calls[0][0] as { details: { fields: Array<{ to: unknown }> } }).details;
    expect(details.fields.every((f) => f.to === null)).toBe(true);
  });

  it('19. échec d\'audit après commit → le succès d\'écriture est conservé (pas de fausse erreur)', async () => {
    const s = build();
    auditRecord.mockRejectedValue(new Error('audit spool down'));
    const view = await s.update({ batchSize: 33 }, act);
    expect(view.effective.batchSize).toBe(33); // l'écriture a bien eu lieu
    const view2 = await s.reset(act);
    expect(view2.effective).toEqual(RECONCILE_DEFAULT_SETTINGS);
  });

  it('20. aucune exposition de secret (uniquement champs fonctionnels, jamais d\'env brut)', async () => {
    const s = build();
    row({ batchSize: 7 });
    const view = await s.getView();
    expect(Object.keys(view.overrides).sort()).toEqual(
      [
        'enabled',
        'scanIntervalMs',
        'batchSize',
        'leaseMs',
        'attemptAlertThreshold',
        'backoffInitialMs',
        'maxBackoffMs',
      ].sort(),
    );
    expect(view).not.toHaveProperty('secret');
    expect(view).not.toHaveProperty('environment');
  });

  it('21. ligne étrangère (autre id) jamais utilisée comme source des réglages', async () => {
    const s = build(env({ [RECONCILE_ENV_KEYS.batchSize]: '25' }));
    // Simulation fidèle du moteur Prisma : le where { id: X } est RESPECTÉ par la
    // PK. Une ligne étrangère peut exister ; la requête sur l'id canonique ne
    // doit pas la sélectionner.
    const foreign = {
      id: 'autre-id',
      enabled: null,
      scanIntervalMs: null,
      batchSize: 99,
      leaseMs: null,
      attemptAlertThreshold: null,
      backoffInitialMs: null,
      maxBackoffMs: null,
      createdAt: new Date('2026-09-22T00:00:00Z'),
      updatedAt: new Date('2026-09-22T00:10:00Z'),
    };
    findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'autre-id' ? (foreign as never) : null,
    );

    expect((await s.getSettings()).batchSize).toBe(25); // getSettings ignore 99
    const view = await s.getView();
    expect(view.overrides).toEqual({}); // GET admin ignore la ligne étrangère
    expect(view.createdAt).toBeNull();

    const patched = await s.update({ batchSize: 7 }, act); // PATCH écrit sur l'id canonique
    expect(patched.effective.batchSize).toBe(7);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: RECONCILE_SETTING_SINGLETON_ID } }),
    );

    await s.reset(act); // reset ne supprime QUE l'id canonique
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: RECONCILE_SETTING_SINGLETON_ID } });

    // CHAQUE lecture DB passe un where.id EXACT sur l'id canonique — aucune
    // lecture générique (findMany/findFirst sans where) ni id client.
    expect(findUnique.mock.calls.length).toBeGreaterThan(0);
    expect(findUnique.mock.calls.every((c) => c[0]?.where?.id === RECONCILE_SETTING_SINGLETON_ID)).toBe(true);
  });

  it('22. validation sur la config EFFECTIVE DB actuelle + patch partiel (paire héritée)', async () => {
    const s = build();
    row({ backoffInitialMs: 600_000, maxBackoffMs: 900_000 });

    // Patch ne touchant QUE maxBackoffMs : la fusion (600 000 initial en base +
    // 300 000 max) est INVAlIDE → HTTP 400 et AUCUNE écriture (ni upsert, ni audit).
    await expect(s.update({ maxBackoffMs: 300_000 }, act)).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();

    // Patch partiel VALIDE : la paire existante est préservée et la config
    // résultante reste conforme → écriture unique.
    const ok = await s.update({ scanIntervalMs: 120_000 }, act);
    expect(ok.overrides.backoffInitialMs).toBe(600_000);
    expect(ok.overrides.maxBackoffMs).toBe(900_000);
    expect(ok.effective.scanIntervalMs).toBe(120_000);
  });
});