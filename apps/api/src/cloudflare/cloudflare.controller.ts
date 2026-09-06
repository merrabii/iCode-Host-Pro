import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DomainStatus, Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtPayload } from '../auth/types';
import {
  CheckSubdomainDto,
  CreateDnsRecordDto,
  RegisterDomainDto,
  SetRootDomainDto,
  UpdateCloudflareSettingsDto,
  UpdateDomainDto,
} from './dto/cloudflare.dto';
import { CloudflareService } from './cloudflare.service';

// Phase 3 — contrôle DNS & Cloudflare (ADMIN-ONLY). Le proxy EST live : les
// enregistrements listés/écrits passent par l'API Cloudflare v4. La clé n'est
// jamais renvoyée (vue `hasApiToken`).
@ApiTags('admin/cloudflare')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/cloudflare')
export class CloudflareController {
  constructor(private readonly service: CloudflareService) {}

  @Get()
  @ApiOperation({ summary: 'Compte Cloudflare (jamais le jeton) — ADMIN' })
  getSettings() {
    return this.service.getSettings();
  }

  @Put()
  @ApiOperation({ summary: 'Mettre à jour compte Cloudflare (PATCH semantics) — ADMIN' })
  updateSettings(
    @Body() dto: UpdateCloudflareSettingsDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.service.updateSettings(dto, { sub: actor.sub, email: actor.email });
  }

  @Post('verify')
  @ApiOperation({ summary: 'Vérifier le jeton Cloudflare + lister les zones — ADMIN' })
  verify(@CurrentUser() actor: JwtPayload) {
    return this.service.verify({ sub: actor.sub, email: actor.email });
  }

  @Get('zones')
  @ApiOperation({ summary: 'Zones du compte Cloudflare (live) — ADMIN' })
  listZones() {
    return this.service.listZones();
  }

  @Get('domains')
  @ApiOperation({ summary: 'Domaines racines importés — ADMIN' })
  listDomains() {
    return this.service.listDomains();
  }

  @Post('domains')
  @ApiOperation({ summary: 'Importer une zone comme domaine racine — ADMIN' })
  registerDomain(@Body() dto: RegisterDomainDto, @CurrentUser() actor: JwtPayload) {
    return this.service.registerDomain(dto, { sub: actor.sub, email: actor.email });
  }

  @Patch('domains/:id')
  @ApiOperation({ summary: 'Mettre à jour un domaine (cnameTarget/status) — ADMIN' })
  updateDomain(
    @Param('id') id: string,
    @Body() dto: UpdateDomainDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    const status = dto.status === 'ACTIVE' || dto.status === 'DISABLED' ? (dto.status as DomainStatus) : undefined;
    return this.service.updateDomain(id, { cnameTarget: dto.cnameTarget, status }, { sub: actor.sub, email: actor.email });
  }

  @Delete('domains/:id')
  @ApiOperation({ summary: 'Supprimer un domaine importé — ADMIN' })
  removeDomain(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.service.removeDomain(id, { sub: actor.sub, email: actor.email });
  }

  @Post('root')
  @ApiOperation({ summary: 'Sélectionner (≤ 1) le domaine racine des sous-domaines — ADMIN' })
  setRootDomain(@Body() dto: SetRootDomainDto, @CurrentUser() actor: JwtPayload) {
    return this.service.setRootDomain(dto.domainId ? dto.domainId : null, { sub: actor.sub, email: actor.email });
  }

  @Get('domains/:domainId/records')
  @ApiOperation({ summary: 'Enregistrements DNS d’un domaine (live) — ADMIN' })
  listDnsRecords(@Param('domainId') domainId: string) {
    return this.service.listDnsRecords(domainId);
  }

  @Post('domains/:domainId/records')
  @ApiOperation({ summary: 'Créer un enregistrement DNS — ADMIN' })
  createDnsRecord(
    @Param('domainId') domainId: string,
    @Body() dto: CreateDnsRecordDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.service.createDnsRecord(
      domainId,
      { type: dto.type, name: dto.name, content: dto.content, proxied: dto.proxied, ttl: dto.ttl },
      { sub: actor.sub, email: actor.email },
    );
  }

  @Delete('domains/:domainId/records/:recordId')
  @ApiOperation({ summary: 'Supprimer un enregistrement DNS — ADMIN' })
  deleteDnsRecord(
    @Param('domainId') domainId: string,
    @Param('recordId') recordId: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.service.deleteDnsRecord(domainId, recordId, { sub: actor.sub, email: actor.email });
  }

  @Post('check')
  @ApiOperation({ summary: 'Disponibilité d’un sous-domaine sous une racine — ADMIN' })
  check(@Body() dto: CheckSubdomainDto) {
    return this.service.checkSubdomainAvailability(dto.subdomain, dto.domainId);
  }
}