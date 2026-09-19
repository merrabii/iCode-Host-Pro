import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Ip,
  Param,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CheckoutService, CheckoutResult } from './checkout.service';
import { CheckoutDto } from './dto/checkout.dto';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { AuthedRequest } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { rateKey, SaRateLimiter } from '../auth/rate-limiter';
import { SecuritySettingsService } from '../auth/security/security-settings.service';

/**
 * PUBLIC — tunnel de commande UNIQUE (Bloc C + Bloc 2). Paiement simulé
 * instantané : aucune saisie de carte, aucun secret. Accepte à la fois le
 * visiteur invité (aucun token → compte créé) et le membre connecté
 * (OptionalJwtAuthGuard → upgrade order-driven, compte et abonnement réutilisés,
 * données préservées). La configuration + les montants sont recalculés côté
 * serveur (le client ne fie jamais le prix). Rate-limité (§7).
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
    summary: 'Commander (invité → compte créé ; membre → upgrade) — crée/upgrade commande + facture + abonnement',
  })
  async placeOrder(@Body() dto: CheckoutDto, @Ip() ip: string, @Req() req: AuthedRequest): Promise<CheckoutResult> {
    return this.checkout.checkoutGuest(dto, ip, req.user ?? null);
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
