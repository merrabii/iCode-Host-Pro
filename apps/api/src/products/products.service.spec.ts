import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';

describe('ProductsService', () => {
  let service: ProductsService;
  const mockPrisma = {
    $transaction: jest.fn((ops) => Promise.all(ops)),
    product: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    subscription: { count: jest.fn() },
    productCategory: { findUnique: jest.fn() },
    productCategoryLink: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
      delete: jest.fn(),
    },
    freeSubdomainRule: { findUnique: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
    productOption: { findMany: jest.fn(), create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
    productOptionChoice: {
      findMany: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    productAddon: { findMany: jest.fn(), create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
    provisionMethod: { findMany: jest.fn() },
  };
  const mockAudit = { record: jest.fn() };
  const actor = { sub: 'admin', email: 'admin@example.com' };

  // Phase 12/Bloc A — include utilisé par read/create/update côté service.
  // Doit refléter PRODUCT_INCLUDE du service (on compare l'argument à l'identique).
  const PRODUCT_INCLUDE = {
    category: { select: { id: true, name: true } },
    pack: {
      select: {
        id: true,
        name: true,
        ramMb: true,
        cpuCores: true,
        storageLimit: true,
        bandwidth: true,
        status: true,
        maxApps: true,
        freeSubdomainsIncluded: true,
        deploymentModule: {
          select: { id: true, code: true, name: true, kind: true, server: { select: { id: true, hostname: true } } },
        },
      },
    },
    taxRate: { select: { id: true, name: true, ratePercent: true } },
    categoryLinks: {
      select: { categoryId: true, category: { select: { id: true, name: true } } },
    },
    options: {
      orderBy: { sortOrder: 'asc' },
      include: { choices: { orderBy: { sortOrder: 'asc' } } },
    },
    addons: { orderBy: { sortOrder: 'asc' } },
    freeSubdomainRule: true,
  };
  beforeEach(() => {
    service = new ProductsService(mockPrisma as never, mockAudit as never);
    jest.clearAllMocks();
  });

  it('creates a product with default kind generic, and journals it', async () => {
    mockPrisma.product.create.mockResolvedValue({ id: '1', name: 'WP', kind: 'generic', status: 'ACTIVE' });
    await expect(service.create({ name: 'WP' }, actor)).resolves.toMatchObject({ kind: 'generic' });
    expect(mockPrisma.product.create).toHaveBeenCalledWith({
      // Bloc A : les champs store-front absents sont omis (les défauts du schéma s'appliquent).
      data: { name: 'WP', kind: 'generic', categoryId: null, packId: null },
      include: PRODUCT_INCLUDE,
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'product.create', actorId: 'admin', resourceId: '1' }),
    );
  });

  it('preserves an explicit kind and status on create', async () => {
    mockPrisma.product.create.mockResolvedValue({});
    await service.create({ name: 'DNS', kind: 'dns', status: 'DRAFT' }, actor);
    expect(mockPrisma.product.create).toHaveBeenCalledWith({
      data: { name: 'DNS', kind: 'dns', categoryId: null, packId: null, status: 'DRAFT' },
      include: PRODUCT_INCLUDE,
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

  // ── Bloc B — catégories liées ────────────────────────────────────────────
  it('lists the linked categories of a product', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.productCategoryLink.findMany.mockResolvedValue([{ category: { id: 'c1', name: 'Bio' } }]);
    await expect(service.listCategoryLinks('1')).resolves.toEqual([
      { category: { id: 'c1', name: 'Bio' } },
    ]);
    expect(mockPrisma.productCategoryLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productId: '1' } }),
    );
  });

  it('replaces the linked categories of a product in a transaction', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.productCategory.findUnique.mockResolvedValue({ id: 'c1' });
    mockPrisma.productCategoryLink.findMany.mockResolvedValue([]);
    await expect(service.setCategories('1', ['c1', 'c2'], actor)).resolves.toEqual([]);
    expect(mockPrisma.productCategoryLink.deleteMany).toHaveBeenCalledWith({
      where: { productId: '1' },
    });
    expect(mockPrisma.productCategoryLink.createMany).toHaveBeenCalledWith({
      data: [
        { productId: '1', categoryId: 'c1' },
        { productId: '1', categoryId: 'c2' },
      ],
      skipDuplicates: true,
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'store.categories.set', resourceId: '1' }),
    );
  });

  it('rejects setCategories with an unknown category id', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.productCategory.findUnique.mockResolvedValue(null);
    await expect(service.setCategories('1', ['nope'], actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockPrisma.productCategoryLink.deleteMany).not.toHaveBeenCalled();
  });

  it('unlinks a category and throws 404 when the link is absent', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.productCategoryLink.findUnique.mockResolvedValue(null);
    await expect(service.unlinkCategory('1', 'c1', actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(mockPrisma.productCategoryLink.delete).not.toHaveBeenCalled();
  });

  // ── Bloc B — règle des sous-domaines gratuits (1:1 upsert) ──────────────
  it('upserts a free-subdomain rule, omitting undefined fields', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.freeSubdomainRule.upsert.mockResolvedValue({ productId: '1', minLength: 3 });
    await service.upsertFreeSubdomainRule('1', { minLength: 3, rejectPattern: undefined }, actor);
    expect(mockPrisma.freeSubdomainRule.upsert).toHaveBeenCalledWith({
      where: { productId: '1' },
      create: { productId: '1', minLength: 3 },
      update: { minLength: 3 },
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'store.subdomain.rule.upsert', resourceId: '1' }),
    );
  });

  it('throws 404 when deleting an absent free-subdomain rule', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.freeSubdomainRule.findUnique.mockResolvedValue(null);
    await expect(service.deleteFreeSubdomainRule('1', actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPrisma.freeSubdomainRule.delete).not.toHaveBeenCalled();
  });

  // ── Bloc B — options ─────────────────────────────────────────────────────
  it('creates an option with defaults and journals it', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.productOption.create.mockResolvedValue({ id: 'o1', name: 'Taille', required: false });
    await expect(service.createOption('1', { name: 'Taille' }, actor)).resolves.toMatchObject({
      required: false,
    });
    expect(mockPrisma.productOption.create).toHaveBeenCalledWith({
      data: { productId: '1', name: 'Taille', required: false, sortOrder: 0 },
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'store.option.create', resourceId: '1' }),
    );
  });

  it('rejects reorderOptions when an option does not belong to the product', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.productOption.findMany.mockResolvedValue([{ id: 'o1' }]);
    await expect(service.reorderOptions('1', ['o1', 'o2'], actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockPrisma.productOption.update).not.toHaveBeenCalled();
  });

  it('throws 404 on updateOption for an unknown option', async () => {
    mockPrisma.productOption.findUnique.mockResolvedValue(null);
    await expect(service.updateOption('nope', { name: 'X' }, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ── Bloc B — choix d'option ──────────────────────────────────────────────
  it('creates a choice under an option', async () => {
    mockPrisma.productOption.findUnique.mockResolvedValue({ id: 'o1', productId: '1' });
    mockPrisma.productOptionChoice.create.mockResolvedValue({ id: 'ch1', label: 'XL', priceDeltaHtCents: 200 });
    await expect(
      service.createChoice('o1', { label: 'XL', priceDeltaHtCents: 200 }, actor),
    ).resolves.toMatchObject({ label: 'XL', priceDeltaHtCents: 200 });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'store.choice.create', resourceId: '1' }),
    );
  });

  it('throws 404 on createChoice for an unknown option', async () => {
    mockPrisma.productOption.findUnique.mockResolvedValue(null);
    await expect(service.createChoice('nope', { label: 'X', priceDeltaHtCents: 0 }, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ── Bloc B — add-ons ─────────────────────────────────────────────────────
  it('creates an add-on and journals it', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.productAddon.create.mockResolvedValue({ id: 'a1', name: 'Garantie', priceHtCents: 9900 });
    await expect(
      service.createAddon('1', { name: 'Garantie', priceHtCents: 9900 }, actor),
    ).resolves.toMatchObject({ priceHtCents: 9900 });
    expect(mockPrisma.productAddon.create).toHaveBeenCalledWith({
      data: { productId: '1', name: 'Garantie', description: null, priceHtCents: 9900, sortOrder: 0 },
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'store.addon.create', resourceId: '1' }),
    );
  });

  it('throws 404 on updateAddon for an unknown add-on', async () => {
    mockPrisma.productAddon.findUnique.mockResolvedValue(null);
    await expect(service.updateAddon('nope', { name: 'X' }, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects reorderAddons when an add-on does not belong to the product', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.productAddon.findMany.mockResolvedValue([{ id: 'a1' }]);
    await expect(service.reorderAddons('1', ['a1', 'a2'], actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  // ── Bloc B — provisioning ────────────────────────────────────────────────
  it('returns the provisioning summary with a null module when absent', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: '1', moduleParams: null, pack: null });
    await expect(service.getProvisioning('1')).resolves.toEqual({
      deploymentModule: null,
      provisionMethod: undefined,
      moduleParams: {},
    });
  });

  it('lists active provision methods', async () => {
    const methods = [{ id: 'm1', name: 'Docker', isActive: true }];
    mockPrisma.provisionMethod.findMany.mockResolvedValue(methods);
    await expect(service.listActiveProvisionMethods()).resolves.toEqual(methods);
    expect(mockPrisma.provisionMethod.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
  });
});