import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtPayload } from '../../auth/types';
import { CardPaymentsService } from '../card-payments.service';
import { CreateCardTopupDto, CreateOrderCardPaymentDto } from '../dto/payments.dto';

/**
 * GO Stripe — espace CLIENT : recharge par carte (page hébergée du
 * prestataire) et consultation de l'état.
 *
 * ISOLATION : tout passe par le dossier du JWT (`ensureOwnedCustomer`) —
 * lecture d'un paiement d'un tiers = 404. Le navigateur déclenche seulement
 * des appels : montant, devise et confirmation restent côté serveur.
 *
 * Lot « paiement direct des commandes » — même isolation sur la COMMANDE
 * (proprieté exigée avant toute écriture) et mêmes règles que le portefeuille :
 * le serveur seul décide du montant, de la devise et du règlement.
 */
@ApiTags('client/payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('client/payments')
export class ClientPaymentsController {
  constructor(private readonly cards: CardPaymentsService) {}

  @Post('topups')
  @ApiOperation({ summary: 'Ouvrir une session de recharge par carte (client)' })
  async createTopup(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateCardTopupDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.cards.createTopup(user, dto, idempotencyKey);
  }

  @Get('topups')
  @ApiOperation({ summary: 'Mes paiements carte récents (client)' })
  async list(@CurrentUser() user: JwtPayload) {
    const items = await this.cards.listOwn(user);
    return { items, total: items.length };
  }

  @Get('topups/:reference')
  @ApiOperation({ summary: 'État d’une recharge par carte (client)' })
  async get(@Param('reference') reference: string, @CurrentUser() user: JwtPayload) {
    return this.cards.getOwn(reference, user);
  }

  @Post('topups/:reference/refresh')
  @ApiOperation({
    summary:
      'Rafraîchir l’état depuis le serveur après retour de la page hébergée (le serveur relit le prestataire)',
  })
  async refresh(@Param('reference') reference: string, @CurrentUser() user: JwtPayload) {
    return this.cards.refreshFromProvider(reference, user);
  }

  // ── lot « paiement direct des commandes » ──────────────────────────────

  @Post('orders/:orderId/card')
  @ApiOperation({ summary: 'Ouvrir une session pour régler une commande par carte (client)' })
  async createOrderPayment(
    @Param('orderId') orderId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateOrderCardPaymentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.cards.createOrderPayment(orderId, user, dto ?? {}, idempotencyKey);
  }

  @Get('orders/:orderId/card')
  @ApiOperation({ summary: 'Dernière tentative de règlement carte d’une commande (client)' })
  async getOrderPayment(
    @Param('orderId') orderId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.cards.getOrderPayment(orderId, user);
  }

  @Post('orders/:orderId/card/refresh')
  @ApiOperation({
    summary:
      'Relire le règlement d’une commande auprès du serveur après retour de la page hébergée',
  })
  async refreshOrderPayment(
    @Param('orderId') orderId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.cards.refreshOrderPayment(orderId, user);
  }
}
