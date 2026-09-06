import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types';
import { DeploymentModulesService } from './deployment-modules.service';
import {
  CreateDeploymentModuleDto,
  UpdateDeploymentModuleDto,
} from './dto/upsert-deployment-module.dto';

// Phase 13 — modules/méthodes de déploiement gérés par l'admin (page Packs →
// « Configuration de déploiement »). Mutations ADMIN-only, lecture authentifiée.
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/deployment-modules')
export class DeploymentModulesController {
  constructor(private readonly modules: DeploymentModulesService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a deployment module (A/B…) — ADMIN' })
  create(@Body() dto: CreateDeploymentModuleDto, @CurrentUser() actor: JwtPayload) {
    return this.modules.create(dto, actor);
  }

  @Get()
  @ApiOperation({ summary: 'List deployment modules (any authenticated)' })
  findAll() {
    return this.modules.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one deployment module (any authenticated)' })
  findOne(@Param('id') id: string) {
    return this.modules.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a deployment module — ADMIN' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDeploymentModuleDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.modules.update(id, dto, actor);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete a deployment module — ADMIN' })
  remove(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.modules.remove(id, actor);
  }

  // Liste LIVE des projets Coolify du serveur du module (choix du projet partagé A).
  @Get(':id/projects')
  @ApiOperation({ summary: 'Live Coolify projects of a module’s server — ADMIN' })
  listProjects(@Param('id') id: string) {
    return this.modules.listProjects(id);
  }
}