import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CryptoService, MailCryptoError } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateMailSettingsDto } from './dto/update-mail-settings.dto';
import { MailSmtpConfig } from './mail-transport.factory';
import { MailException, MailService } from './mail.service';

/** What GET /admin/mail and PUT /admin/mail return — password is never echoed. */
export interface MailSettingsView {
  id: string | null;
  enabled: boolean;
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  hasPassword: boolean;
  fromEmail: string | null;
  fromName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const DEFAULT_VIEW: MailSettingsView = {
  id: null,
  enabled: false,
  host: null,
  port: 587,
  secure: false,
  user: null,
  hasPassword: false,
  fromEmail: null,
  fromName: null,
  createdAt: null,
  updatedAt: null,
};

type MailRow = NonNullable<Awaited<ReturnType<PrismaService['mailSetting']['findFirst']>>>;

// Phase 6 (ADR-022): owns the singleton MailSetting row — masked reads, PATCH
// updates (all-optional), AES-256-GCM password at rest, and the test/invitation
// sends. MailService itself stays stateless (config passed in) to avoid a
// provider cycle between settings and sending.
@Injectable()
export class MailSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  private toView(row: MailRow | null): MailSettingsView {
    if (!row) return { ...DEFAULT_VIEW };
    return {
      id: row.id,
      enabled: row.enabled,
      host: row.host,
      port: row.port,
      secure: row.secure,
      user: row.user,
      hasPassword: !!row.passwordEnc,
      fromEmail: row.fromEmail,
      fromName: row.fromName,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async get(): Promise<MailSettingsView> {
    const row = await this.prisma.mailSetting.findFirst();
    return this.toView(row);
  }

  /** Whether automatic sends are enabled — gates invitation emails. */
  async isEnabled(): Promise<boolean> {
    const row = await this.prisma.mailSetting.findFirst();
    return row?.enabled ?? false;
  }

  /**
   * PATCH-semantics upsert (all fields optional, undefined = leave unchanged).
   * - enabled=true requires host+fromEmail (400 otherwise).
   * - password: undefined/'' = keep stored one; value = encrypt+store (400 without ENCRYPTION_KEY).
   * - user/fromName: '' = clear to null.
   */
  async update(
    dto: UpdateMailSettingsDto,
    actor: { sub: string; email: string },
  ): Promise<MailSettingsView> {
    let row = await this.prisma.mailSetting.findFirst();

    // Resolve the post-update values for validation (undefined = keep existing/default)
    const nextHost = dto.host !== undefined ? dto.host : (row?.host ?? '');
    const nextFrom = dto.fromEmail !== undefined ? dto.fromEmail : (row?.fromEmail ?? '');
    const nextEnabled = dto.enabled !== undefined ? dto.enabled : (row?.enabled ?? false);

    if (nextEnabled && (!nextHost || !nextFrom)) {
      throw new BadRequestException(
        'Impossible d’activer l’envoi automatique : host et fromEmail sont requis.',
      );
    }

    // Password handling: undefined/'' = keep; otherwise encrypt at rest
    let passwordEnc: string | undefined;
    if (dto.password !== undefined && dto.password !== '') {
      try {
        passwordEnc = this.crypto.encrypt(dto.password);
      } catch (e) {
        if (e instanceof MailCryptoError) throw new BadRequestException(e.message);
        throw e;
      }
    }

    // Collect the caller-sent changes as plain scalars (undefined = untouched,
    // null = clear the nullable field, '' on user/fromName is normalized to null)
    const patch: Partial<Record<'enabled' | 'host' | 'port' | 'secure' | 'user' | 'passwordEnc' | 'fromEmail' | 'fromName', string | number | boolean | null>> = {};
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.host !== undefined) patch.host = dto.host;
    if (dto.port !== undefined) patch.port = dto.port;
    if (dto.secure !== undefined) patch.secure = dto.secure;
    if (dto.user !== undefined) patch.user = dto.user === '' ? null : dto.user;
    if (passwordEnc !== undefined) patch.passwordEnc = passwordEnc;
    if (dto.fromEmail !== undefined) patch.fromEmail = dto.fromEmail;
    if (dto.fromName !== undefined) patch.fromName = dto.fromName === '' ? null : dto.fromName;

    // No field to change → return the current view as-is
    if (Object.keys(patch).length === 0) {
      return this.toView(row);
    }

    if (!row) {
      // firstOrCreate: fill required db columns with the resolved (or default)
      // values even when the caller sent only a subset.
      const createData: Prisma.MailSettingCreateInput = {
        enabled: (patch.enabled as boolean | undefined) ?? false,
        host: (patch.host as string | undefined) ?? nextHost,
        port: (patch.port as number | undefined) ?? 587,
        secure: (patch.secure as boolean | undefined) ?? false,
        user: (patch.user as string | null | undefined) ?? null,
        fromEmail: (patch.fromEmail as string | undefined) ?? nextFrom,
        fromName: (patch.fromName as string | null | undefined) ?? null,
      };
      if (patch.passwordEnc !== undefined) createData.passwordEnc = patch.passwordEnc as string;
      if (!createData.host || !createData.fromEmail) {
        throw new BadRequestException(
          'host et fromEmail sont requis pour créer la configuration mail.',
        );
      }
      row = await this.prisma.mailSetting.create({ data: createData });
    } else {
      row = await this.prisma.mailSetting.update({
        where: { id: row.id },
        data: {
          ...(patch.enabled !== undefined ? { enabled: patch.enabled as boolean } : {}),
          ...(patch.host !== undefined ? { host: patch.host as string } : {}),
          ...(patch.port !== undefined ? { port: patch.port as number } : {}),
          ...(patch.secure !== undefined ? { secure: patch.secure as boolean } : {}),
          ...(patch.user !== undefined ? { user: patch.user as string | null } : {}),
          ...(patch.passwordEnc !== undefined ? { passwordEnc: patch.passwordEnc as string } : {}),
          ...(patch.fromEmail !== undefined ? { fromEmail: patch.fromEmail as string } : {}),
          ...(patch.fromName !== undefined ? { fromName: patch.fromName as string | null } : {}),
        },
      });
    }

    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'mail.settings.update',
      resourceType: 'mailSetting',
      resourceId: row.id,
      details: {
        enabled: row.enabled,
        host: row.host,
        port: row.port,
        secure: row.secure,
        hasPassword: !!row.passwordEnc,
      },
    });

