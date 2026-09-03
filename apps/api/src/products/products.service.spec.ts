import { ConflictException, NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';

describe('ProductsService', () => {
  let service: ProductsService;
  const mockPrisma = {
    product: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    subscription: { count: jest.fn() },
  };
  const mockAudit = { record: jest.fn() };
  const actor = { sub: 'admin', email: 'admin@example.com' };

  beforeEach(() => {
    service = new ProductsService(mockPrisma as never, mockAudit as never);
    jest.clearAllMocks();
  });

  it('creates a product with default kind generic, and journals it', async () => {
    mockPrisma.product.create.mockResolvedValue({ id: '1', name: 'WP', kind: 'generic', status: 'ACTIVE' });
    await expect(service.create({ name: 'WP' }, actor)).resolves.toMatchObject({ kind: 'generic' });
    expect(mockPrisma.product.create).toHaveBeenCalledWith({
      data: { name: 'WP', kind: 'generic', status: undefined },
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'product.create', actorId: 'admin', resourceId: '1' }),
    );
  });

  it('preserves an explicit kind and status on create', async () => {
    mockPrisma.product.create.mockResolvedValue({});
    await service.create({ name: 'DNS', kind: 'dns', status: 'DRAFT' }, actor);
    expect(mockPrisma.product.create).toHaveBeenCalledWith({
      data: { name: 'DNS', kind: 'dns', status: 'DRAFT' },
    });
  });

  it('throws NotFoundException on findOne for an unknown id', async () => {
    mockPrisma.product.findUnique.mockResolvedValue(null);
    await expect(service.findOne('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException on update for an unknown id', async () => {
    mockPrisma.product.findUnique.mockResolvedValue(null);
    await expect(service.update('nope', { name: 'X' }, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPrisma.product.update).not.toHaveBeenCalled();
  });

  it('deletes an existing product and journals the delete', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.subscription.count.mockResolvedValue(0);
    mockPrisma.product.delete.mockResolvedValue({ id: '1' });
    await expect(service.remove('1', actor)).resolves.toEqual({ id: '1' });
    expect(mockPrisma.product.delete).toHaveBeenCalledWith({ where: { id: '1' } });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'product.delete', actorId: 'admin', resourceId: '1' }),
    );
  });

  it('refuses (409) to delete a product referenced by subscriptions', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.subscription.count.mockResolvedValue(2);
    await expect(service.remove('1', actor)).rejects.toBeInstanceOf(ConflictException);
    expect(mockPrisma.product.delete).not.toHaveBeenCalled();
    expect(mockAudit.record).not.toHaveBeenCalled();
  });
});