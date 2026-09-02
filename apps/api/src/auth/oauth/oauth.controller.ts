import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { AuditService } from '../../audit/audit.service';
import { CryptoService } from '../../crypto/crypto.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { JwtPayload } from '../types';
import { AuthCookiesService } from '../auth-cookies.service';
import { AuthService } from '../auth.service';
import { CheckoutService } from '../checkout.service';
import { MfaService } from '../mfa/mfa.service';
import { SecuritySettingsService } from '../security/security-settings.service';
import { OauthUnlinkDto } from '../dto/oauth-unlink.dto';
import { OAuthProvider, OAuthMode } from './oauth-provider.client';
import { OAuthService } from './oauth.service';

type OAuthRequest = Request & { cookies?: Record<string, string>; ip?: string };

interface StatePayload {
  state: string;
  mode: OAuthMode;
  /** Present only in link mode — the account the identity is attached to. */
  sub?: string;
  exp: number;
}

const OAUTH_STATE_TTL_SECONDS = 600;

/**
 * Phase 10 (ADR-027): OAuth Google/GitHub — three scenarios resolved on the
 * callback: LOGIN (existing account), order-time REGISTER (only with a valid
 * checkout intent cookie), and LINK (authenticated `mode=link`, attaches the
 * identity to the current account). CSRF state is a signed httpOnly cookie
 * compared timing-safe against the `state` query param.
 */
