import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { HostingPack, PackStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../users/users.service';
import { CreatePackDto, UpdatePackDto } from './dto/create-pack.dto';

/** Vue d'un pack : ressourcs + nb de produits qui le référencent + nb de
 *  catégories dont il est le pack recommandé. */
export type PackView = HostingPack & {
  _count?: { products: number; categories: number };
};

@Injectable()
export class PacksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private static toBandwidth(value?: string): string | null | undefined {
    if (value === undefined) return undefined;
    return value.trim() === '' ? null : value.trim();
  }

  async create(dto: CreatePackDto, actor: Actor): Promise<PackView> {
    const pack = await this.prisma.hostingPack.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        ramMb: dto.ramMb,
        cpuCores: dto.cpuCores ?? 1,
        diskGb: dto.diskGb ?? null,
        bandwidth: PacksService.toBandwidth(dto.bandwidth) ?? null,
        status: dto.status ?? PackStatus.ACTIVE,
      },
      include: { _count: { select: { products: true, categories: true } } },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'pack.create',
      resourceType: 'hosting-pack',
      resourceId: pack.id,
      details: { name: pack.name, ramMb: pack.ramMb, cpuCores: pack.cpuCores },
    });
    return pack;
  }

  async findAll(): Promise<PackView[]> {
    return this.prisma.hostingPack.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { products: true, categories: true } } },
    });
  }

  async findOne(id: string): Promise<PackView> {
    const pack = await this.prisma.hostingPack.findUnique({
      where: { id },
      include: { _count: { select: { products: true, categories: true } } },
    });
    if (!pack) {
      throw new NotFoundException('Pack introuvable.');
    }
    return pack;
  }

  async update(id: string, dto: UpdatePackDto, actor: Actor): Promise<PackView> {
    const before = await this.findOne(id);
    const data: {
      name?: string;
      description?: string | null;
      ramMb?: number;
      cpuCores?: number;
      diskGb?: number | null;
      bandwidth?: string | null;
      status?: PackStatus;
    } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.ramMb !== undefined) data.ramMb = dto.ramMb;
    if (dto.cpuCores !== undefined) data.cpuCores = dto.cpuCores;
    if (dto.diskGb !== undefined) data.diskGb = dto.diskGb;
    if (dto.bandwidth !== undefined) data.bandwidth = PacksService.toBandwidth(dto.bandwidth) ?? null;
    if (dto.status !== undefined) data.status = dto.status;
    const pack = await this.prisma.hostingPack.update({
      where: { id },
      data,
      include: { _count: { select: { products: true, categories: true } } },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'pack.update',
      resourceType: 'hosting-pack',
      resourceId: id,
      details: { from: before.name, to: pack.name, ramMb: pack.ramMb, cpuCores: pack.cpuCores },
    });
    return pack;
  }

  async remove(id: string, actor: Actor): Promise<PackView> {
    const before = await this.findOne(id);
    if (before._count?.products && before._count.products > 0) {
      throw new ConflictException(
        'Ce pack est référencé par des produits — passez-le en DISABLED pour le retirer de l’UI.',
      );
    }
    const pack = await this.prisma.hostingPack.delete({ where: { id } });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'pack.delete',
      resourceType: 'hosting-pack',
      resourceId: id,
      details: { name: before.name },
    });
    return pack;
  }
}