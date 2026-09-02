import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { JwtPayload } from '../auth/types';
import { MailSettingsService } from '../mail/mail-settings.service';
import { PrismaService } from '../prisma/prisma.service';

const MAX_ATTEMPTS = 5;

/**
 * Phase 10 (ADR-027): 6-digit temporary access codes — a client generates one
 * and relays it to support by phone/chat so an L2+ agent can open a READ-ONLY
 * impersonation of their account.
 *
 * Security model:
 * - Only the HMAC-SHA256 digest is stored (`codeHash`), never the plain code.
 * - ONE active code per user (generating revokes the previous one, atomic).
 * - Redemption compares digests with timingSafeEqual across every active code
 *   WITHOUT short-circuiting (no timing oracle), and is per-IP throttled.
 * - Because codes are stored hashed, a failed guess cannot be attributed to a
 *   specific code/user, so the anti-brute-force is the IP throttle (the
 *   5-attempts lockout lives in the MFA challenge where the target IS known).
 */
@Injectable()
export class SupportCodesService {
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly mailSettings: MailSettingsService,
    private readonly auth: AuthService,
  ) {
    const minutes = this.config.get<number>('supportCodeTtlMinutes') ?? 60;
    const clamped = Math.min(Math.max(minutes, 5), 1440);
    this.ttlMs = clamped * 60 * 1000;
  }

  private pepper(): string {
    return (
      this.config.get<string>('supportCodePepper') ??
      this.config.get<string>('encryptionKey') ??
      ''
    );
  }

  private hash(code: string): string {
    return createHmac('sha256', this.pepper()).update(code).digest('hex');
  }

  private constantTimeEqual(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // ── Client side: generate / status / revoke ─────────────────────────────────

  /** Generate a fresh 6-digit code (single active per user, atomic swap). */
  async generate(user: JwtPayload): Promise<{ code: string; expiresAt: string }> {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = this.hash(code);
    const expiresAt = new Date(Date.now() + this.ttlMs);

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.supportCode.updateMany({
        where: { userId: user.sub, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return tx.supportCode.create({
        data: { userId: user.sub, codeHash, expiresAt },
      });
    });

    await this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: 'support.code.generate',
      resourceType: 'supportCode',
      resourceId: created.id,
      details: { expiresAt: expiresAt.toISOString() },
    });

    // Best-effort email delivery of the code (phone relay remains the normal
    // channel — the code is shown exactly once to the client).
    const outcome: Record<string, string | boolean> = { sent: false };
    if (await this.mailSettings.canSend()) {
      try {
        await this.mailSettings.sendOtpMail(user.email, code, 'support');
        outcome.sent = true;
      } catch (e) {
        outcome.reason = e instanceof Error ? e.message : String(e);
      }
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'support.code.email',
        resourceType: 'supportCode',
        resourceId: created.id,
        details: outcome,
      });
    }

    return { code, expiresAt: expiresAt.toISOString() };
  }

  /** Active-code status for the current client (never the code itself). */
  async status(userId: string): Promise<{ active: boolean; expiresAt: string | null }> {
    const active = await this.prisma.supportCode.findFirst({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return active
      ? { active: true, expiresAt: active.expiresAt.toISOString() }
      : { active: false, expiresAt: null };
  }

  /** Revoke the current active code (if any). */
  async revoke(user: JwtPayload): Promise<{ revoked: boolean }> {
    const result = await this.prisma.supportCode.updateMany({
      where: { userId: user.sub, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count > 0) {
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'support.code.revoke',
        resourceType: 'supportCode',
        resourceId: user.sub,
      });
    }
    return { revoked: result.count > 0 };
  }

  // ── Support side: redeem ────────────────────────────────────────────────────

  /**
   * Validate a submitted 6-digit code and open a read-only support
   * impersonation of the code's owner. Timing-safe over all active codes,
   * no short-circuit; a miss only depends on the per-IP throttle.
   */
  async redeem(
    code: string,
    actor: { sub: string; email: string },
  ): Promise<{ accessToken: string }> {
    if (!/^\d{6}$/.test(code)) {
      throw new UnauthorizedException('Code invalide.');
    }
    const digest = this.hash(code);
    const target = Buffer.from(digest, 'hex');

    const active = await this.prisma.supportCode.findMany({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
      include: { user: true },
    });

    // Full pass over every active code — matches and misses cost the same.
    let matchedId: string | null = null;
    let matchedUserId: string | null = null;
    for (const sc of active) {
      const candidate = Buffer.from(sc.codeHash, 'hex');
      const equal = this.constantTimeEqual(target, candidate);
      if (equal) {
        matchedId = sc.id;
        matchedUserId = sc.userId;
      }
    }

    if (!matchedId || !matchedUserId) {
      throw new UnauthorizedException('Code invalide ou expiré.');
    }

    const owner = active.find((sc) => sc.id === matchedId)?.user;
    if (!owner) {
      throw new UnauthorizedException('Utilisateur introuvable.');
    }
    if (!owner.isActive) {
      throw new ForbiddenException('Compte désactivé.');
    }

    await this.prisma.supportCode.update({
      where: { id: matchedId },
      data: { attempts: 0 },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'support.code.redeem',
      resourceType: 'supportCode',
      resourceId: matchedId,
      details: { targetId: owner.id, targetEmail: owner.email },
    });
    return this.auth.impersonate(owner.id, actor, 'support');
  }
}
