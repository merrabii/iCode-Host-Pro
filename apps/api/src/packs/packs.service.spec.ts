import { ConflictException, NotFoundException } from '@nestjs/common';
import { PacksService } from './packs.service';

describe('PacksService', () => {
  let service: PacksService;
  const mockPrisma = {
    hostingPack: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  const mockAudit = { record: jest.fn() };
  const actor = { sub: 'admin', email: 'admin@example.com' };
  const INCLUDE = { _count: { select: { products: true, categories: true } } };

  beforeEach(() => {
    service = new PacksService(mockPrisma as never, mockAudit as never);
    jest.clearAllMocks();
  });

  it('creates a pack with defaults (cpu 1, ACTIVE) and empty bandwidth → null', async () => {
    mockPrisma.hostingPack.create.mockResolvedValue({
      id: 'p1',
      name: 'Starter',
      ramMb: 1024,
      cpuCores: 1,
      status: 'ACTIVE',
    });
    await expect(
      service.create({ name: 'Starter', ramMb: 1024, bandwidth: '' }, actor),
    ).resolves.toMatchObject({ cpuCores: 1, status: 'ACTIVE' });
    expect(mockPrisma.hostingPack.create).toHaveBeenCalledWith({
      data: {
        name: 'Starter',
        description: null,
        ramMb: 1024,
        cpuCores: 1,
        diskGb: null,
        bandwidth: null,
        status: 'ACTIVE',
      },
      include: INCLUDE,
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pack.create', actorId: 'admin', resourceId: 'p1' }),
    );
  });

  it('keeps trimmed bandwidth string and explicit ram/cpu/status', async () => {
    mockPrisma.hostingPack.create.mockResolvedValue({});
    await service.create(
      { name: 'Pro', ramMb: 2048, cpuCores: 2, diskGb: 50, bandwidth: ' 1 To / mois ', status: 'DRAFT' },
      actor,
    );
    expect(mockPrisma.hostingPack.create).toHaveBeenCalledWith({
      data: {
        name: 'Pro',
        description: null,
        ramMb: 2048,
        cpuCores: 2,
        diskGb: 50,
        bandwidth: '1 To / mois',
        status: 'DRAFT',
      },
      include: INCLUDE,
    });
  });

  it('throws NotFoundException on update for an unknown id', async () => {
    mockPrisma.hostingPack.findUnique.mockResolvedValue(null);
    await expect(service.update('nope', { ramMb: 512 }, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPrisma.hostingPack.update).not.toHaveBeenCalled();
  });

  it('refuses (409) to delete a pack referenced by products', async () => {
    mockPrisma.hostingPack.findUnique.mockResolvedValue({
      id: 'p1',
      name: 'Starter',
      _count: { products: 2, categories: 0 },
    });
    await expect(service.remove('p1', actor)).rejects.toBeInstanceOf(ConflictException);
    expect(mockPrisma.hostingPack.delete).not.toHaveBeenCalled();
    expect(mockAudit.record).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced pack and journals the delete', async () => {
    mockPrisma.hostingPack.findUnique.mockResolvedValue({
      id: 'p1',
      name: 'Starter',
      _count: { products: 0, categories: 0 },
    });
    mockPrisma.hostingPack.delete.mockResolvedValue({ id: 'p1' });
    await expect(service.remove('p1', actor)).resolves.toEqual({ id: 'p1' });
    expect(mockPrisma.hostingPack.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pack.delete', actorId: 'admin', resourceId: 'p1' }),
    );
  });
});