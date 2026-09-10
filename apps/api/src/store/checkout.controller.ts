import { Controller, Get, Ip, Param, Post, Body } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CheckoutService, CheckoutResult } from './checkout.service';
import { CheckoutDto } from './dto/checkout.dto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PUBLIC — tunnel d'achat sans compte (Bloc C). Paiement simulé instantané :
 * aucune saisie de carte, aucun secret. La configuration + les montants sont
 * recalculés côté serveur (le client ne fie jamais le prix). Rate-limité (§7).
 */
@ApiTags('store/checkout')
@Controller('store')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('checkout')
  @ApiOperation({
    summary: 'Commander sans compte (paiement simulé) — crée compte + commande + facture',
  })
  async placeOrder(@Body() dto: CheckoutDto, @Ip() ip: string): Promise<CheckoutResult> {
    return this.checkout.checkoutGuest(dto, ip);
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
