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
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types';
import { CreateRefundDto } from './dto/create-refund.dto';
import { RefundService } from './refund.service';

/**
 * ADMIN — remboursements et avoirs (GO item 9).
 *
 *  • `POST   /store/admin/orders/:id/refunds` : intention de remboursement.
 *    Header `Idempotency-Key` REQUIS (8..128) — même contrat que le checkout.
 *    Effets internes (wallet + avoir) exécutés dans la même transaction ;
 *    `EXTERNAL_CARD` reste PENDING sans jamais déclarer de succès.
 *  • `GET    /store/admin/orders/:id/refunds` : journal des remboursements
 *    d'une commande.
 *  • `GET    /store/admin/refunds/:id` : détail.
 *  • `POST   /store/admin/refunds/:id/provider-confirmation` : contrat du
 *    prestataire — adaptateur carte non configuré → refus 409 tracé
 *    (le choix du prestataire ne bloque QUE son adaptateur, jamais le wallet).
 *
 * Lecture/écriture réservée ADMIN (JwtAuthGuard + RolesGuard).
 */
@ApiTags('store/admin/refunds')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('store/admin')
export class AdminRefundsController {
  constructor(private readonly refunds: RefundService) {}

  @Post('orders/:id/refunds')
  @ApiOperation({
    summary: 'Créer un remboursement (ADMIN, Idempotency-Key requis)',
  })
  create(
    @Param('id') id: string,
    @Body() dto: CreateRefundDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.refunds.createRefund(id, dto, idempotencyKey, actor);
  }

  @Get('orders/:id/refunds')
  @ApiOperation({ summary: 'Remboursements d’une commande (ADMIN)' })
  list(@Param('id') id: string) {
    return this.refunds.listForOrder(id);
  }

  @Get('refunds/:id')
  @ApiOperation({ summary: 'Détail d’un remboursement (ADMIN)' })
  get(@Param('id') id: string) {
    return this.refunds.getRefund(id);
  }

  @Post('refunds/:id/provider-confirmation')
  @ApiOperation({
    summary:
      'Confirmation prestataire (carte réelle désactivée → refus 409 tracé)',
  })
  providerConfirmation(
    @Param('id') id: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.refunds.refuseProviderConfirmation(id, actor);
  }
}
