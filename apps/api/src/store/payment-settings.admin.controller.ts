import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types';
import {
  PaymentSettingsService,
  UpdatePaymentSettingsDto,
} from './payment-settings.service';

/**
 * ADMIN — réglages des PARCOURS de paiement (PaymentSettings, singleton).
 *
 * Lecture + écriture strictement ADMIN, en base (aucune édition de fichier
 * d'environnement). Chaque écriture est audité côté service avec l'ancienne et
 * la nouvelle valeur ; aucun secret n'est stocké ni exposé ici.
 */
@ApiTags('store/payment-settings (admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('store/admin/payment-settings')
export class PaymentSettingsAdminController {
  constructor(private readonly settings: PaymentSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Réglages des parcours de paiement (ADMIN)' })
  async get() {
    return this.settings.capabilities();
  }

  @Patch()
  @ApiOperation({
    summary: 'Activer/désactiver un parcours de paiement (ADMIN)',
  })
  async update(
    @Body() dto: UpdatePaymentSettingsDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.settings.update(dto, actor);
  }
}
