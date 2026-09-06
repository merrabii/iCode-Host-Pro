import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ServerPanelProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { Actor } from '../users/users.service';
import { PanelKind, PanelTarget, PanelTransportFactory } from '../servers/panel-transport.factory';
import {
  CreateDeploymentModuleDto,
  UpdateDeploymentModuleDto,
} from './dto/upsert-deployment-module.dto';

/**
 * Phase 13 — modules/méthodes de déploiement (A/B). Gérés par l'admin sur la
 * page Packs (« Configuration de déploiement ») : nom, code, type, serveur
 * Coolify, projet partagé (liste live pour le Module A) ou préfixe client
 * (Module B), overrides de limites. Les packs sont ensuite liés à un module.
 */
@Injectable()
export class DeploymentModulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly panelFactory: PanelTransportFactory,
  ) {}

  async create(dto: CreateDeploymentModuleDto, actor: Actor) {
    const { serverId, ...rest } = dto;
    if (serverId) await this.assertCoolifyServer(serverId);
    const module = await this.prisma.deploymentModule.create({
      data: {
        ...rest,
        isActive: dto.isActive ?? true,
        perClientPrefix: dto.perClientPrefix ?? 'client',
        serverId: serverId ?? null,
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'deployment-module.create',
      resourceType: 'deployment-module',
      resourceId: module.id,
      details: { code: module.code, name: module.name, kind: module.kind },
    });
    return module;
  }

  async findAll() {
    return this.prisma.deploymentModule.findMany({
      orderBy: [{ code: 'asc' }],
      include: {
        server: { select: { id: true, name: true, hostname: true, panelProvider: true } },
        _count: { select: { packs: true, clientProjects: true } },
      },
    });
  }

  async findOne(id: string) {
    const module = await this.prisma.deploymentModule.findUnique({
      where: { id },
      include: {
        server: { select: { id: true, name: true, hostname: true, panelProvider: true } },
        _count: { select: { packs: true, clientProjects: true } },
      },
    });
    if (!module) {
      throw new NotFoundException('Module de déploiement introuvable.');
    }
    return module;
  }

  async update(id: string, dto: UpdateDeploymentModuleDto, actor: Actor) {
    await this.findOne(id);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.kind !== undefined) data.kind = dto.kind;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.sharedProjectUuid !== undefined) data.sharedProjectUuid = dto.sharedProjectUuid;
    if (dto.sharedProjectName !== undefined) data.sharedProjectName = dto.sharedProjectName;
    if (dto.perClientPrefix !== undefined) data.perClientPrefix = dto.perClientPrefix;
    if (dto.overrideRamMb !== undefined) data.overrideRamMb = dto.overrideRamMb;
    if (dto.overrideCpuCores !== undefined) data.overrideCpuCores = dto.overrideCpuCores;
    if (dto.overrideStorageLimit !== undefined) data.overrideStorageLimit = dto.overrideStorageLimit;
    if (dto.serverId !== undefined) {
      await this.assertCoolifyServer(dto.serverId);
      data.serverId = dto.serverId;
    }
    const module = await this.prisma.deploymentModule.update({ where: { id }, data });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'deployment-module.update',
      resourceType: 'deployment-module',
      resourceId: id,
      details: { code: module.code, name: module.name, kind: module.kind },
    });
    return module;
  }

  async remove(id: string, actor: Actor) {
    const before = await this.findOne(id);
    if (before._count?.packs && before._count.packs > 0) {
      throw new BadRequestException(
        'Ce module est lié à des packs — retirez d’abord la liaison (Packs → module de déploiement).',
      );
    }
    const module = await this.prisma.deploymentModule.delete({ where: { id } });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'deployment-module.delete',
      resourceType: 'deployment-module',
      resourceId: id,
      details: { code: before.code, name: before.name },
    });
    return module;
  }

  /**
   * Liste LIVE des projets Coolify du serveur du module (Module A : l'admin
   * choisit le projet partagé parmi la liste réelle). Retourne aussi la
   * sélection courante (sharedProjectUuid) pour l'UI.
   */
  async listProjects(id: string): Promise<{ projects: { uuid: string; name: string }[]; selected: string | null }> {
    const module = await this.findOne(id);
    if (!module.server) {
      throw new BadRequestException(
        'Ce module n’a pas de serveur Coolify associé — impossible de lister les projets.',
      );
    }
    const server = await this.prisma.server.findUnique({ where: { id: module.server.id } });
    if (!server || server.panelProvider !== ServerPanelProvider.COOLIFY) {
      throw new BadRequestException('Le serveur de ce module n’est pas Coolify.');
    }
    if (!server.apiTokenEnc || !server.apiBaseUrl) {
      throw new BadRequestException('Le serveur Coolify de ce module n’est pas connecté.');
    }
    const projects = await this.panelFactory
      .create()
      .listProjects(this.buildTarget(server));
    return { projects, selected: module.sharedProjectUuid };
  }

  private async assertCoolifyServer(serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) {
      throw new BadRequestException('Serveur introuvable.');
    }
    if (server.panelProvider !== ServerPanelProvider.COOLIFY) {
      throw new BadRequestException('Le serveur du module doit être un serveur Coolify connecté.');
    }
  }

  private buildTarget(server: {
    apiTokenEnc: string | null;
    apiBaseUrl: string | null;
    panelProvider: unknown;
    strictTls: boolean;
  }): PanelTarget {
    let token: string;
    try {
      token = this.crypto.decrypt(server.apiTokenEnc!);
    } catch {
      throw new BadRequestException(
        'Impossible de déchiffrer le jeton API Coolify (ENCRYPTION_KEY ?).',
      );
    }
    return {
      provider: server.panelProvider as PanelKind,
      baseUrl: server.apiBaseUrl!,
      token,
      user: null,
      strictTls: server.strictTls,
    };
  }
}