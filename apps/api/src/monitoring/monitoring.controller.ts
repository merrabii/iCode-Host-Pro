import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { MonitoringService } from './monitoring.service';

@ApiTags('monitoring')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/monitoring')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get('projects')
  @ApiOperation({ summary: 'Consommation agrégée des projets Coolify clients (ADMIN)' })
  async getProjectsConsumption() {
    return this.monitoring.getProjectsConsumption();
  }
}