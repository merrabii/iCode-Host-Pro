import { Role } from '@prisma/client';
import { ManagerService } from './manager.service';

describe('ManagerService', () => {
  let service: ManagerService;
  const mockPrisma = {
    product: { groupBy: jest.fn() },
    server: { groupBy: jest.fn() },
    user: { groupBy: jest.fn(), count: jest.fn() },
  };

  beforeEach(() => {
    service = new ManagerService(mockPrisma as never);
    jest.clearAllMocks();
  });

  it('aggregates products, servers and users into a summary', async () => {
    mockPrisma.product.groupBy.mockResolvedValue([
      { status: 'ACTIVE', _count: { _all: 2 } },
      { status: 'DRAFT', _count: { _all: 1 } },
    ]);
    mockPrisma.server.groupBy.mockResolvedValue([
      { status: 'ACTIVE', _count: { _all: 3 } },
    ]);
    mockPrisma.user.groupBy.mockResolvedValue([
      { role: Role.ADMIN, _count: { _all: 1 } },
      { role: Role.USER, _count: { _all: 4 } },
    ]);
    mockPrisma.user.count.mockResolvedValue(5);

    const summary = await service.summary();

    expect(summary.products).toEqual({
      total: 3,
      byStatus: {
        DRAFT: 1,
        ACTIVE: 2,
        SUSPENDED: 0,
        DISABLED: 0,
      },
    });
    expect(summary.servers).toEqual({
      total: 3,
      byStatus: {
        UNKNOWN: 0,
        PROVISIONING: 0,
        ACTIVE: 3,
        PROBLEM: 0,
        REMOVED: 0,
      },
    });
    expect(summary.users).toEqual({
      total: 5,
      active: 5,
      byRole: { ADMIN: 1, USER: 4 },
    });
  });

  it('returns zero-filled maps when nothing exists', async () => {
    mockPrisma.product.groupBy.mockResolvedValue([]);
    mockPrisma.server.groupBy.mockResolvedValue([]);
    mockPrisma.user.groupBy.mockResolvedValue([]);
    mockPrisma.user.count.mockResolvedValue(0);

    const summary = await service.summary();
    expect(summary.products.total).toBe(0);
    expect(summary.servers.total).toBe(0);
    expect(summary.users.total).toBe(0);
    expect(summary.users.byRole).toEqual({ ADMIN: 0, USER: 0 });
  });
});