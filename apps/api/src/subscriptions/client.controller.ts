import {
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/types';
import { SubscriptionsService } from './subscriptions.service';

// Phase 5 (ADR-021): client workspace — any authenticated user, ownership
// enforced in the service layer (another user's resource id → 404).
//
// Bloc 2 — Modèle d'abonnement order-driven : la création ET l'upgrade d'un
// abonnement ne se font PLUS ici. Toute souscription passe par la procédure
// de commande (POST /api/store/checkout) ; le paiement vaut approbation et le
// checkout crée/upgrade l'abonnement ACTIVE. La lecture reste ici.
@ApiTags('client')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('client')
export class ClientController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get('subscriptions')
  @ApiOperation({ summary: 'List my subscriptions (USER)' })
  listMySubscriptions(@CurrentUser() actor: JwtPayload) {
    return this.subscriptions.listMySubscriptions(actor);
  }

  @Patch('subscriptions/:id/cancel')
  @ApiOperation({ summary: 'Cancel one of my subscriptions (USER)' })
  cancelMySubscription(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.subscriptions.cancelMySubscription(id, actor);
  }
}
