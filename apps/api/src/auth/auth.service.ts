import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProductStatus, Role, User } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { InvitationsService } from '../invitations/invitations.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { AuthTokens, ImpersonationMeta, JwtPayload, LoginResult } from './types';
import { SaRateLimiter, RATE, rateKey } from './rate-limiter';
import { TurnstileService } from './turnstile.service';
import { MfaService } from './mfa/mfa.service';
import { SecuritySettingsService } from './security/security-settings.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    @Inject(forwardRef(() => InvitationsService))
    private readonly invitations: InvitationsService,
    private readonly limiter: SaRateLimiter,
    private readonly turnstile: TurnstileService,
    private readonly mfa: MfaService,
    private readonly settings: SecuritySettingsService,
  ) {}

  // ───────────────────────── Order-time registration ─────────────────────────
  /**
   * Phase 10 (ADR-027): public self-registration stays CLOSED except DURING an
   * order. Requires a valid checkout intent (cookie ihp_checkout, signed by
   * CheckoutService) AND the admin's selfRegistrationEnabled flag. Creates the
   * account AND the PENDING subscription to the ordered product atomically.
   */
  async register(dto: RegisterDto, checkoutProductId: string | null): Promise<AuthTokens> {
    if (!checkoutProductId) {
      throw new ForbiddenException(
        'Création de compte autorisée uniquement lors d’une commande.',
      );
    }
    if (!(await this.settings.isSelfRegistrationEnabled())) {
      throw new ForbiddenException('Création de compte désactivée par la plateforme.');
    }
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ForbiddenException('Un compte existe déjà avec cet email — connectez-vous.');
    }
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.createOrderAccount({
      email: dto.email,
      name: dto.name ?? null,
      passwordHash,
      productId: checkoutProductId,
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.register',
      resourceType: 'user',
      resourceId: user.id,
      details: { productId: checkoutProductId },
    });
    return this.issueTokens(user);
  }

  /** Shared atomic create for a brand-new order-time account (email+password or OAuth). */
  async createOrderAccount(input: {
    email: string;
    name: string | null;
    passwordHash?: string;
    oauthProvider?: string;
    oauthSubject?: string;
    githubTokenEnc?: string;
    productId: string;
  }): Promise<User> {
    const product = await this.prisma.product.findUnique({
      where: { id: input.productId },
    });
    if (!product || product.status === ProductStatus.DRAFT || product.status === ProductStatus.DISABLED) {
      throw new BadRequestException('Produit indisponible pour cette commande.');
    }
    // OAuth-created accounts have no real password: store a random unguessable
    // hash so the required column is valid and password login can never succeed.
    const passwordHash =
      input.passwordHash ?? (await bcrypt.hash(randomBytes(32).toString('hex'), 10));
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
          role: Role.USER,
          oauthProvider: input.oauthProvider ?? null,
          oauthSubject: input.oauthSubject ?? null,
          githubTokenEnc: input.githubTokenEnc ?? null,
        },
      });
      const subscription = await tx.subscription.create({
        data: { userId: user.id, productId: input.productId },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorEmail: user.email,
          action: 'subscription.create',
          resourceType: 'subscription',
          resourceId: subscription.id,
          details: { productId: input.productId, productName: product.name },
        },
      });
      return user;
    });
  }

  // ───────────────────────── Invitation (unchanged) ─────────────────────────
  async acceptInvite(dto: AcceptInviteDto): Promise<AuthTokens> {
    const user = await this.invitations.consume(
      dto.token,
      dto.email,
      dto.password,
      dto.name,
    );
    return this.issueTokens(user);
  }

  // ───────────────────────── Login ─────────────────────────────────────────
  async login(dto: LoginDto, ip?: string): Promise<LoginResult> {
    const rl = this.limiter.consume(rateKey(ip, 'login'), RATE.login.limit, RATE.login.windowMs);
    if (!rl.allowed) {
      throw new UnauthorizedException(
        `Trop de tentatives. Réessayez dans ${Math.ceil(rl.retryAfterMs / 1000)} s.`,
      );
    }
    if (await this.settings.isTurnstileEnabled()) {
      const ok = await this.turnstile.verify(dto.turnstileToken ?? '', ip);
      if (!ok) throw new BadRequestException('Vérification anti-robot échouée.');
    }
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('Account disabled');
    }
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
    });
    const outcome = await this.mfa.evaluateLogin(user);
    if (outcome.status === 'verify') {
      return { mfaRequired: true, challengeId: outcome.challengeId, methods: outcome.methods };
    }
    if (outcome.status === 'enroll') {
      // Admin policy requires MFA but none is set up yet: NO session tokens.
      // A short-lived, single-purpose enrollment token lets the admin complete
      // MFA setup (MfaEnrollOrSessionGuard) and nothing else, then re-login.
      const enrollToken = await this.jwt.signAsync(
        { sub: user.id, email: user.email, role: user.role, mfaEnroll: true },
        { expiresIn: this.mfaEnrollTtlSeconds() },
      );
      return { mfaRequired: false, enroll: true, enrollToken };
    }
    return this.issueTokens(user);
  }

  // ───────────────────────── Impersonation ─────────────────────────────────
  /**
   * Phase 10 (ADR-027): admin/support "as client" session. The JWT is signed
   * with role USER (anti-escalation even if the target is later promoted) and
   * an `imp` marker; NO refresh row / cookie is created, so the session cannot
   * be prolonged past its TTL (default 60m, capped 24h).
   */
  async impersonate(
    targetId: string,
    actor: { sub: string; email: string },
    kind: ImpersonationMeta['kind'],
  ): Promise<{ accessToken: string }> {
    if (targetId === actor.sub) {
      throw new BadRequestException('Vous ne pouvez pas vous impersonner vous-même.');
    }
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundException('Utilisateur introuvable.');
    if (!target.isActive) throw new UnauthorizedException('Compte désactivé.');
    if (target.role === Role.ADMIN) {
      throw new ForbiddenException('Impossible d’impersoner un administrateur.');
    }
    const payload: JwtPayload = {
      sub: target.id,
      email: target.email,
      role: Role.USER,
      imp: { by: actor.sub, kind },
    };
    const ttl = this.impersonationTtlSeconds();
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: ttl });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'impersonate.start',
      resourceType: 'user',
      resourceId: target.id,
      details: { kind, targetEmail: target.email, ttlSeconds: ttl },
    });
    return { accessToken };
  }

  async returnFromImpersonation(actor: JwtPayload): Promise<void> {
    if (!actor.imp) return;
    await this.audit.record({
      actorId: actor.imp.by,
      actorEmail: actor.email,
      action: 'impersonate.end',
      resourceType: 'user',
      resourceId: actor.sub,
      details: { kind: actor.imp.kind },
    });
  }

  private impersonationTtlSeconds(): number {
    const raw = this.config.get<string>('impersonationExpiresIn') ?? '60m';
    const secs = this.parseDurationSeconds(raw);
    return Math.min(secs, 24 * 60 * 60); // cap 24h
  }

  private parseDurationSeconds(value: string): number {
    const m = /^(\d+)\s*(s|m|h|d)?$/.exec(value.trim());
    if (!m) return 3600;
    const n = Number(m[1]);
    const unit = m[2] ?? 's';
    switch (unit) {
      case 's': return n;
      case 'm': return n * 60;
      case 'h': return n * 3600;
      case 'd': return n * 86400;
      default: return n;
    }
  }

  // ───────────────────────── Tokens ─────────────────────────────────────────
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(refreshToken) },
    });
    if (
      !record ||
      record.revokedAt !== null ||
      record.expiresAt < new Date()
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.refresh',
      resourceType: 'user',
      resourceId: user.id,
    });
    return this.issueTokens(user);
  }

  async logout(refreshToken: string): Promise<void> {
    const hash = this.hashToken(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
    });
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (record?.userId) {
      const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
      await this.audit.record({
        actorId: record.userId,
        actorEmail: user?.email ?? null,
        action: 'auth.logout',
        resourceType: 'user',
        resourceId: record.userId,
      });
    }
  }

  /** Self-service password change (re-verifies the current password). */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Compte introuvable.');
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Mot de passe actuel incorrect.');
    }
    if (newPassword.length < 8) {
      throw new BadRequestException('Le nouveau mot de passe doit faire au moins 8 caractères.');
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.password.change',
      resourceType: 'user',
      resourceId: user.id,
    });
    return { ok: true };
  }

  /** Enroll-token TTL (seconds), default 900s, clamped 300..3600. */
  private mfaEnrollTtlSeconds(): number {
    const raw = this.config.get<number>('mfaOtpTtlSeconds') ?? 300;
    return Math.min(Math.max(raw * 3, 300), 3600);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Issue a token pair. With an `imp` marker, NO refresh row is created and
   *  refreshToken is returned empty (the controller must not set a cookie). */
  async issueTokens(user: User): Promise<AuthTokens> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    const accessToken = await this.jwt.signAsync(payload);

    const refreshToken = randomBytes(48).toString('base64url');
    const days = this.config.get<number>('refreshExpiresInDays') ?? 30;
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: this.hashToken(refreshToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      },
    });

    return { accessToken, refreshToken };
  }
}