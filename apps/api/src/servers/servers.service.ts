import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Server } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CreateServerDto } from './dto/create-server.dto';
import { UpdateServerDto } from './dto/update-server.dto';
import { Actor } from '../users/users.service';

@Injectable()
export class ServersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateServerDto, actor: Actor): Promise<Server> {
    const server = await this.prisma.server.create({
      data: {
        name: dto.name,
        hostname: dto.hostname,
        status: dto.status,
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