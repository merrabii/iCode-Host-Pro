import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { CryptoService } from '../../crypto/crypto.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateSecuritySettingsDto } from './dto/update-security-settings.dto';

export interface SecuritySettingsView {
  id: string | null;
  turnstileEnabled: boolean;
  /** Clé SITE Turnstile — publique (widget), visible de l'admin. */
  turnstileSiteKey: string | null;
  /** La clé SECRET n'est JAMAIS renvoyée : seul son état (présente ?). */
  turnstileHasSecretKey: boolean;
  oauthGoogleEnabled: boolean;
  oauthGithubEnabled: boolean;
  mfaRequiredForAdmins: boolean;
  selfRegistrationEnabled: boolean;
  deployEnabled: boolean;
  /** Rate-limit admin du statut public de commande (défauts true/30/60). */
  orderStatusRateLimitEnabled: boolean;
  orderStatusRateLimitMax: number;
  orderStatusRateLimitWindowSec: number;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Fallback sécurisé du rate-limit du statut public de commande : protection
 *  ACTIVE 30 requêtes / 60 s quand la config est absente, invalide ou que la
 *  base est injoignable sans cache exploitable. */
export const ORDER_STATUS_RATE_LIMIT_FALLBACK = {
  enabled: true,
  limit: 30,
  windowMs: 60_000,
} as const;

/** Bornes fonctionnelles (le DTO applique les mêmes — double protection, la
 *  DB peut contenir des valeurs historiques hors bornes). */
export const ORDER_STATUS_RATE_LIMIT_BOUNDS = {
  limit: { min: 5, max: 1000 },
  windowSec: { min: 10, max: 3600 },
} as const;

export interface OrderStatusRateLimitConfig {
  enabled: boolean;
  limit: number;
  windowMs: number;
}

const DEFAULT_FLAGS: Omit<SecuritySettingsView, 'id' | 'createdAt' | 'updatedAt'> = {
  turnstileEnabled: false,
  turnstileSiteKey: null,
  turnstileHasSecretKey: false,
  oauthGoogleEnabled: false,
  oauthGithubEnabled: false,
  mfaRequiredForAdmins: false,
  selfRegistrationEnabled: false,
  deployEnabled: false,
  orderStatusRateLimitEnabled: true,
  orderStatusRateLimitMax: 30,
  orderStatusRateLimitWindowSec: 60,
};

export type SecurityFlags = Pick<
  SecuritySettingsView,
  'turnstileEnabled' |
    'oauthGoogleEnabled' |
    'oauthGithubEnabled' |
    'mfaRequiredForAdmins' |
    'selfRegistrationEnabled' |
    'deployEnabled'
>;

type FlagKey = keyof SecurityFlags;

const FLAG_KEYS: readonly FlagKey[] = [
  'turnstileEnabled',
  'oauthGoogleEnabled',
  'oauthGithubEnabled',
  'mfaRequiredForAdmins',
  'selfRegistrationEnabled',
  'deployEnabled',
] as const;

/** Colonnes réelles de SecuritySetting — jamais turnstileHasSecretKey (dérivé). */
const CREATE_DATA: Prisma.SecuritySettingCreateInput = {
  turnstileEnabled: false,
  turnstileSiteKey: null,
  turnstileSecretEnc: null,
  oauthGoogleEnabled: false,
  oauthGithubEnabled: false,
  mfaRequiredForAdmins: false,
  selfRegistrationEnabled: false,
  deployEnabled: false,
  orderStatusRateLimitEnabled: true,
  orderStatusRateLimitMax: 30,
  orderStatusRateLimitWindowSec: 60,
};

type SecurityRow = NonNullable<
  Awaited<ReturnType<PrismaService['securitySetting']['findFirst']>>
>;

/** Clamp défensif (la DB peut contenir des valeurs historiques hors bornes) ;
 *  toute valeur non finie retombe sur le fallback sécurisé. */
function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function rateLimitFromRow(row: SecurityRow): OrderStatusRateLimitConfig {
  return {
    // `?? true` : une valeur absente/invalide ne doit JAMAIS désactiver la
    // protection silencieusement — elle retombe sur le fallback sécurisé.
    enabled: row.orderStatusRateLimitEnabled ?? true,
    limit: clampInt(
      row.orderStatusRateLimitMax,
      ORDER_STATUS_RATE_LIMIT_BOUNDS.limit.min,
      ORDER_STATUS_RATE_LIMIT_BOUNDS.limit.max,
      ORDER_STATUS_RATE_LIMIT_FALLBACK.limit,
    ),
    windowMs:
      clampInt(
        row.orderStatusRateLimitWindowSec,
        ORDER_STATUS_RATE_LIMIT_BOUNDS.windowSec.min,
        ORDER_STATUS_RATE_LIMIT_BOUNDS.windowSec.max,
        ORDER_STATUS_RATE_LIMIT_FALLBACK.windowMs / 1000,
      ) * 1000,
  };
}

// Phase 10 (ADR-027): owns the singleton SecuritySetting row — admin feature
// flags that make every security option OPTIONAL and toggleable. Reads are
// DB-backed per call (cheap, indexed) so a toggle applies immediately.
// Phase 11: also stores the Turnstile keys (site = public column, secret =
// AES-256-GCM encrypted via CryptoService — never returned).
@Injectable()
export class SecuritySettingsService {
  private readonly log = new Logger(SecuritySettingsService.name);
  /** Cache mémoire du rate-limit du statut de commande (TTL 30 s, pattern
   *  MfaChallengeStore). Mono-instance assumé ; la stratégie multi-instances
   *  (Redis) suivra ADR-007 sans changer la signature du getter. */
  private orderStatusRateLimitCache: { value: OrderStatusRateLimitConfig; fetchedAt: number } | null =
    null;
  private readonly orderStatusRateLimitCacheTtlMs = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  private async row(): Promise<SecurityRow | null> {
    return this.prisma.securitySetting.findFirst();
  }

