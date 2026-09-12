import { Controller, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { ProvisioningService } from './provisioning.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';

/**
 * ADMIN — relance du provisioning d'une commande (retry idempotent) et
 * ré-synchronisation des limites des apps déjà déployées (Bloc 2).
 * La commande reste côté store (ressource Order), d'où ce contrôleur store/admin.
 */
@ApiTags('store/provisioning')
@Controller('store/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class StoreProvisioningAdminController {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('orders/:id/provision')
  @ApiOperation({ summary: 'Relancer le provisioning d’une commande (force si besoin)' })
  async provision(
    @Param('id') id: string,
    @Query('force') force?: string,
  ) {
    return this.provisioning.provisionOrder(id, {
      force: force === '1' || force === 'true',
    });
  }

  /**
   * « Ré-synchroniser les ressources » — ré-applique les limites RAM/CPU du
   * pack courant aux apps DÉJÀ déployées de l'abonné (Bloc 2, Bloc 0 :
   * changer de pack sans recréer ni perdre de données). Best-effort par app,
   * jamais un redéploiement. Utilisé par l'admin quand un build a échoué
   * faute de ressources après un upgrade.
   */
  @Post('orders/:id/resync-limits')
  @ApiOperation({
    summary: 'Ré-synchroniser les limites des apps déployées (après upgrade)',
  })
  async resyncLimits(@Param('id') id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: { subscription: { select: { id: true } } },
    });
    if (!order?.subscription) {
      throw new NotFoundException(
        'Aucun abonnement lié à cette commande — la ré-synchronisation ne s’applique qu’aux upgrades.',
      );
    }
    return this.provisioning.syncAppLimits(order.subscription.id);
  }
}
