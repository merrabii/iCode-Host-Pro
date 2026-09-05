import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CategoriesService } from './categories.service';

describe('CategoriesService', () => {
  let service: CategoriesService;
  const mockPrisma = {
    productCategory: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    hostingPack: { findUnique: jest.fn() },
  };
  const mockAudit = { record: jest.fn() };
  const actor = { sub: 'admin', email: 'admin@example.com' };
  const INCLUDE = {
    recommendedPack: {
      select: { id: true, name: true, ramMb: true, cpuCores: true, diskGb: true, bandwidth: true },
    },
    _count: { select: { products: true } },
  };

  beforeEach(() => {
    service = new CategoriesService(mockPrisma as never, mockAudit as never);
    jest.clearAllMocks();
  });

  it('creates a category with recommended pack and journals it', async () => {
    mockPrisma.hostingPack.findUnique.mockResolvedValue({ id: 'p1' });
    mockPrisma.productCategory.create.mockResolvedValue({ id: 'c1', name: 'Web', recommendedPackId: 'p1' });
    await expect(
      service.create({ name: 'Web', recommendedPackId: 'p1' }, actor),
    ).resolves.toMatchObject({ id: 'c1' });
    expect(mockPrisma.productCategory.create).toHaveBeenCalledWith({
      data: { name: 'Web', description: null, displayOrder: 0, recommendedPackId: 'p1' },
      include: INCLUDE,
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'category.create', actorId: 'admin', resourceId: 'c1' }),
    );
  });

  it('clears recommendedPackId when an empty string is passed on create', async () => {
    mockPrisma.productCategory.create.mockResolvedValue({ id: 'c2', recommendedPackId: null });
    await service.create({ name: 'DB', recommendedPackId: '' }, actor);
    expect(mockPrisma.productCategory.create).toHaveBeenCalledWith({
      data: { name: 'DB', description: null, displayOrder: 0, recommendedPackId: null },
      include: INCLUDE,
    });
  });

  it('rejects (400) a create with a missing recommended pack', async () => {
    mockPrisma.hostingPack.findUnique.mockResolvedValue(null);
    await expect(service.create({ name: 'Web', recommendedPackId: 'ghost' }, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockPrisma.productCategory.create).not.toHaveBeenCalled();
  });

  it('throws NotFoundException on update for an unknown id', async () => {
    mockPrisma.productCategory.findUnique.mockResolvedValue(null);
    await expect(service.update('nope', { name: 'X' }, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPrisma.productCategory.update).not.toHaveBeenCalled();
  });

  it('refuses (409) to delete a category referenced by products', async () => {
    mockPrisma.productCategory.findUnique.mockResolvedValue({
      id: 'c1',
      name: 'Web',
      _count: { products: 3 },
    });
    await expect(service.remove('c1', actor)).rejects.toBeInstanceOf(ConflictException);
    expect(mockPrisma.productCategory.delete).not.toHaveBeenCalled();
    expect(mockAudit.record).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced category and journals the delete', async () => {
    mockPrisma.productCategory.findUnique.mockResolvedValue({
      id: 'c1',
      name: 'Web',
      _count: { products: 0 },
    });
    mockPrisma.productCategory.delete.mockResolvedValue({ id: 'c1' });
    await expect(service.remove('c1', actor)).resolves.toEqual({ id: 'c1' });
    expect(mockPrisma.productCategory.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'category.delete', actorId: 'admin', resourceId: 'c1' }),
    );
  });
});