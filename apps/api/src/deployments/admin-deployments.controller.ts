import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DeploymentsService } from './deployments.service';

// Phase 17 (3c) — suivi admin des apps dont l'application des limites a échoué,
// et re-application manuelle (bouton). Best-effort côté client : l'app tourne même
// si les limites n'ont pas pu être posées ; cet écran permet de les repérer et de
// les re-poser sans redéploiement ni interruption du service client.
@ApiTags('admin deployments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/deployments')
export class AdminDeploymentsController {
  constructor(private readonly deployments: DeploymentsService) {}

  @Get('limits-issues')
  @ApiOperation({ summary: "Apps dont l'application des limites (RAM/CPU) a échoué (ADMIN)" })
  async limitsIssues(@Query('limit') limit?: string) {
    return this.deployments.listLimitsIssues(limit ? parseInt(limit, 10) : 200);
  }

  @Post(':id/reapply-limits')
  @ApiOperation({ summary: "Ré-appliquer manuellement les limites d'une app (ADMIN)" })
  async reapply(@Param('id') id: string) {
    return this.deployments.reapplyLimits(id);
  }
}