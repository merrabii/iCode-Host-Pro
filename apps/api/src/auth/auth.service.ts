import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, ProductStatus, Role, SubscriptionStatus, User } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { InvitationsService } from '../invitations/invitations.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { FreeSignupDto } from './dto/free-signup.dto';
import { AuthTokens, ImpersonationMeta, JwtPayload, LoginResult } from './types';
import { SaRateLimiter, RATE, rateKey } from './rate-limiter';
import { TurnstileService } from './turnstile.service';
import { MfaService } from './mfa/mfa.service';
import { SecuritySettingsService } from './security/security-settings.service';
import { MailSettingsService } from '../mail/mail-settings.service';

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
    private readonly mailSettings: MailSettingsService,
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

  /**
   * Phase 16 — inscription autonome du Plan Gratuit, SANS checkout-intent.
   * Boundée au produit marqué `freePlan` : un produit payant ne peut PAS passer
   * par là (il exige toujours le checkout). Crée le compte + l'abonnement
   * ACTIVE au free, atomiquement. Guardé par rate-limit (comme `register`).
   */
  async freeSignup(dto: FreeSignupDto, ip?: string): Promise<AuthTokens> {
    const rl = this.limiter.consume(rateKey(ip, 'register'), RATE.register.limit, RATE.register.windowMs);
    if (!rl.allowed) {
      throw new UnauthorizedException(
        `Trop de tentatives. Réessayez dans ${Math.ceil(rl.retryAfterMs / 1000)} s.`,
      );
    }
    const product = await this.resolveFreeProduct(dto.planSlug || undefined);
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ForbiddenException('Un compte existe déjà avec cet email — connectez-vous.');
    }
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.createFreeAccount({
      email: dto.email,
      name: dto.name ?? null,
      passwordHash,
      product,
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.free.signup',
      resourceType: 'user',
      resourceId: user.id,
      details: { productId: product.id, productName: product.name },
    });
    return this.issueTokens(user);
  }

  /** Résout le Plan Gratuit (flag `freePlan`) — par slug si fourni, sinon le
   *  premier actif. Partagé par `freeSignup` (email) et le mode OAuth `free`. */
  async freeProductBySlug(slug?: string) {
    return this.resolveFreeProduct(slug);
  }

  private async resolveFreeProduct(slug?: string) {
    const product = slug
      ? await this.prisma.product.findFirst({ where: { slug, freePlan: true } })
      : await this.prisma.product.findFirst({
          where: { freePlan: true },
          orderBy: { displayOrder: 'asc' },
        });
    if (!product || product.status !== ProductStatus.ACTIVE || product.freePlan !== true) {
      throw new ForbiddenException('Aucun Plan Gratuit disponible à l’inscription autonome.');
    }
    return { id: product.id, name: product.name };
  }

  /** Shared atomic create pour un compte free (email+password ou OAuth) :
   *  User + Customer + Subscription ACTIVE (les abonnements sans état créés via
   *  createOrderAccount restent PENDING par défaut — ici on veut ACTIVE, pas
   *  d'attente : l'inscription gratuite débloque immédiatement l'espace client). */
  async createFreeAccount(input: {
    email: string;
    name: string | null;
    passwordHash?: string;
    oauthProvider?: string;
    oauthSubject?: string;
    githubTokenEnc?: string;
    product: { id: string; name: string };
  }): Promise<User> {
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
      // Abonnement ACTIVE immédiat (pas de paiement → pas d'état PENDING).
      const subscription = await tx.subscription.create({
        data: {
          userId: user.id,
          productId: input.product.id,
          status: SubscriptionStatus.ACTIVE,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorEmail: user.email,
          action: 'subscription.create',
          resourceType: 'subscription',
          resourceId: subscription.id,
          details: { productId: input.product.id, productName: input.product.name, via: 'free-signup' },
        },
      });
      return user;
    });
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
    // Phase 3: le gate repose sur isActive() (flag admin ET clés SITE+SECRET
    // présentes), la même notion que public-config → le frontend ne peut jamais
    // être sans widget alors que le backend exigerait un token impossible à
    // produire (divergence login impossible quand la config est incomplète).
    if (await this.turnstile.isActive()) {
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
  /**
   * Rotation du refresh token — **contrat GO Q12 (revue)** :
   *
   * Deux portées de révocation, nettement distinctes :
   *
   * 1. **Access token = stateless JWT** (voir `issueTokens`) : signature + `exp`
   *    seuls, aucun appel base dans JwtAuthGuard. Durée = `jwtExpiresIn`
   *    (défaut 15 min). Logout / reset / kill-switch admin **ne révoquent PAS**
   *    un bearer déjà émis : il expire tout seul. C'est une garantie de DURÉE
   *    (au plus 15 min de résiduel), pas une révocation forte.
   *
   * 2. **Refresh token = révocation serveur FORTE, par famille (`sessionId`)** :
   *    chaque login crée une famille ; la rotation reste dans la même famille ;
   *    logout détruit **toute la famille** (toutes lignes, actives ET en cours
   *    de rotation) ; reset/changePassword détruisent **toutes les lignes de
   *    l'utilisateur** (toutes familles, actives ET révoquées — une ligne
   *    révoquée survivant à un reset reste dans la fenêtre de rejeu et
   *    ressusciterait une session).
   *
   * Détails de rotation :
   *  - **Barrière commune (GO corr. finales P1)** : rotation/ré-émission/login
   *    ET révocation (logout/changePassword/resetPassword) passent tous par le
   *    **verrou de la ligne `User`** (identité durable, toujours présente) avant
   *    toute écriture refresh. Sans cette barrière, le `DELETE` d'un logout en
   *    cours ne voit pas le successeur inséré par une rotation concurrente
   *    (snapshot READ COMMITTED) et le token survit à la révocation. Avec la
   *    barrière, les deux ordres d'exécution convergent : soit la révocation
   *    part en premier (rotation → CAS count 0 → 401, aucune écriture), soit la
   *    rotation part en premier (le logout committé ensuite détruit l'intégralité
   *    de la famille, successeur compris). Aucune survie ni résurrection.
   *  - **CAS de rotation** : la ligne n'est révoquée que si elle est encore
   *    active (`revokedAt: null`). CAS + création du successeur s'exécutent
   *    dans **une même transaction**, sous la barrière User.
   *  - **Course perdue (count 0)** : relecture de la ligne réelle en base.
   *    Absente (logout/reset committé entre la lecture initiale et le CAS) →
   *    401, aucun émetteur, aucune ressurrection. Présente mais pas révoquée /
   *    expirée / révoquée > 10 s → 401. Présente révoquée ≤ 10 s → rotation
   *    concurrente légitime, ré-émission SOUS VERROU (probe `updateMany` sur la
   *    ligne : count 0 = famille détruite pendant la course → 401).
   *  - **Fenêtre de rejeu 10 s** (réutilisation LÉGITIME de rotation : 2
   *    onglets / appel en double) : audit `auth.refresh.reuse`, nouveau jeton
   *    **dans la même famille**. Une ligne ABSENTE n'entre jamais dans cette
   *    fenêtre. Le double-refresh légitime reste donc servi — chaque émission
   *    passe par la barrière User.
   *  - **Compte désactivé** (`isActive=false`) : refus avant toute rotation.
   *  - **Access tokens résiduels (documentation séparée)** : le JWT d'accès est
   *    stateless (signature + `exp` uniquement) — logout/reset/changePassword
   *    ne révoquent PAS un bearer déjà émis ; il reste utilisable au plus
   *    `jwtExpiresIn` (défaut **15 min**) après la révocation. C'est une durée
   *    résiduelle garantie par construction, pas une révocation forte : le
   *    point de révocation serveur fort est la ligne refresh (barrière ci-dessus).
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(refreshToken) },
    });
    if (!record) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    if (record.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // Compte désactivé entre-temps : refus AVANT toute rotation — la ligne de
    // session reste intacte et reprend seule après réactivation (kill-switch
    // admin sans détruire les sessions).
    if (!user.isActive) {
      throw new UnauthorizedException('Account disabled');
    }

    // Déjà roté : fenêtre de réutilisation légitime (≤ 10 s), MAIS seulement
    // si la ligne existe toujours (famille NON détruite entre-temps).
    if (record.revokedAt !== null) {
      const ageMs = Date.now() - record.revokedAt.getTime();
      if (ageMs > 10_000) {
        throw new UnauthorizedException('Invalid refresh token');
      }
      const reissued = await this.prisma.$transaction((tx) =>
        this.reissueInFamily(tx, user, record),
      );
      if (reissued === null) {
        throw new UnauthorizedException('Invalid refresh token');
      }
      await this.audit.record({
        actorId: user.id,
        actorEmail: user.email,
        action: 'auth.refresh.reuse',
        resourceType: 'user',
        resourceId: user.id,
        details: { reason: 'rotation-concurrente' },
      });
      return { accessToken: await this.signAccess(user), refreshToken: reissued };
    }

    // CAS de rotation + création du successeur dans UNE transaction : le verrou
    // de ligne sérialise logout/reset concurrents (cf. contrat ci-dessus).
    // Sortie : null = refus (famille détruite / révocation trop vieille),
    //          sinon { raw, reuse } avec reuse = fenêtre de rejeu 10 s.
    const outcome = await this.prisma.$transaction(
      async (tx): Promise<{ raw: string; reuse: boolean } | null> => {
        await this.lockAuthIdentity(tx, user.id); // barrière P1 : AVANT toute écriture
        const cas = await tx.refreshToken.updateMany({
          where: { id: record.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (cas.count !== 1) {
          // Course perdue : relire l'état RÉEL de la ligne (un logout/reset a
          // pu committer entre la lecture initiale et ce CAS).
          const row = await tx.refreshToken.findUnique({ where: { id: record.id } });
          if (!row) return null; // famille détruite → 401
          if (row.revokedAt === null || row.expiresAt < new Date()) return null;
          if (Date.now() - row.revokedAt.getTime() > 10_000) return null;
          const reissued = await this.reissueInFamily(tx, user, row);
          return reissued === null ? null : { raw: reissued, reuse: true };
        }
        const fresh = await this.createRefreshRow(tx, user.id, record.sessionId);
        return { raw: fresh, reuse: false };
      },
    );

    if (outcome === null) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (outcome.reuse) {
      await this.audit.record({
        actorId: user.id,
        actorEmail: user.email,
        action: 'auth.refresh.reuse',
        resourceType: 'user',
        resourceId: user.id,
        details: { reason: 'rotation-concurrente' },
      });
    } else {
      await this.audit.record({
        actorId: user.id,
        actorEmail: user.email,
        action: 'auth.refresh',
        resourceType: 'user',
        resourceId: user.id,
      });
    }
    return { accessToken: await this.signAccess(user), refreshToken: outcome.raw };
  }

  /**
   * Ré-émission dans la famille d'une ligne DÉJÀ révoquée (fenêtre de rejeu).
   * **Barrière P1** : le verrou User est pris ici aussi — une ré-émission est
   * une création de ligne comme la rotation, et doit s'exclure mutuellement
   * avec logout/reset/changePassword. Le `updateMany` no-op est ensuite un
   * **probe atomique** : count 0 = la ligne a été détruite (logout/reset
   * committé pendant la course) → null → 401, aucun token émis pour une
   * famille morte. (Si l'appelant détient déjà le verrou User — chemin CAS
   * perdu en tx — le re-`FOR UPDATE` est un no-op sur la même tx.)
   */
  private async reissueInFamily(
    tx: Prisma.TransactionClient,
    user: User,
    row: { id: string; sessionId: string; revokedAt: Date | null },
  ): Promise<string | null> {
    if (row.revokedAt === null) return null;
    await this.lockAuthIdentity(tx, user.id);
    const probe = await tx.refreshToken.updateMany({
      where: { id: row.id, sessionId: row.sessionId },
      data: { revokedAt: row.revokedAt }, // no-op : verrou + existence uniquement
    });
    if (probe.count !== 1) return null;
    return this.createRefreshRow(tx, user.id, row.sessionId);
  }

  /**
   * **Barrière transactionnelle commune (GO corr. finales P1).**
   * `SELECT … FOR UPDATE` sur la ligne `User` — identité durable présente pour
   * tous les flux (rotation, ré-émission, login, logout, changePassword,
   * resetPassword). Toute création ET toute destruction de lignes refresh passe
   * par ce verrou AVANT d'écrire : les opérations sont mutuellement exclusives,
   * l'ordre d'exécution n'a plus d'effet (les deux ordres convergent vers « aucune
   * survivante »), et un `DELETE` ne peut plus manquer un successeur inséré pendant
   * son propre fenêtrage (snapshot READ COMMITTED). Lock-order constant
   * `User` → `RefreshToken` : aucune inversion possible, pas de deadlock interne.
   */
  private async lockAuthIdentity(
    tx: Prisma.TransactionClient | PrismaService,
    userId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
  }

  /** Crée une ligne refresh (successeur de rotation OU nouveau login). */
  private async createRefreshRow(
    client: Prisma.TransactionClient | PrismaService,
    userId: string,
    sessionId?: string,
  ): Promise<string> {
    const raw = randomBytes(48).toString('base64url');
    const days = this.config.get<number>('refreshExpiresInDays') ?? 30;
    await client.refreshToken.create({
      data: {
        tokenHash: this.hashToken(raw),
        userId,
        sessionId, // undefined → nouvelle famille (login)
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      },
    });
    return raw;
  }

  /**
   * Déconnexion = **suppression de TOUTE la famille de session** (`sessionId` :
   * toutes les lignes, actives et en cours de rotation) — pas seulement le hash
   * présenté. La ligne absente fait échouer tout refresh concurrent, y compris
   * la fenêtre de rejeu (GO Q12 : le logout doit couper aussi les rotations de
   * la même session, jamais « déconnecter l'onglet 1 mais laisser l'onglet 2 »).
   * Idempotent.
   */
  async logout(refreshToken: string): Promise<void> {
    const hash = this.hashToken(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
    });
    if (record) {
      // Barrière P1 : la destruction de la famille partage le verrou User avec
      // les rotations — un successeur inséré AVANT ce lock est détruit ici, un
      // successeur tenté APRÈS ce lock verra la famille déjà vide (401).
      await this.prisma.$transaction(async (tx) => {
        await this.lockAuthIdentity(tx, record.userId);
        await tx.refreshToken.deleteMany({
          where: { userId: record.userId, sessionId: record.sessionId },
        });
      });
    } else {
      // Idempotent : ligne déjà détruite → no-op défensif sur le hash.
      await this.prisma.refreshToken.deleteMany({ where: { tokenHash: hash } });
    }
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

  /**
   * Self-service password change (re-verifies the current password).
   * GO Q12 : toute réussite **détruit TOUTES les lignes refresh de
   * l'utilisateur** (toutes familles, actives ET révoquées) — identique au
   * reset. Une ligne révoquée survivante resterait dans la fenêtre de rejeu et
   * ressusciterait une session. La session courante doit se reconnecter.
   */
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
    await this.prisma.$transaction(async (tx) => {
      await this.lockAuthIdentity(tx, userId); // barrière P1 : exclusivité avec rotation/login
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash },
      });
      // Toutes lignes, sans filtre revokedAt : pas de ligne survivante qui
      // puisse entrer dans la fenêtre de rejeu de refresh().
      await tx.refreshToken.deleteMany({
        where: { userId },
      });
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.password.change',
      resourceType: 'user',
      resourceId: user.id,
      details: { sessionsRevoked: true },
    });
    return { ok: true };
  }

  // ─────────────── Password recovery (GO socle, lot A1) ──────────────────────

  /** Reset-link TTL in minutes: default 30, clamped 5..1440. */
  private passwordResetTtlMinutes(): number {
    const raw = this.config.get<number>('passwordResetExpiresInMinutes') ?? 30;
    return Math.min(Math.max(raw, 5), 1440);
  }

  /**
   * Public "forgot password". ALWAYS answers { ok: true } — identical response
   * whether or not the account exists (no enumeration), never leaks via mail
   * failure either. When the account exists: one-time token (raw value only in
   * the email link, sha256 at rest like refresh tokens / invitations), previous
   * unused links superseded, best-effort email exactly like invitations
   * (ADR-022: a send failure only flips the audit detail). Nothing secret
   * (raw token, password) is ever journaled.
   */
  async requestPasswordReset(email: string, ip?: string): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      await this.audit.record({
        actorId: null,
        actorEmail: null,
        action: 'auth.password.reset_requested',
        resourceType: 'user',
        details: { email, found: false, ip: ip ?? null },
      });
      return { ok: true };
    }

    const ttlMinutes = this.passwordResetTtlMinutes();
    const token = randomBytes(32).toString('base64url');
    // Supersede every still-unused link of this account (single active link).
    await this.prisma.passwordResetToken.deleteMany({
      where: { userId: user.id, usedAt: null },
    });
    await this.prisma.passwordResetToken.create({
      data: {
        tokenHash: this.hashToken(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
      },
    });

    let emailSent = false;
    try {
      if (await this.mailSettings.isEnabled()) {
        const base = (
          this.config.get<string>('publicBaseUrl') ?? 'http://localhost:3000'
        ).replace(/\/+$/, '');
        const link = `${base}/auth/reset?token=${encodeURIComponent(token)}`;
        await this.mailSettings.sendPlain({
          to: user.email,
          subject: 'Réinitialisation de votre mot de passe - Code Diali',
          text: [
            'Bonjour,',
            '',
            'Une réinitialisation de mot de passe a été demandée pour votre compte Code Diali.',
            '',
            'Pour choisir un nouveau mot de passe, ouvrez ce lien :',
            link,
            '',
            `Ce lien est utilisable une seule fois et expire dans ${ttlMinutes} minutes.`,
            "Si vous n'êtes pas à l'origine de cette demande, ignorez cet email : votre mot de passe reste inchangé.",
          ].join('\n'),
        });
        emailSent = true;
      }
    } catch {
      emailSent = false; // best-effort: the response never changes (anti-enum)
    }

    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.password.reset_requested',
      resourceType: 'user',
      resourceId: user.id,
      details: { emailSent, ttlMinutes, ip: ip ?? null },
    });
    return { ok: true };
  }

  /**
   * Consume the one-time reset token. Unknown / already-used / expired all
   * yield the SAME generic 400 (no oracle for token guessing). The password
   * length is checked BEFORE any database write (bcrypt first), then — GO Q3 —
   * **expiration AND single-use are re-verified INSIDE the transaction** by a
   * conditional update (`usedAt: null` + `expiresAt > now` + `tokenHash`): two
   * CONCURRENT consumptions of the same token can only have `count === 1`
   * once, the loser rolls back with the generic 400 (single-use enforced by
   * PostgreSQL, not by a pre-read). Password update + DESTRUCTION of every
   * refresh row of the user happen in the same transaction — **all rows,
   * active AND revoked** (GO Q12): a revoked line survives a `revokedAt: null`
   * filter, stays inside the 10 s reuse window and would resurrect the session.
   * Deletion, not revocation — a deleted row can never enter that window.
   * Journals auth.password.reset — never the raw token nor the password.
   */
  async resetPassword(token: string, newPassword: string, ip?: string): Promise<{ ok: true }> {
    if (newPassword.length < 8) {
      throw new BadRequestException('Le nouveau mot de passe doit faire au moins 8 caractères.');
    }
    const invalid = 'Lien de réinitialisation invalide ou expiré.';
    const tokenHash = this.hashToken(token);
    // Lecture préalable UNIQUEMENT pour le message générique — aucune décision
    // de validité ici : expiration et usage unique sont tranchés dans la tx.
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });
    if (!record) {
      throw new BadRequestException(invalid);
    }
    const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
    if (!user) {
      throw new BadRequestException(invalid);
    }

    const passwordHash = await bcrypt.hash(newPassword, 10); // hors tx (bcrypt ~100 ms)
    const consumed = await this.prisma.$transaction(async (tx) => {
      await this.lockAuthIdentity(tx, user.id); // barrière P1 : exclusivité avec rotation/login
      // CAS conditionnel : expiration + usage unique VÉRIFIÉS dans la
      // transaction. Deux appels concurrents sur le même jeton : un seul
      // obtient count === 1 ; l'autre ne modifie rien.
      const cas = await tx.passwordResetToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (cas.count !== 1) return false;
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      // Toutes lignes refresh de l'utilisateur (toutes familles, actives ET
      // révoquées) : aucune survivante pour la fenêtre de rejeu de refresh().
      await tx.refreshToken.deleteMany({
        where: { userId: user.id },
      });
      return true;
    });
    if (!consumed) {
      throw new BadRequestException(invalid);
    }
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.password.reset',
      resourceType: 'user',
      resourceId: user.id,
      details: { ip: ip ?? null },
    });
    return { ok: true };
  }

  // ─────── Email change (GO Q3) : vérification de la NOUVELLE adresse ────────

  /** Email-change TTL in minutes: default 30, clamped 5..1440 (same policy as reset). */
  private emailChangeTtlMinutes(): number {
    const raw = this.config.get<number>('emailChangeExpiresInMinutes') ?? 30;
    return Math.min(Math.max(raw, 5), 1440);
  }

  /**
   * Démarre le changement d'email : AUCUNE écriture immédiate sur User.email.
   * Pose un jeton unique (sha256 au repos, usage unique, TTL) envoyé À LA
   * NOUVELLE adresse — seul le détenteur de la boîte cible peut confirmer.
   * Les liens précédents du compte sont supprimés (un seul actif). L'unicité
   * de la cible est re-vérifiée à la confirmation sous contrainte (P2002).
   * Best-effort mail (réponse identique si SMTP tombe, trace à l'audit).
   */
  async requestEmailChange(
    user: { id: string; email: string },
    newEmail: string,
  ): Promise<{ pendingEmail: string; expiresAt: Date }> {
    const ttlMinutes = this.emailChangeTtlMinutes();
    const token = randomBytes(32).toString('base64url');
    await this.prisma.emailChangeToken.deleteMany({
      where: { userId: user.id, usedAt: null },
    });
    const row = await this.prisma.emailChangeToken.create({
      data: {
        tokenHash: this.hashToken(token),
        userId: user.id,
        newEmail,
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
      },
    });

    let emailSent = false;
    try {
      if (await this.mailSettings.isEnabled()) {
        const base = (
          this.config.get<string>('publicBaseUrl') ?? 'http://localhost:3000'
        ).replace(/\/+$/, '');
        const link = `${base}/auth/verifier-email?token=${encodeURIComponent(token)}`;
        await this.mailSettings.sendPlain({
          to: newEmail,
          subject: 'Confirmez votre nouvelle adresse email - Code Diali',
          text: [
            'Bonjour,',
            '',
            `Une demande de changement d'email a été faite pour votre compte Code Diali (actuellement : ${user.email}).`,
            '',
            'Pour confirmer cette NOUVELLE adresse, ouvrez ce lien :',
            link,
            '',
            `Ce lien est utilisable une seule fois et expire dans ${ttlMinutes} minutes.`,
            "Si vous n'êtes pas à l'origine de cette demande, ignorez cet email : votre adresse actuelle reste inchangée.",
          ].join('\n'),
        });
        emailSent = true;
      }
    } catch {
      emailSent = false; // best-effort : la réponse ne change jamais
    }

    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.email.change_requested',
      resourceType: 'user',
      resourceId: user.id,
      details: { newEmail, emailSent, ttlMinutes },
    });
    return { pendingEmail: newEmail, expiresAt: row.expiresAt };
  }

  /**
   * Consomme le jeton de vérification : **usage unique + expiration revérifiés
   * dans la transaction** (CAS conditionnel, même contrat que le reset — deux
   * confirmations concurrentes = UNE SEULE réussit) puis bascule User.email
   * dans la MÊME transaction sous contrainte d'unicité (P2002 → 409, tx
   * annulée : le jeton n'est pas consommé pour autant, la cible reste prise).
   * Journals auth.email.change_confirmed — jamais le jeton brut.
   */
  async confirmEmailChange(token: string): Promise<{ ok: true; email: string }> {
    const invalid = 'Lien de vérification invalide ou expiré.';
    const tokenHash = this.hashToken(token);
    const record = await this.prisma.emailChangeToken.findUnique({ where: { tokenHash } });
    if (!record) {
      throw new BadRequestException(invalid);
    }

    let updated: { email: string } | null = null;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        const cas = await tx.emailChangeToken.updateMany({
          where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (cas.count !== 1) return null;
        // Unicité revérifiée SOUS contrainte : un email pris entre la demande
        // et la confirmation lève P2002 → rollback de toute la transaction.
        const user = await tx.user.update({
          where: { id: record.userId },
          data: { email: record.newEmail },
        });
        return { email: user.email };
      });
    } catch (e) {
      if (
        e instanceof Error &&
        (e as { code?: string }).code === 'P2002'
      ) {
        throw new ConflictException('Un compte existe déjà avec cet email.');
      }
      throw e;
    }
    if (!updated) {
      throw new BadRequestException(invalid);
    }

    await this.audit.record({
      actorId: record.userId,
      actorEmail: updated.email,
      action: 'auth.email.change_confirmed',
      resourceType: 'user',
      resourceId: record.userId,
      details: { newEmail: updated.email },
    });
    return { ok: true, email: updated.email };
  }

  /** Enroll-token TTL (seconds), default 900s, clamped 300..3600. */
  private mfaEnrollTtlSeconds(): number {
    const raw = this.config.get<number>('mfaOtpTtlSeconds') ?? 300;
    return Math.min(Math.max(raw * 3, 300), 3600);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Issue a token pair. With an `imp` marker, NO refresh row is created and
   * refreshToken is returned empty (the controller must not set a cookie).
   *
   * **Access token = stateless JWT (GO Q3, portées clarifiées GO Q12)** : payload
   * `sub/email/role` figé à l'émission, vérifié par signature + `exp` UNIQUEMENT
   * (aucun appel base dans JwtAuthGuard) ; conséquences :
   *  - logout et désactivation admin ne révoquent PAS un bearer déjà émis —
   *    il expire tout seul après `jwtExpiresIn` (défaut 15 min) : garantie de
   *    DURÉE résiduelle, PAS une révocation forte ;
   *  - l'claim `email` peut être périmé (changement d'email confirmé entre-temps)
   *    — toute propriété de ressource doit se fier à `sub` (jamais à l'email) ;
   *  - le refresh token (ligne en base, famille `sessionId`) est le SEUL point
   *    de révocation serveur forte (logout/reset/changePassword).
   */
  async issueTokens(user: User): Promise<AuthTokens> {
    const accessToken = await this.signAccess(user);
    // Barrière P1 : la création d'une famille (login) partage le verrou User
    // avec les révocations — un reset/logout concurrent ne peut plus la manquer.
    const refreshToken = await this.prisma.$transaction(async (tx) => {
      await this.lockAuthIdentity(tx, user.id);
      return this.createRefreshRow(tx, user.id);
    });
    return { accessToken, refreshToken };
  }

  private async signAccess(user: User): Promise<string> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    return this.jwt.signAsync(payload);
  }
}