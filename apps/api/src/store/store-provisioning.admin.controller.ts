import { Controller, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { ProvisioningService } from './provisioning.service';

/**
 * ADMIN — relance du provisioning d'une commande (retry idempotent).
 * La commande reste côté store (ressource Order), d'où ce contrôleur store/admin.
 */
@ApiTags('store/provisioning')
@Controller('store/admin/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class StoreProvisioningAdminController {
  constructor(private readonly provisioning: ProvisioningService) {}

  @Post(':id/provision')
  @ApiOperation({ summary: 'Relancer le provisioning d’une commande (force si besoin)' })
  async provision(
    @Param('id') id: string,
    @Query('force') force?: string,
  ) {
    return this.provisioning.provisionOrder(id, {
      force: force === '1' || force === 'true',
    });
  }
}
