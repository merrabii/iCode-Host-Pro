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
import { RefundKind, RefundStatus, Role } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtPayload } from '../../auth/types';
import { CreateRefundDto } from '../../store/dto/create-refund.dto';
import { RefundService, RefundView } from '../../store/refund.service';
import { CardRefundsService } from '../card-refunds.service';

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
 * Lot « paiement direct des commandes » — CE contrôleur est enregistré par le
 * module PAIEMENTS (et non le store) pour éviter tout cycle de modules :
 * la création reste portée par `RefundService` (verrous, plafonds, idempotence)
 * et l'ÉMISSION vers le prestataire par `CardRefundsService`. Orchestration :
 * une commande réglée PAR CARTE produit un remboursement rattaché à son
 * origine (`orderId` + `cardPaymentId`), puis est émis vers la carte —
 * ZÉRO mouvement de portefeuille.
 *
 * Lecture/écriture réservée ADMIN (JwtAuthGuard + RolesGuard).
 */
@ApiTags('store/admin/refunds')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('store/admin')
export class AdminRefundsController {
  constructor(
    private readonly refunds: RefundService,
    private readonly cards: CardRefundsService,
  ) {}

  @Post('orders/:id/refunds')
  @ApiOperation({
    summary: 'Créer un remboursement (ADMIN, Idempotency-Key requis)',
  })
  async create(
    @Param('id') id: string,
    @Body() dto: CreateRefundDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() actor: JwtPayload,
  ): Promise<RefundView> {
    const view = await this.refunds.createRefund(id, dto, idempotencyKey, actor);
    // Commande réglée par CARTE : l'intention est créée et rattachée à
    // l'origine — elle est ensuite ÉMISE vers le prestataire (hors
    // transaction, idempotente). Toute erreur d'émission laisse l'intention
    // PENDING ré-exploitable (`POST …/refunds/:id/retry`) : le statut réel
    // est renvoyé, jamais un succès déclaré à tort.
    if (
      view.cardPaymentId &&
      view.kind === RefundKind.EXTERNAL_CARD &&
      view.status === RefundStatus.PENDING &&
      !view.providerRef
    ) {
      try {
        await this.cards.retryProviderCall(view.id, actor);
      } catch {
        // Émission non conclue : l'intention reste PENDING ré-exploitable
        // (`POST …/refunds/:id/retry`) — aucun succès déclaré à tort.
      }
      return this.refunds.getRefund(view.id);
    }
    return view;
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
