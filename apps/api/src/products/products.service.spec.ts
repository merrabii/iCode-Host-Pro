import { NotFoundException } from '@nestjs/common';
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
  };

  beforeEach(() => {
    service = new ProductsService(mockPrisma as never);
    jest.clearAllMocks();
  });

  it('creates a product with default kind generic', async () => {
    mockPrisma.product.create.mockResolvedValue({ id: '1', name: 'WP', kind: 'generic', status: 'ACTIVE' });
    await expect(service.create({ name: 'WP' })).resolves.toMatchObject({ kind: 'generic' });
    expect(mockPrisma.product.create).toHaveBeenCalledWith({
      data: { name: 'WP', kind: 'generic', status: undefined },
    });
  });

  it('preserves an explicit kind and status on create', async () => {
    mockPrisma.product.create.mockResolvedValue({});
    await service.create({ name: 'DNS', kind: 'dns', status: 'DRAFT' });
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
    await expect(service.update('nope', { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
    expect(mockPrisma.product.update).not.toHaveBeenCalled();
  });

  it('deletes an existing product', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.product.delete.mockResolvedValue({ id: '1' });
    await expect(service.remove('1')).resolves.toEqual({ id: '1' });
    expect(mockPrisma.product.delete).toHaveBeenCalledWith({ where: { id: '1' } });
  });
});