  private toView(row: SecurityRow | null): SecuritySettingsView {
    if (!row) return { id: null, ...DEFAULT_FLAGS, createdAt: null, updatedAt: null };
    return {
      id: row.id,
      turnstileEnabled: row.turnstileEnabled,
      turnstileSiteKey: row.turnstileSiteKey,
      turnstileHasSecretKey: !!row.turnstileSecretEnc,
      oauthGoogleEnabled: row.oauthGoogleEnabled,
      oauthGithubEnabled: row.oauthGithubEnabled,
      mfaRequiredForAdmins: row.mfaRequiredForAdmins,
      selfRegistrationEnabled: row.selfRegistrationEnabled,
      deployEnabled: row.deployEnabled,
      orderStatusRateLimitEnabled: row.orderStatusRateLimitEnabled,
      orderStatusRateLimitMax: row.orderStatusRateLimitMax,
      orderStatusRateLimitWindowSec: row.orderStatusRateLimitWindowSec,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async get(): Promise<SecuritySettingsView> {
    return this.toView(await this.row());
  }

  /** First-or-create the singleton with the default (all-off) flags. */
  private async ensure(): Promise<SecurityRow> {
    const existing = await this.row();
    if (existing) return existing;
    return this.prisma.securitySetting.create({ data: CREATE_DATA });
  }

  /** PATCH semantics — undefined = unchanged; returns the resulting view. */
  async update(
    dto: UpdateSecuritySettingsDto,
    actor: { sub: string; email: string },
  ): Promise<SecuritySettingsView> {
    const row = await this.ensure();
    const patch: Partial<Record<FlagKey, boolean>> = {};
    for (const key of FLAG_KEYS) {
      const value = dto[key as keyof UpdateSecuritySettingsDto];
      if (value !== undefined) patch[key] = value as boolean;
    }

    // Phase 11 — clés Turnstile : site (publique, '' = effacée) + secret
    // (write-only, '' = effacé, sinon chiffré AES-256-GCM au repos).
    const data: Prisma.SecuritySettingUpdateInput = { ...patch };
    let siteChanged = false;
    let secretChanged = false;
    if (dto.turnstileSiteKey !== undefined) {
      data.turnstileSiteKey = dto.turnstileSiteKey === '' ? null : dto.turnstileSiteKey;
      siteChanged = true;
    }
    if (dto.turnstileSecretKey !== undefined) {
      data.turnstileSecretEnc =
        dto.turnstileSecretKey === '' ? null : this.crypto.encrypt(dto.turnstileSecretKey);
      secretChanged = true;
    }

    // Rate-limit du statut public de commande (entiers bornés par le DTO ;
    // re-clampés à la lecture par rateLimitFromRow).
    let rateLimitChanged = false;
    if (dto.orderStatusRateLimitEnabled !== undefined) {
      data.orderStatusRateLimitEnabled = dto.orderStatusRateLimitEnabled;
      rateLimitChanged = true;
    }
    if (dto.orderStatusRateLimitMax !== undefined) {
      data.orderStatusRateLimitMax = dto.orderStatusRateLimitMax;
      rateLimitChanged = true;
    }
    if (dto.orderStatusRateLimitWindowSec !== undefined) {
      data.orderStatusRateLimitWindowSec = dto.orderStatusRateLimitWindowSec;
      rateLimitChanged = true;
    }

    if (Object.keys(patch).length === 0 && !siteChanged && !secretChanged && !rateLimitChanged) {
      return this.toView(row);
    }

    const updated = await this.prisma.securitySetting.update({
      where: { id: row.id },
      data,
    });
    // Invalidation locale IMMÉDIATE du cache rate-limit après un update admin.
    this.orderStatusRateLimitCache = null;
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'security.settings.update',
      resourceType: 'securitySetting',
      resourceId: updated.id,
      // Jamais la clé secret en clair dans l'audit — seulement son état.
      details: {
        ...(patch as Prisma.InputJsonObject),
        ...(siteChanged ? { turnstileSiteKey: updated.turnstileSiteKey } : {}),
        ...(secretChanged ? { turnstileHasSecretKey: !!updated.turnstileSecretEnc } : {}),
      } as Prisma.InputJsonObject,
    });
    return this.toView(updated);
  }

