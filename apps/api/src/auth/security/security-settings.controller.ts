import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { JwtPayload } from '../types';
import { UpdateSecuritySettingsDto } from './dto/update-security-settings.dto';
import { SecuritySettingsService, SecuritySettingsView } from './security-settings.service';

// Phase 10 (ADR-027): security feature-flags are ADMIN-only. Every option is
// NON-mandatory; the admin strengthens or relaxes security here. Applies live.
@ApiTags('admin/security')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/security')
export class SecuritySettingsController {
  constructor(private readonly settings: SecuritySettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Read security feature-flags — ADMIN' })
  get(): Promise<SecuritySettingsView> {
    return this.settings.get();
  }

  @Put()
  @ApiOperation({ summary: 'Update security feature-flags (PATCH semantics) — ADMIN' })
  update(
    @Body() dto: UpdateSecuritySettingsDto,
    @CurrentUser() actor: JwtPayload,
  ): Promise<SecuritySettingsView> {
    return this.settings.update(dto, { sub: actor.sub, email: actor.email });
  }
}