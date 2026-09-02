import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role, User } from '@prisma/client';
import { randomInt, createHash, timingSafeEqual } from 'crypto';
import { AuditService } from '../../audit/audit.service';
import { CryptoService } from '../../crypto/crypto.service';
import { MailSettingsService } from '../../mail/mail-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SecuritySettingsService } from '../security/security-settings.service';
import { MfaChallengeStore, MfaMethod } from './mfa-challenge.store';
import { totp } from './totp';

// Phase 10 (ADR-027): TOTP (otplib v13 via the `totp` adapter) + email OTP fallback.
// TOTP policy (step 30, digits 6, window [1, 0]) lives in ./totp.

export type MfaOutcome =
  | { status: 'pass' }
  | { status: 'verify'; challengeId: string; methods: MfaMethod[] }
  | { status: 'enroll' }; // admin policy: MFA required but not yet set up

const MAX_ATTEMPTS = 5;

@Injectable()
export class MfaService {
  private readonly challengeTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly settings: SecuritySettingsService,
    private readonly mailSettings: MailSettingsService,
    private readonly store: MfaChallengeStore,
  ) {
    // challenge TTL default 300s, clamped 60..1800.
    const raw = this.config.get<number>('mfaOtpTtlSeconds') ?? 300;
    this.challengeTtlMs =
      Math.min(Math.max(raw, 60), 1800) * 1000;
  }

  private hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private async emailAvailable(): Promise<boolean> {
    return this.mailSettings.canSend();
  }

  // ── Login negotiation ────────────────────────────────────────────────────────
  /** Decide what a successful password/OAuth login must do next. */
  async evaluateLogin(user: User): Promise<MfaOutcome> {
    if (user.mfaEnabled) {
      return this.openChallenge(user);
    }
    if (
      user.role === Role.ADMIN &&
      (await this.settings.isMfaRequiredForAdmins())
    ) {
      return { status: 'enroll' };
    }
    return { status: 'pass' };
  }

  private async openChallenge(user: User): Promise<MfaOutcome> {
    const methods: MfaMethod[] = ['totp'];
    if (await this.emailAvailable()) methods.push('email');
    const challengeId = this.store.create({
      sub: user.id,
      method: 'totp',
      methods,
      ttlMs: this.challengeTtlMs,
    });
    return { status: 'verify', challengeId, methods };
  }

  // ── Verification (single-use, attempts-capped) ───────────────────────────────
  async verify(
    challengeId: string,
    code: string,
    method: MfaMethod,
  ): Promise<User> {
    const challenge = this.store.get(challengeId);
    if (!challenge) {
      throw new UnauthorizedException('Challenge MFA invalide ou expiré.');
    }
    if (challenge.attempts >= MAX_ATTEMPTS) {
      this.store.consume(challengeId);
      throw new UnauthorizedException('Trop de tentatives — reconnexion requise.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: challenge.sub },
    });
    if (!user?.mfaEnabled) {
      throw new UnauthorizedException('Compte sans MFA active.');
    }

    let ok = false;
    if (method === 'totp') {
      ok = await this.verifyTotp(user, code);
    } else if (method === 'email') {
      ok = this.verifyEmailOtp(challenge, code);
    } else {
      throw new BadRequestException('Méthode MFA inconnue.');
    }

    if (!ok) {
      challenge.attempts += 1;
      if (challenge.attempts >= MAX_ATTEMPTS) {
        this.store.consume(challengeId);
      } else {
        this.store.save(challenge);
      }
      throw new UnauthorizedException('Code MFA incorrect.');
    }

    this.store.consume(challengeId);
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.mfa.verify',
      resourceType: 'user',
      resourceId: user.id,
      details: { method },
    });
    return user;
  }

  private async verifyTotp(user: User, code: string): Promise<boolean> {
    if (!user.mfaSecretEnc) return false;
    let secret: string;
    try {
      secret = this.crypto.decrypt(user.mfaSecretEnc);
    } catch {
      return false;
    }
    try {
      return totp.check(code, secret);
    } catch {
      return false;
    }
  }

  private verifyEmailOtp(
    challenge: { emailOtpHash?: string; emailOtpExpiresAt?: number },
    code: string,
  ): boolean {
    if (!challenge.emailOtpHash || !challenge.emailOtpExpiresAt) return false;
    if (Date.now() > challenge.emailOtpExpiresAt) return false;
    return this.constantTimeEqual(challenge.emailOtpHash, this.hash(code));
  }

  /** Send an email OTP for a pending challenge (best-effort). */
  async sendEmailOtp(challengeId: string): Promise<{ sent: boolean; reason?: string }> {
    const challenge = this.store.get(challengeId);
    if (!challenge) {
      throw new UnauthorizedException('Challenge MFA invalide ou expiré.');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: challenge.sub },
    });
    if (!user) throw new UnauthorizedException('Utilisateur introuvable.');

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    challenge.emailOtpHash = this.hash(code);
    challenge.emailOtpExpiresAt = Date.now() + this.challengeTtlMs;
    this.store.save(challenge);

    const outcome: Record<string, string | boolean> = { sent: true };
    try {
      await this.mailSettings.sendOtpMail(user.email, code, 'mfa');
    } catch (e) {
      outcome.sent = false;
      outcome.reason = e instanceof Error ? e.message : String(e);
    }
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.mfa.email.send',
      resourceType: 'user',
      resourceId: user.id,
      details: outcome,
    });
    return outcome as { sent: boolean; reason?: string };
  }

  // ── Self-service setup / confirm / disable ───────────────────────────────────
  /** Re-verify the password, generate + store a TOTP secret (not yet active). */
  async setupTOTP(userId: string, password: string): Promise<{ secret: string; uri: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Compte introuvable.');
    const bcrypt = await import('bcryptjs');
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Mot de passe incorrect.');
    }
    if (user.mfaEnabled) {
      throw new BadRequestException('MFA déjà active sur ce compte.');
    }
    const secret = totp.generateSecret();
    const encrypted = this.crypto.encrypt(secret);
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecretEnc: encrypted },
    });
    const uri = totp.keyuri(user.email, 'iCode Host Pro', secret);
    return { secret, uri };
  }

  async confirmTOTP(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mfaSecretEnc) {
      throw new BadRequestException('Aucun secret TOTP en attente d’activation.');
    }
    if (user.mfaEnabled) {
      throw new BadRequestException('MFA déjà active.');
    }
    let secret: string;
    try {
      secret = this.crypto.decrypt(user.mfaSecretEnc);
    } catch {
      throw new BadRequestException('Secret TOTP invalide.');
    }
    if (!totp.check(code, secret)) {
      throw new UnauthorizedException('Code TOTP incorrect.');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true },
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'mfa.enable',
      resourceType: 'user',
      resourceId: user.id,
    });
    return { mfaEnabled: true };
  }

  async disable(userId: string, password: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mfaEnabled) {
      throw new BadRequestException('MFA n’est pas active sur ce compte.');
    }
    const bcrypt = await import('bcryptjs');
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Mot de passe incorrect.');
    }
    if (!user.mfaSecretEnc) {
      throw new BadRequestException('Secret TOTP manquant.');
    }
    const secret = (() => {
      try {
        return this.crypto.decrypt(user.mfaSecretEnc!);
      } catch {
        return null;
      }
    })();
    if (!secret || !totp.check(code, secret)) {
      throw new UnauthorizedException('Code TOTP incorrect.');
    }
    // Re-verify password too strong? No — the caller must pass a fresh code.
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecretEnc: null },
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'mfa.disable',
      resourceType: 'user',
      resourceId: user.id,
    });
    return { mfaEnabled: false };
  }

  /** ADMIN recovery — deactivate a locked-out account's MFA. */
  async adminReset(userId: string, actor: { sub: string; email: string }) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Compte introuvable.');
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecretEnc: null },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'mfa.admin-reset',
      resourceType: 'user',
      resourceId: userId,
      details: { target: user.email },
    });
    return { mfaEnabled: updated.mfaEnabled };
  }

  private constantTimeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }
}