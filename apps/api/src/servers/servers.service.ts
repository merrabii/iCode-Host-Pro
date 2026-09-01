import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Server } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CreateServerDto } from './dto/create-server.dto';
import { UpdateServerDto } from './dto/update-server.dto';
import { ProbeResult, ProbeTransportFactory } from './probe-transport.factory';
import { Actor } from '../users/users.service';

export interface ServerCheckResult {
  server: Server;
  probe: ProbeResult;
}

@Injectable()
export class ServersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly probeFactory: ProbeTransportFactory,
  ) {}

  async create(dto: CreateServerDto, actor: Actor): Promise<Server> {
    const server = await this.prisma.server.create({
      data: {
        name: dto.name,
        hostname: dto.hostname,
        status: dto.status,
        ipAddress: dto.ipAddress,
        port: dto.port,
        provider: dto.provider,
        region: dto.region,
        quotaMaxAccounts: dto.quotaMaxAccounts,
        strictTls: dto.strictTls,
        panelProvider: dto.panelProvider,
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'server.create',
      resourceType: 'server',
      resourceId: server.id,
      details: { name: server.name, hostname: server.hostname, status: server.status },
    });
    return server;
  }

  async findAll(): Promise<Server[]> {
    return this.prisma.server.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string): Promise<Server> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) {
      throw new NotFoundException('Server not found');
    }
    return server;
  }

  async update(id: string, dto: UpdateServerDto, actor: Actor): Promise<Server> {
    const before = await this.findOne(id);
    const server = await this.prisma.server.update({ where: { id }, data: dto });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'server.update',
      resourceType: 'server',
      resourceId: id,
      details: { from: before, to: server },
    });
    return server;
  }

  /**
   * Phase 8 (ADR-025): sonde de connectivité réelle vers un serveur.
   * Cible = hostname + port de gestion (défaut 22 si absent). Le résultat est
   * persisté (lastCheckedAt/Ok/Detail) mais le STATUT lui-même reste piloté
   * manuellement par l'admin — la sonde PROPOSE une bascule, elle ne la force pas.
   */
  async check(id: string, actor: Actor): Promise<ServerCheckResult> {
    const server = await this.findOne(id);
    const port = server.port ?? 22;
    const transport = this.probeFactory.create();
    const probe = await transport.probe({
      host: server.hostname,
      port,
      strictTls: server.strictTls,
    });
    const checked = await this.prisma.server.update({
      where: { id },
      data: {
        lastCheckedAt: new Date(),
        lastProbeOk: probe.ok,
        lastProbeDetail: probe.detail,
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'server.check',
      resourceType: 'server',
      resourceId: id,
      details: {
        host: server.hostname,
        port,
        ok: probe.ok,
        detail: probe.detail,
        latencyMs: probe.latencyMs ?? null,
        httpStatus: probe.httpStatus ?? null,
        statusLeft: server.status,
      },
    });
    return { server: checked, probe };
  }

  async remove(id: string, actor: Actor): Promise<Server> {
    const before = await this.findOne(id);
    const server = await this.prisma.server.delete({ where: { id } });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'server.delete',
      resourceType: 'server',
      resourceId: id,
      details: { name: before.name },
    });
    return server;
  }
}