import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProductStatus, ServerStatus, Role } from '@prisma/client';

export interface ManagerSummary {
  products: { total: number; byStatus: Record<ProductStatus, number> };
  servers: { total: number; byStatus: Record<ServerStatus, number> };
  users: { total: number; active: number; byRole: Record<Role, number> };
}

/** Aggregated platform dashboard for the /manager admin console (Phase 3). */
@Injectable()
export class ManagerService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(): Promise<ManagerSummary> {
    const [productRows, serverRows, roleRows, activeUsers] = await Promise.all([
      this.prisma.product.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.server.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
      this.prisma.user.count({ where: { isActive: true } }),
    ]);

    const productByStatus = this.fillStatusMap<ProductStatus>(
      Object.values(ProductStatus),
      productRows as { status: ProductStatus; _count: { _all: number } }[],
    );
    const serverByStatus = this.fillStatusMap<ServerStatus>(
      Object.values(ServerStatus),
      serverRows as { status: ServerStatus; _count: { _all: number } }[],
    );

    const byRole = {} as Record<Role, number>;
    for (const r of Object.values(Role)) byRole[r] = 0;
    for (const r of roleRows as { role: Role; _count: { _all: number } }[]) {
      byRole[r.role] = r._count._all;
    }

    return {
      products: {
        total: productRows.reduce((s, r) => s + r._count._all, 0),
        byStatus: productByStatus,
      },
      servers: {
        total: serverRows.reduce((s, r) => s + r._count._all, 0),
        byStatus: serverByStatus,
      },
      users: {
        total: Object.values(Role).reduce((s, r) => s + byRole[r], 0),
        active: activeUsers,
        byRole,
      },
    };
  }

  private fillStatusMap<K extends string>(
    keys: K[],
    rows: { status: K; _count: { _all: number } }[],
  ): Record<K, number> {
    const map = {} as Record<K, number>;
    for (const k of keys) map[k] = 0;
    for (const row of rows) map[row.status] = row._count._all;
    return map;
  }
}