    return this.toView(row);
  }

  /** Decrypted connection config (test + invitations). Throws MailException if no usable config. */
  async getMailConfig(): Promise<MailSmtpConfig> {
    const row = await this.prisma.mailSetting.findFirst();
    if (!row || !row.host || !row.fromEmail) {
      throw new MailException('Configuration mail non définie.');
    }
    let pass: string | null = null;
    if (row.passwordEnc) {
      try {
        pass = this.crypto.decrypt(row.passwordEnc);
      } catch (e) {
        if (e instanceof MailCryptoError) {
          throw new MailException(e.message);
        }
        throw new MailException(
          'Impossible de déchiffrer le mot de passe SMTP — vérifiez ENCRYPTION_KEY.',
        );
      }
    }
    return {
      host: row.host,
      port: row.port,
      secure: row.secure,
      user: row.user,
      pass,
      fromEmail: row.fromEmail,
      fromName: row.fromName,
    };
  }

  /** Send a test mail through the currently saved config (independent of `enabled`). */
  async test(
    to: string,
    actor: { sub: string; email: string },
  ): Promise<{ ok: true; message: string }> {
    let cfg: MailSmtpConfig;
    try {
      cfg = await this.getMailConfig();
    } catch (e) {
      const msg = e instanceof MailException ? e.message : String(e);
      throw new BadRequestException(msg);
    }
    try {
      await this.mail.sendMail(cfg, {
        to,
        subject: 'Test — iCode Host Pro',
        text: [
          'Ceci est un email de test envoyé depuis iCode Host Pro.',
          '',
          `Configuration : ${cfg.host}:${cfg.port} (${cfg.secure ? 'TLS implicite' : 'STARTTLS'})`,
          `Expéditeur : ${cfg.fromName ? `${cfg.fromName} <${cfg.fromEmail}>` : cfg.fromEmail}`,
        ].join('\n'),
      });
    } catch (e) {
      const msg = e instanceof MailException ? e.message : String(e);
      await this.audit.record({
        actorId: actor.sub,
        actorEmail: actor.email,
        action: 'mail.test',
        resourceType: 'mailSetting',
        details: { to, ok: false, error: msg },
      });
      throw new BadRequestException(msg);
    }
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'mail.test',
      resourceType: 'mailSetting',
      details: { to, ok: true },
    });
    return { ok: true, message: `Email de test envoyé à ${to}.` };
  }

  /**
   * Best-effort invitation email (called by InvitationsService after audit).
   * Throws MailException on failure — the caller catches and reports
   * emailSent=false (the manual token link remains the fallback).
   */
  async sendInvitationMail(input: {
    to: string;
    token: string;
    email: string;
  }): Promise<void> {
    const cfg = await this.getMailConfig();
    await this.mail.sendMail(cfg, this.mail.buildInviteMessage(input));
  }
}
