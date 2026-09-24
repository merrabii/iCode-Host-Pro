import { Body, Controller, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Role } from '@prisma/client';
import { ProvisioningService } from './provisioning.service';
import { OrderCancelService } from './order-cancel.service';
import { CancelProvisioningDto } from './dto/cancel-provisioning.dto';
import { TerminateActiveServiceDto } from './dto/terminate-active-service.dto';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';

interface AdminActor {
  sub: string;
  email: string;
}

/**
 * ADMIN — relance du provisioning d'une commande (retry idempotent),
 * ré-synchronisation des limites (Bloc 2), annulation idempotente d'un
 * provisioning incomplet (17B.4E-D-B1) et terminaison idempotente d'un
 * service actif (17B.4E-E2-B). La commande reste côté store
 * (ressource Order), d'où ce contrôleur store/admin.
 */
@ApiTags('store/provisioning')
@Controller('store/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class StoreProvisioningAdminController {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly orderCancel: OrderCancelService,
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
   * 17B.4E-D-B1 — annulation générique d'un provisioning incomplet.
   * Gate : Order PROVISIONING (cancel) ou CANCELLED (rejeu idempotent) ;
   * tous les autres statuts → 409. Invoice PAID jamais modifiée (left_paid).
   */
  @Post('orders/:id/cancel-provisioning')
  @ApiOperation({
    summary: 'Annuler un provisioning incomplet (rollback idempotent)',
  })
  async cancelProvisioning(
    @Param('id') id: string,
    @Body() dto: CancelProvisioningDto,
    @CurrentUser() actor: AdminActor,
  ) {
    return this.orderCancel.cancelProvisioning(id, dto.reason, actor);
  }

  /**
   * 17B.4E-E2-B — terminaison idempotente d'un service DÉJÀ ACTIVÉ.
   * Gate : Order ACTIVE (1re terminaison) ou CANCELLED (rejeu idempotent) ;
   * PROVISIONING → 409 (utiliser cancel-provisioning) ; autres → 409.
   * Invoice PAID jamais modifiée ; projet Coolify/ClientProject conservé.
   */
  @Post('orders/:id/terminate')
  @ApiOperation({
    summary: 'Terminer un service actif (rollback idempotent, sans projet)',
  })
  async terminateActiveService(
    @Param('id') id: string,
    @Body() dto: TerminateActiveServiceDto,
    @CurrentUser() actor: AdminActor,
  ) {
    return this.orderCancel.terminateActiveService(id, dto.reason, actor);
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
