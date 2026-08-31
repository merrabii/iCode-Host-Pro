import { AuditService } from './audit.service';

describe('AuditService', () => {
  let service: AuditService;
  const mockPrisma = {
    $transaction: jest.fn(),
    auditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(() => {
    service = new AuditService(mockPrisma as never);
    jest.clearAllMocks();
  });

  it('records an audit entry with mapped fields', async () => {
    mockPrisma.auditLog.create.mockResolvedValue({ id: 'x' });
    await service.record({
      actorId: 'a1',
      actorEmail: 'a@x.com',
      action: 'user.promote',
      resourceType: 'user',
      resourceId: 'u1',
      details: { fromRole: 'USER', toRole: 'ADMIN' },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: 'a1',
        actorEmail: 'a@x.com',
        action: 'user.promote',
        resourceType: 'user',
        resourceId: 'u1',
        details: { fromRole: 'USER', toRole: 'ADMIN' },
      },
    });
  });

  it('coerces absent optional fields to null/undefined', async () => {
    mockPrisma.auditLog.create.mockResolvedValue({});
    await service.record({ action: 'server.delete' });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: null,
        actorEmail: null,
        action: 'server.delete',
        resourceType: null,
        resourceId: null,
        details: undefined,
      },
    });
  });

  it('never throws when the write fails (best-effort audit)', async () => {
    mockPrisma.auditLog.create.mockRejectedValue(new Error('db down'));
    await expect(service.record({ action: 'auth.login', actorId: 'a1' })).resolves.toBeUndefined();
  });

  it('returns a paginated page, building filters into the query', async () => {
    mockPrisma.$transaction.mockResolvedValue([[{ id: 'e1', action: 'user.promote' }], 7]);
    const page = await service.findAll({
      page: 2,
      perPage: 10,
      action: 'user.promote',
      resourceType: 'user',
      from: '2026-01-01T00:00:00.000Z',
    });
    expect(page).toEqual({
      items: [{ id: 'e1', action: 'user.promote' }],
      total: 7,
      page: 2,
      perPage: 10,
    });
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it('clamps perPage to an upper bound', async () => {
    mockPrisma.$transaction.mockResolvedValue([[], 0]);
    const page = await service.findAll({ perPage: 5000 });
    expect(page.perPage).toBe(200);
  });
});