  // ── Policy helpers (single source of truth for every enforcement) ──────────

  async isTurnstileEnabled(): Promise<boolean> {
    return (await this.row())?.turnstileEnabled ?? false;
  }

  async isOAuthGoogleEnabled(): Promise<boolean> {
    return (await this.row())?.oauthGoogleEnabled ?? false;
  }

  async isOAuthGithubEnabled(): Promise<boolean> {
    return (await this.row())?.oauthGithubEnabled ?? false;
  }

  async isMfaRequiredForAdmins(): Promise<boolean> {
    return (await this.row())?.mfaRequiredForAdmins ?? false;
  }

  async isSelfRegistrationEnabled(): Promise<boolean> {
    return (await this.row())?.selfRegistrationEnabled ?? false;
  }

  async isDeployEnabled(): Promise<boolean> {
    return (await this.row())?.deployEnabled ?? false;
  }

  // ── Turnstile keys (Phase 11) ───────────────────────────────────────────────

  /** Clé SITE (publique, servie au widget du /auth). null = non configurée. */
  async getTurnstileSiteKey(): Promise<string | null> {
    return (await this.row())?.turnstileSiteKey ?? null;
  }

  /** Clé SECRET déchiffrée pour le siteverify serveur. null = non configurée. */
  async getTurnstileSecretKey(): Promise<string | null> {
    const enc = (await this.row())?.turnstileSecretEnc;
    if (!enc) return null;
    try {
      return this.crypto.decrypt(enc);
    } catch {
      return null; // clé de chiffrement absente/changée → dégrade en "non configurée"
    }
  }

  // ── Rate-limit du statut public de commande (cache TTL 30 s) ───────────────

  /**
   * Configuration effective du rate-limit de GET /store/orders/:id/status.
   * Cache mémoire 30 s : aucune requête Prisma tant que le cache est frais ;
   * invalidation locale immédiate après tout update admin (update() ci-dessus).
   * Erreur DB → dernier cache connu (même périmé), sinon fallback sécurisé
   * {enabled:true, 30/60 s} ; row absente → fallback sécurisé. Valeurs
   * re-clampées aux bornes fonctionnelles à la lecture.
   */
  async getOrderStatusRateLimit(): Promise<OrderStatusRateLimitConfig> {
    const now = Date.now();
    if (
      this.orderStatusRateLimitCache &&
      now - this.orderStatusRateLimitCache.fetchedAt < this.orderStatusRateLimitCacheTtlMs
    ) {
      return this.orderStatusRateLimitCache.value;
    }
    let next: OrderStatusRateLimitConfig;
    try {
      const row = await this.row();
      next = row ? rateLimitFromRow(row) : { ...ORDER_STATUS_RATE_LIMIT_FALLBACK };
    } catch (err) {
      if (this.orderStatusRateLimitCache) return this.orderStatusRateLimitCache.value;
      this.log.warn(
        `Lecture du rate-limit statut de commande impossible (${String(err)}) — fallback sécurisé 30/60 s.`,
      );
      return { ...ORDER_STATUS_RATE_LIMIT_FALLBACK };
    }
    this.orderStatusRateLimitCache = { value: next, fetchedAt: now };
    if (!next.enabled) {
      this.log.warn(
        'Rate-limit du statut public de commande DÉSACTIVÉ par configuration admin.',
      );
    }
    return next;
  }
}
