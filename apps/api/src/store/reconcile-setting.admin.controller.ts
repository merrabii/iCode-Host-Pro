import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtPayload } from '../auth/types';
import { UpdateReconcileSettingDto } from './dto/update-reconcile-setting.dto';
import {
  ReconcileSettingsService,
  ReconcileSettingsView,
} from './reconcile-settings.service';

// 17B.4C1 — réglages de réconciliation : persistance_POSTGRES + API admin.
// STRICTEMENT ADMIN (JwtAuthGuard + RolesGuard + Roles(ADMIN), mêmes guards que
// ./admin/security). Aucun endpoint public d'écriture, aucun secret exposé.
// Lire/modifier `enabled` ici ne démarre AUCUN worker (activation 17B.4C2).
@ApiTags('admin/reconcile')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/reconcile')
export class ReconcileSettingAdminController {
  constructor(private readonly settings: ReconcileSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Read reconciliation settings — overrides + effective + sources — ADMIN' })
  get(): Promise<ReconcileSettingsView> {
    return this.settings.getView();
  }

  @Patch()
  @ApiOperation({
    summary: 'Update reconciliation overrides (PATCH semantics, null = clear override) — ADMIN',
  })
  update(
    @Body() dto: UpdateReconcileSettingDto,
    @CurrentUser() actor: JwtPayload,
  ): Promise<ReconcileSettingsView> {
    return this.settings.update(dto, { sub: actor.sub, email: actor.email });
  }

  @Post('reset')
  @ApiOperation({ summary: 'Reset reconciliation overrides to env/defaults (idempotent) — ADMIN' })
  reset(@CurrentUser() actor: JwtPayload): Promise<ReconcileSettingsView> {
    return this.settings.reset({ sub: actor.sub, email: actor.email });
  }
}