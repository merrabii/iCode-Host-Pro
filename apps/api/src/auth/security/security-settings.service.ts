import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateSecuritySettingsDto } from './dto/update-security-settings.dto';

export interface SecuritySettingsView {
  id: string | null;
  turnstileEnabled: boolean;
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

type SecurityRow = NonNullable<
  Awaited<ReturnType<PrismaService['securitySetting']['findFirst']>>
>;

// Phase 10 (ADR-027): owns the singleton SecuritySetting row — admin feature
// flags that make every security option OPTIONAL and toggleable. Reads are
// DB-backed per call (cheap, indexed) so a toggle applies immediately.
@Injectable()
export class SecuritySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async row(): Promise<SecurityRow | null> {
    return this.prisma.securitySetting.findFirst();
  }

  private toView(row: SecurityRow | null): SecuritySettingsView {
    if (!row) return { id: null, ...DEFAULT_FLAGS, createdAt: null, updatedAt: null };
    return {
      id: row.id,
      turnstileEnabled: row.turnstileEnabled,
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
    return this.prisma.securitySetting.create({ data: { ...DEFAULT_FLAGS } });
  }

  /** PATCH semantics — undefined = unchanged; returns the resulting view. */
  async update(
    dto: UpdateSecuritySettingsDto,
    actor: { sub: string; email: string },
  ): Promise<SecuritySettingsView> {
    const row = await this.ensure();
    const patch: Partial<Record<FlagKey, boolean>> = {};
    for (const key of Object.keys(DEFAULT_FLAGS) as FlagKey[]) {
      const value = dto[key];
      if (value !== undefined) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) {
      return this.toView(row);
    }
    const updated = await this.prisma.securitySetting.update({
      where: { id: row.id },
      data: patch,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'security.settings.update',
      resourceType: 'securitySetting',
      resourceId: updated.id,
      details: patch as Prisma.InputJsonObject,
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
}