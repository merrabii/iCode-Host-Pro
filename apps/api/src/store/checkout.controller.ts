import { Controller, Get, Ip, Param, Post, Body, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CheckoutService, CheckoutResult } from './checkout.service';
import { CheckoutDto } from './dto/checkout.dto';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { AuthedRequest } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

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
  ) {}

  @Post('checkout')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Commander (invité → compte créé ; membre → upgrade) — crée/upgrade commande + facture + abonnement',
  })
  async placeOrder(@Body() dto: CheckoutDto, @Ip() ip: string, @Req() req: AuthedRequest): Promise<CheckoutResult> {
    return this.checkout.checkoutGuest(dto, ip, req.user ?? null);
  }

  /** Statut public d'une commande (léger, sans état interne de provisioning). */
  @Get('orders/:id/status')
  @ApiOperation({ summary: 'Statut public d’une commande (orderId)' })
  async status(@Param('id') id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        invoice: { select: { number: true } },
        customerEmail: true,
        createdAt: true,
      },
    });
    if (!order) {
      return { found: false };
    }
    return {
      found: true,
      orderId: order.id,
      status: order.status,
      invoiceNumber: order.invoice?.number ?? null,
      customerEmail: order.customerEmail,
      createdAt: order.createdAt,
    };
  }
}
