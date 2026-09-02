import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthCookiesService } from '../auth-cookies.service';
import { AuthService } from '../auth.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { MfaEnrollOrSessionGuard } from '../guards/mfa-enroll-or-session.guard';
import { JwtPayload } from '../types';
import { SaRateLimiter, RATE, rateKey } from '../rate-limiter';
import { MfaConfirmDto } from '../dto/mfa-confirm.dto';
import { MfaDisableDto } from '../dto/mfa-disable.dto';
import { MfaEmailSendDto } from '../dto/mfa-email-send.dto';
import { MfaSetupDto } from '../dto/mfa-setup.dto';
import { MfaVerifyDto } from '../dto/mfa-verify.dto';
import { MfaService } from './mfa.service';

type MfaRequest = Request & { ip?: string };

/**
 * Phase 10 (ADR-027): MFA two-factor — self-service enrollment (setup/confirm/
 * disable, requires the bearer token) + the public two-step verification used
 * after login when the account has MFA enabled. Both public endpoints are
 * rate-limited per IP; verification is single-use and attempts-capped.
 */
@ApiTags('auth/mfa')
@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly cookies: AuthCookiesService,
    private readonly limiter: SaRateLimiter,
  ) {}

  // ── Self-service enrollment (authenticated) ─────────────────────────────────

  @Post('setup')
  @ApiBearerAuth()
  @UseGuards(MfaEnrollOrSessionGuard)
  @ApiOperation({ summary: 'Start TOTP enrollment — returns secret + otpauth URI (once)' })
  setup(@CurrentUser() user: JwtPayload, @Body() dto: MfaSetupDto) {
    return this.mfa.setupTOTP(user.sub, dto.password);
  }

  @Post('confirm')
  @ApiBearerAuth()
  @UseGuards(MfaEnrollOrSessionGuard)
  @ApiOperation({ summary: 'Confirm a pending TOTP enrollment with a first code' })
  confirm(@CurrentUser() user: JwtPayload, @Body() dto: MfaConfirmDto) {
    return this.mfa.confirmTOTP(user.sub, dto.code);
  }

  @Post('disable')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Disable MFA (password + current TOTP code)' })
  disable(@CurrentUser() user: JwtPayload, @Body() dto: MfaDisableDto) {
    return this.mfa.disable(user.sub, dto.password, dto.code);
  }

  // ── Two-step verification (public, after password/OAuth) ────────────────────

  @Post('verify')
  @ApiOperation({ summary: 'Complete login with the MFA code — returns tokens' })
  async verify(
    @Body() dto: MfaVerifyDto,
    @Req() req: MfaRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rl = this.limiter.consume(
      rateKey(req.ip, 'mfa-verify'),
      RATE.mfaVerify.limit,
      RATE.mfaVerify.windowMs,
    );
    if (!rl.allowed) {
      throw new HttpException(
        `Trop de tentatives. Réessayez dans ${Math.ceil(rl.retryAfterMs / 1000)} s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const user = await this.mfa.verify(dto.challengeId, dto.code, dto.method);
    const tokens = await this.auth.issueTokens(user);
    this.cookies.setRefresh(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Post('email/send')
  @ApiOperation({ summary: 'Send an email OTP for a pending challenge (best-effort)' })
  async sendEmailOtp(
    @Body() dto: MfaEmailSendDto,
    @Req() req: MfaRequest,
  ) {
    const rl = this.limiter.consume(
      rateKey(req.ip, 'mfa-email'),
      RATE.mfaEmailSend.limit,
      RATE.mfaEmailSend.windowMs,
    );
    if (!rl.allowed) {
      throw new HttpException(
        `Trop de demandes. Réessayez dans ${Math.ceil(rl.retryAfterMs / 1000)} s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.mfa.sendEmailOtp(dto.challengeId);
  }
}
