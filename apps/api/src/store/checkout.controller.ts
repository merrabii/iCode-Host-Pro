import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Ip,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IsIn } from 'class-validator';
import { CheckoutService, CheckoutResult } from './checkout.service';
import { CheckoutDto } from './dto/checkout.dto';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { AuthedRequest } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { rateKey, RATE, SaRateLimiter } from '../auth/rate-limiter';
import { SecuritySettingsService } from '../auth/security/security-settings.service';

/** Corps du simulateur de paiement (recette/tests — jamais la production). */
class SimulatePaymentDto {
  @IsIn(['success', 'decline', 'timeout'])
  outcome!: 'success' | 'decline' | 'timeout';
}

/**
 * PUBLIC — tunnel de commande UNIQUE (Bloc C + Bloc 2). AUCUN paiement
 * simulé implicite : la commande payante est créée `PENDING_PAYMENT` et
 * n'ouvre aucun droit avant confirmation serveur (admin sur virement,
 * simulateur explicitement activé en recette, règle commande gratuite).
 * Accepte à la fois le visiteur invité (aucun token → compte créé) et le
 * membre connecté (OptionalJwtAuthGuard → upgrade order-driven). Les montants
 * sont recalculés côté serveur (le client ne fie jamais le prix). Rate-limité.
 */
@ApiTags('store/checkout')
@Controller('store')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly prisma: PrismaService,
    private readonly limiter: SaRateLimiter,
    private readonly settings: SecuritySettingsService,
  ) {}

  @Post('checkout')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary:
      'Commander (invité → compte créé ; membre → upgrade) — commande en attente de règlement, droits après confirmation serveur',
  })
  async placeOrder(
    @Body() dto: CheckoutDto,
    @Ip() ip: string,
    @Req() req: AuthedRequest,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<CheckoutResult> {
    const rawKey = headers['idempotency-key'] ?? headers['Idempotency-Key'];
    return this.checkout.checkoutGuest(dto, ip, req.user ?? null, {
      idempotencyKey: rawKey ?? null,
    });
  }

  /**
   * Simulateur de paiement (RECETTE/TESTS) — refusé sans activation explicite
   * `PAYMENT_SIMULATOR_ENABLED=true` et TOUJOURS refusé en production
   * (`config/payment-simulator.ts`). Le `success` passe par la même
   * confirmation serveur qu'un règlement valide (aucun droit de court-circuit).
   */
  @Post('orders/:id/simulate-payment')
  @ApiOperation({ summary: 'Simulateur de paiement (recette/tests uniquement)' })
  async simulatePayment(
    @Param('id') id: string,
    @Body() body: SimulatePaymentDto,
    @Ip() ip: string,
  ) {
    const rl = this.limiter.consume(
      rateKey(ip, 'store-pay-sim'),
      RATE.checkoutIntent.limit,
      RATE.checkoutIntent.windowMs,
    );
    if (!rl.allowed) {
      throw new HttpException(
        `Trop de demandes. Réessayez dans ${Math.ceil(rl.retryAfterMs / 1000)} s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!body || typeof body.outcome !== 'string') {
      throw new BadRequestException('outcome requis (success | decline | timeout).');
    }
    return this.checkout.simulatePaymentOutcome(id, body.outcome);
  }

  /** Statut public d'une commande (suivi invité par orderId, délibérément
   *  minimal) : AUCUNE donnée personnelle (jamais customerEmail, ni numéro de
   *  facture, ni dates — quiconque détient l'orderId ne doit rien apprendre
   *  d'autre que l'état). Rate-limit IP administrable (/manager/securite,
   *  défaut 30 requêtes / 60 s) ; enabled=false → le limiteur n'est pas appelé.
   *  Dépassement → HTTP 429 + Retry-After (secondes). */
  @Get('orders/:id/status')
  @ApiOperation({ summary: 'Statut public d’une commande (orderId) — minimal, sans PII' })
  async status(
    @Param('id') id: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cfg = await this.settings.getOrderStatusRateLimit();
    if (cfg.enabled) {
      const rl = this.limiter.consume(rateKey(ip, 'store-order-status'), cfg.limit, cfg.windowMs);
      if (!rl.allowed) {
        const retryAfterSec = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(retryAfterSec));
        throw new HttpException(
          `Trop de demandes. Réessayez dans ${retryAfterSec} s.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!order) {
      return { found: false };
    }
    return { found: true, status: order.status };
  }
}
