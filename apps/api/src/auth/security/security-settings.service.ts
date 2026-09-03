import { Injectable } from '@nestjs/common';
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
  createdAt: string | null;
  updatedAt: string | null;
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
};

type SecurityRow = NonNullable<
  Awaited<ReturnType<PrismaService['securitySetting']['findFirst']>>
>;

// Phase 10 (ADR-027): owns the singleton SecuritySetting row — admin feature
// flags that make every security option OPTIONAL and toggleable. Reads are
// DB-backed per call (cheap, indexed) so a toggle applies immediately.
// Phase 11: also stores the Turnstile keys (site = public column, secret =
// AES-256-GCM encrypted via CryptoService — never returned).
@Injectable()
export class SecuritySettingsService {
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

    if (Object.keys(patch).length === 0 && !siteChanged && !secretChanged) {
      return this.toView(row);
    }

    const updated = await this.prisma.securitySetting.update({
      where: { id: row.id },
      data,
    });
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
}
