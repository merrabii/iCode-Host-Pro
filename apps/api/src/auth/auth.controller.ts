import {
  Body,
  Controller,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { CheckoutService } from './checkout.service';
import { SaRateLimiter, RATE, rateKey } from './rate-limiter';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CurrentUser } from './decorators/current-user.decorator';
import { AllowImpersonationMutation } from './decorators/allow-impersonation.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtPayload } from './types';

const DEFAULT_COOKIE = 'ihp_refresh';
const CHECKOUT_COOKIE = 'ihp_checkout';

type CookieRequest = Request & { cookies?: Record<string, string>; ip?: string };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly cookieName: string;

  constructor(
    private readonly auth: AuthService,
    private readonly checkout: CheckoutService,
    private readonly config: ConfigService,
    private readonly limiter: SaRateLimiter,
  ) {
    this.cookieName = this.config.get<string>('cookieName') ?? DEFAULT_COOKIE;
  }

  @Post('register')
  @ApiOperation({ summary: 'Order-time account creation (requires a checkout intent)' })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: CookieRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rl = this.limiter.consume(
      rateKey(req.ip, 'register'),
      RATE.register.limit,
      RATE.register.windowMs,
    );
    if (!rl.allowed) {
      throw new UnauthorizedException(
        `Trop de tentatives. Réessayez dans ${Math.ceil(rl.retryAfterMs / 1000)} s.`,
      );
    }
    const productId = await this.checkout.readProductId(req.cookies?.[CHECKOUT_COOKIE]);
    const tokens = await this.auth.register(dto, productId);
    res.clearCookie(CHECKOUT_COOKIE, { httpOnly: true, path: '/' });
    this.setCookie(res, tokens);
    return { accessToken: tokens.accessToken };
  }

  @Post('accept-invite')
  @ApiOperation({ summary: 'Accept a one-time invitation and obtain tokens' })
  async acceptInvite(
    @Body() dto: AcceptInviteDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.acceptInvite(dto);
    this.setCookie(res, tokens);
    return { accessToken: tokens.accessToken };
  }

  @Post('login')
  @ApiOperation({ summary: 'Log in — may require an MFA step' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: CookieRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto, req.ip);
    if ('mfaRequired' in result) {
      if (result.mfaRequired) {
        return {
          mfaRequired: true,
          challengeId: result.challengeId,
          methods: result.methods,
        };
      }
      return { mfaRequired: false, enroll: true, enrollToken: result.enrollToken };
    }
    this.setCookie(res, result);
    return { accessToken: result.accessToken };
  }

  @Post('impersonate/return')
  @UseGuards(JwtAuthGuard)
  @AllowImpersonationMutation()
  @ApiOperation({ summary: 'End an impersonation session (cleanup + audit)' })
  async returnFromImpersonation(@CurrentUser() user: JwtPayload) {
    await this.auth.returnFromImpersonation(user);
    return { success: true };
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Self-service password change (re-verifies current password)' })
  async changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() user: JwtPayload) {
    if (user.imp) {
      throw new UnauthorizedException('Changement de mot de passe impossible en session d’impersonation.');
    }
    return this.auth.changePassword(user.sub, dto.currentPassword, dto.newPassword);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Rotate refresh token, return new access token' })
  async refresh(@Req() req: CookieRequest, @Res({ passthrough: true }) res: Response) {
    const token = this.readCookie(req);
    if (!token) {
      throw new UnauthorizedException('Missing refresh token');
    }
    const tokens = await this.auth.refresh(token);
    this.setCookie(res, tokens);
    return { accessToken: tokens.accessToken };
  }

  @Post('logout')
  @ApiOperation({ summary: 'Revoke the refresh token and clear the cookie' })
  async logout(@Req() req: CookieRequest, @Res({ passthrough: true }) res: Response) {
    const token = this.readCookie(req);
    if (token) {
      await this.auth.logout(token);
    }
    res.clearCookie(this.cookieName, { httpOnly: true, path: '/' });
    return { success: true };
  }

  private readCookie(req: CookieRequest): string | undefined {
    return req.cookies?.[this.cookieName];
  }

  private cookieOptions() {
    const days = this.config.get<number>('refreshExpiresInDays') ?? 30;
    const isProduction =
      (this.config.get<string>('nodeEnv') ?? 'development') === 'production';
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: isProduction,
      path: '/',
      maxAge: days * 24 * 60 * 60 * 1000,
    };
  }

  private setCookie(res: Response, tokens: { refreshToken: string }): void {
    if (tokens.refreshToken) {
      res.cookie(this.cookieName, tokens.refreshToken, this.cookieOptions());
    }
  }
}