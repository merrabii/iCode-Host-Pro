import { NotFoundException } from '@nestjs/common';
import { ProductStatus } from '@prisma/client';
import { CheckoutService, CHECKOUT_INTENT_TTL_SECONDS } from './checkout.service';

describe('CheckoutService (order-time intent, ADR-027)', () => {
  const mockPrisma = { product: { findUnique: jest.fn() } };
  const mockJwt = { signAsync: jest.fn(), verifyAsync: jest.fn() };
  const mockAudit = { record: jest.fn() };
  const mockLimiter = { consume: jest.fn() };

  let service: CheckoutService;
  beforeEach(() => {
    service = new CheckoutService(
      mockPrisma as never,
      mockJwt as never,
      mockAudit as never,
      mockLimiter as never,
    );
    jest.clearAllMocks();
    mockLimiter.consume.mockReturnValue({ allowed: true, retryAfterMs: 0 });
  });

  const product = { id: 'p1', status: ProductStatus.ACTIVE };

  it('creates a signed short-lived intent for an orderable product', async () => {
    mockPrisma.product.findUnique.mockResolvedValue(product);
    mockJwt.signAsync.mockResolvedValue('jwt.token');
    const res = await service.createIntent('p1', '1.2.3.4');
    expect(res.token).toBe('jwt.token');
    expect(res.maxAgeSeconds).toBe(CHECKOUT_INTENT_TTL_SECONDS);
    expect(mockJwt.signAsync).toHaveBeenCalledWith({ productId: 'p1' }, { expiresIn: 600 });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'checkout.intent', resourceId: 'p1' }),
    );
  });

  it('rejects a DRAFT product', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ ...product, status: ProductStatus.DRAFT });
    await expect(service.createIntent('p1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an unknown product', async () => {
    mockPrisma.product.findUnique.mockResolvedValue(null);
    await expect(service.createIntent('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('denies intent issuance when rate-limited', async () => {
    mockLimiter.consume.mockReturnValue({ allowed: false, retryAfterMs: 3000 });
    await expect(service.createIntent('p1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('readProductId returns null for a missing / invalid / expired cookie', async () => {
    await expect(service.readProductId(undefined)).resolves.toBeNull();
    await expect(service.readProductId(null)).resolves.toBeNull();
    mockJwt.verifyAsync.mockRejectedValue(new Error('bad token'));
    await expect(service.readProductId('bad')).resolves.toBeNull();
    mockJwt.verifyAsync.mockResolvedValue({
      productId: 'p1',
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    await expect(service.readProductId('expired')).resolves.toBeNull();
  });

  it('readProductId returns the product for a live token', async () => {
    mockJwt.verifyAsync.mockResolvedValue({
      productId: 'p1',
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    await expect(service.readProductId('valid')).resolves.toBe('p1');
  });
});
