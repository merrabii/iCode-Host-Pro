import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ManagerService } from './manager.service';

// Phase 3: the /manager console aggregates platform-internal data (product /
// server / user counts). All of it is ADMIN-only — nothing here is exposed to
// regular clients.
@ApiTags('manager')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('manager')
export class ManagerController {
  constructor(private readonly manager: ManagerService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Platform dashboard summary (ADMIN)' })
  summary() {
    return this.manager.summary();
  }
}