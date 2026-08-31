import { Injectable } from '@nestjs/common';
import { AuditLog, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditRecord {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  details?: Prisma.InputJsonValue | null;
}

export interface AuditPage {
  items: AuditLog[];
  total: number;
  page: number;
  perPage: number;
}

/**
 * Append-only audit journal (Phase 4, ADR-019). `record()` is fire-and-forget
 * but awaited: a logging failure must NEVER break the real mutation it follows,
 * so writes are guarded with try/catch. `findAll()` is the ADMIN-only reader.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditRecord): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: input.actorId ?? null,
          actorEmail: input.actorEmail ?? null,
          action: input.action,
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
          details:
            input.details === null || input.details === undefined
              ? undefined
              : (input.details as Prisma.InputJsonObject),
        },
      });
    } catch {
      // Audit is best-effort: never let a logging error break the business call.
    }
  }

  async findAll(query: {
    page?: number;
    perPage?: number;
    actorId?: string;
    action?: string;
    resourceType?: string;
    from?: string;
    to?: string;
  } = {}): Promise<AuditPage> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const perPage = Math.min(Math.max(1, Math.trunc(query.perPage ?? 50)), 200);

    const where: Prisma.AuditLogWhereInput = {};
    if (query.actorId) where.actorId = query.actorId;
    if (query.action) where.action = query.action;
    if (query.resourceType) where.resourceType = query.resourceType;
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { items, total, page, perPage };
  }
}