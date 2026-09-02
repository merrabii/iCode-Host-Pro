import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SaRateLimiter, RATE, rateKey } from '../auth/rate-limiter';
import { TurnstileService } from '../auth/turnstile.service';
import { JwtPayload } from '../auth/types';
import { SecuritySettingsService } from '../auth/security/security-settings.service';
import { SupportAccessDto } from './dto/support-access.dto';
import { SupportCodesService } from './support-codes.service';

type SupportRequest = Request & { ip?: string };

/**
 * Phase 10 (ADR-027):
 * - Client side (/api/client/support-code): generate / status / revoke the
 *   6-digit access code. `@Roles(Role.USER)` is the whole authenticated base —
 *   the rank semantics make it a no-op filter, which is what we want (any
 *   account may request support).
 * - Support side (/api/support/access): L2+ redeems a code → read-only
 *   impersonation (Turnstile + per-IP throttle when enabled).
 */
@ApiTags('support')
@Controller()
export class SupportCodesController {
  constructor(
    private readonly codes: SupportCodesService,
    private readonly limiter: SaRateLimiter,
    private readonly turnstile: TurnstileService,
    private readonly settings: SecuritySettingsService,
  ) {}

  // ── Client: generate / status / revoke ──────────────────────────────────────

  @Post('client/support-code')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.USER)
  @ApiOperation({ summary: 'Generate a 6-digit support access code (shown once)' })
  generate(@CurrentUser() user: JwtPayload) {
    return this.codes.generate(user);
  }

  @Get('client/support-code')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.USER)
  @ApiOperation({ summary: 'Active support-code status (never the code itself)' })
  status(@CurrentUser() user: JwtPayload) {
    return this.codes.status(user.sub);
  }

  @Delete('client/support-code')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.USER)
  @ApiOperation({ summary: 'Revoke the active support code' })
  revoke(@CurrentUser() user: JwtPayload) {
    return this.codes.revoke(user);
  }

  // ── Support: redeem (L2+) ───────────────────────────────────────────────────

  @Post('support/access')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPPORT_L2)
  @ApiOperation({ summary: 'Redeem a client code — open read-only impersonation (L2+)' })
  async redeem(
    @Body() dto: SupportAccessDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: SupportRequest,
  ) {
    const rl = this.limiter.consume(
      rateKey(req.ip, 'support-redeem'),
      RATE.supportRedeem.limit,
      RATE.supportRedeem.windowMs,
    );
    if (!rl.allowed) {
      throw new HttpException(
        `Trop de tentatives. Réessayez dans ${Math.ceil(rl.retryAfterMs / 1000)} s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (await this.settings.isTurnstileEnabled()) {
      const ok = await this.turnstile.verify(dto.turnstileToken ?? '', req.ip);
      if (!ok) {
        throw new HttpException(
          'Vérification anti-robot échouée.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    return this.codes.redeem(dto.code, { sub: user.sub, email: user.email });
  }
}
