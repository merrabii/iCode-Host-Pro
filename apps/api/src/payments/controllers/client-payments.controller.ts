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
import { CreateCardTopupDto } from '../dto/payments.dto';

/**
 * GO Stripe — espace CLIENT : recharge par carte (page hébergée du
 * prestataire) et consultation de l'état.
 *
 * ISOLATION : tout passe par le dossier du JWT (`ensureOwnedCustomer`) —
 * lecture d'un paiement d'un tiers = 404. Le navigateur déclenche seulement
 * des appels : montant, devise et confirmation restent côté serveur.
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
}