@ApiTags('auth/oauth')
@Controller('auth/oauth')
export class OAuthController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly checkout: CheckoutService,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly cookies: AuthCookiesService,
    private readonly settings: SecuritySettingsService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  private webBaseUrl(): string {
    return (this.config.get<string>('publicBaseUrl') ?? 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
  }

  private oauthTtlSeconds(): number {
    const raw = this.config.get<number>('oauthStateTtlSeconds') ?? OAUTH_STATE_TTL_SECONDS;
    return Math.min(Math.max(raw, 60), 3600);
  }

  private mfaChallengeTtlSeconds(): number {
    const raw = this.config.get<number>('mfaOtpTtlSeconds') ?? 300;
    return Math.min(Math.max(raw, 60), 1800);
  }

  private isProvider(value: string): value is OAuthProvider {
    return value === 'google' || value === 'github';
  }

  // ── Authorize entry points ──────────────────────────────────────────────────

  @Get(':provider')
  @ApiOperation({ summary: 'Start OAuth login (public) — redirects to the provider' })
  async authorize(
    @Param('provider') provider: string,
    @Res() res: Response,
  ) {
    if (!this.isProvider(provider)) throw new BadRequestException('Fournisseur inconnu.');
    if (!(await this.oauth.isEnabled(provider))) {
      throw new ForbiddenException('Fournisseur OAuth désactivé.');
    }
    await this.redirectToProvider(res, provider, 'login');
  }

  @Get('link/:provider')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Start OAuth linking (authenticated) — redirects to the provider' })
  async link(
    @Param('provider') provider: string,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    if (!this.isProvider(provider)) throw new BadRequestException('Fournisseur inconnu.');
    if (!(await this.oauth.isEnabled(provider))) {
      throw new ForbiddenException('Fournisseur OAuth désactivé.');
    }
    if (user.imp) {
      throw new ForbiddenException('Liaison impossible en session d’impersonation.');
    }
    await this.redirectToProvider(res, provider, 'link', user.sub);
  }

  @Post('unlink')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Detach a linked OAuth provider from the account (self-service)' })
  async unlink(
    @Body() dto: OauthUnlinkDto,
    @CurrentUser() user: JwtPayload,
  ) {
    if (user.imp) {
      throw new ForbiddenException('Déliaison impossible en session d’impersonation.');
    }
    return this.oauth.unlink(user.sub, dto.provider, { sub: user.sub, email: user.email });
  }

  private async redirectToProvider(
    res: Response,
    provider: OAuthProvider,
    mode: OAuthMode,
    sub?: string,
  ): Promise<void> {
    const ttl = this.oauthTtlSeconds();
    const state = randomBytes(24).toString('base64url');
    const token = await this.jwt.signAsync(
      { state, mode, sub } as StatePayload,
      { expiresIn: ttl },
    );
    this.cookies.setOauthState(res, token, ttl);
    res.redirect(this.oauth.getAuthorizeUrl(provider, state, mode));
  }

  // ── Callback ────────────────────────────────────────────────────────────────

  @Get(':provider/callback')
  @ApiOperation({ summary: 'OAuth callback — exchanges the code and resolves the session' })
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: OAuthRequest,
    @Res() res: Response,
  ) {
    if (!this.isProvider(provider)) throw new BadRequestException('Fournisseur inconnu.');
    if (!code || !state) {
      return res.redirect(this.webBaseUrl() + '/auth?error=oauth_missing_params');
    }
    const cookieToken = req.cookies?.[this.cookies.oauthStateName];
    if (!cookieToken) {
      return res.redirect(this.webBaseUrl() + '/auth?error=oauth_no_state');
    }
    let payload: StatePayload;
    try {
      payload = await this.jwt.verifyAsync<StatePayload>(cookieToken);
    } catch {
      return res.redirect(this.webBaseUrl() + '/auth?error=oauth_bad_state');
    }
    if (
      payload.exp < Math.floor(Date.now() / 1000) ||
      !this.constantTimeEqual(payload.state, state)
    ) {
      return res.redirect(this.webBaseUrl() + '/auth?error=oauth_state_mismatch');
    }

    let profile;
    try {
      profile = await this.oauth.resolve(provider, code);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return res.redirect(
        this.webBaseUrl() + `/auth?error=oauth_exchange&detail=${encodeURIComponent(msg)}`,
      );
    }
    if (!profile.emailVerified) {
      return res.redirect(this.webBaseUrl() + '/auth?error=oauth_unverified_email');
    }

    if (payload.mode === 'link' && payload.sub) {
      return this.handleLink(res, provider, payload.sub, profile);
    }
    return this.handleLoginOrRegister(res, req, provider, profile);
  }

  // ── Scenario: link to an existing authenticated account ─────────────────────

  private async handleLink(
    res: Response,
    provider: OAuthProvider,
    sub: string,
    profile: { email: string; accessToken: string },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: sub } });
    if (!user) return res.redirect(this.webBaseUrl() + '/auth?error=oauth_no_user');
    const taken = await this.prisma.user.findFirst({
      where: { oauthProvider: provider, oauthSubject: profile.email },
    });
    if (taken && taken.id !== sub) {
      return res.redirect(this.webBaseUrl() + '/profil?link=conflict');
    }
    await this.prisma.user.update({
      where: { id: sub },
      data: {
        oauthProvider: provider,
        oauthSubject: profile.email,
        ...(provider === 'github'
          ? { githubTokenEnc: this.crypto.encrypt(profile.accessToken) }
          : {}),
      },
    });
    await this.auditOauth(user, 'oauth.link', provider);
    return res.redirect(this.webBaseUrl() + `/profil?linked=${provider}`);
  }

  // ── Scenarios: login (existing) or order-time register (checkout intent) ─────

  private async handleLoginOrRegister(
    res: Response,
    req: OAuthRequest,
    provider: OAuthProvider,
    profile: { email: string; accessToken: string },
  ) {
    const existing = await this.prisma.user.findUnique({ where: { email: profile.email } });
    if (!existing) {
      // No account: creation is allowed ONLY during an order (checkout intent).
      const checkoutProductId = await this.checkout.readProductId(
        req.cookies?.[this.cookies.checkoutName],
      );
      if (!checkoutProductId) {
        return res.redirect(this.webBaseUrl() + '/auth?error=oauth_unknown_account');
      }
      if (!(await this.settings.isSelfRegistrationEnabled())) {
        return res.redirect(this.webBaseUrl() + '/auth?error=registration_disabled');
      }
      const user = await this.auth.createOrderAccount({
        email: profile.email,
        name: null,
        oauthProvider: provider,
        oauthSubject: profile.email,
        ...(provider === 'github'
          ? { githubTokenEnc: this.crypto.encrypt(profile.accessToken) }
          : {}),
        productId: checkoutProductId,
      });
      await this.auditOauth(user, 'oauth.register', provider);
      this.cookies.clearCheckout(res);
      const tokens = await this.auth.issueTokens(user);
      this.cookies.setRefresh(res, tokens.refreshToken);
      return res.redirect(this.webBaseUrl() + `/client?registered=${provider}`);
    }

    if (!existing.isActive) {
      return res.redirect(this.webBaseUrl() + '/auth?error=account_disabled');
    }
    const outcome = await this.mfa.evaluateLogin(existing);
    if (outcome.status === 'verify') {
      this.cookies.setMfaChallenge(res, outcome.challengeId, this.mfaChallengeTtlSeconds());
      return res.redirect(this.webBaseUrl() + '/auth?oauth=mfa');
    }
    if (outcome.status === 'enroll') {
      return res.redirect(this.webBaseUrl() + '/auth?oauth=enroll');
    }
    await this.auditOauth(existing, 'oauth.login', provider);
    const tokens = await this.auth.issueTokens(existing);
    this.cookies.setRefresh(res, tokens.refreshToken);
    return res.redirect(this.webBaseUrl() + '/client?oauth=ok');
  }

  // ── Audit helper ────────────────────────────────────────────────────────────

  private auditOauth(
    user: { id: string; email: string },
    action: string,
    provider: OAuthProvider,
  ): Promise<unknown> {
    return this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action,
      resourceType: 'user',
      resourceId: user.id,
      details: { provider },
    });
  }

  private constantTimeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }
}
