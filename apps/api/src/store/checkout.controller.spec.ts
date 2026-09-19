import { HttpException, HttpStatus } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import type { Response } from 'express';
import { CheckoutController } from './checkout.controller';
import { rateKey } from '../auth/rate-limiter';
import { ORDER_STATUS_RATE_LIMIT_FALLBACK } from '../auth/security/security-settings.service';

/**
 * Correctif sécurité + rate-limit administrable — GET /store/orders/:id/status.
 * Invariants : suivi public invité par orderId conservé, AUCUNE donnée
 * personnelle (jamais customerEmail/invoiceNumber/createdAt/orderId dans la
 * réponse), rate-limit IP via le SaRateLimiter existant avec la config admin
 * (SecuritySettingsService), dépassement = HTTP 429 + Retry-After, et
 * enabled=false → le limiteur n'est pas appelé.
 */
describe('CheckoutController — GET orders/:id/status (correctif sécurité)', () => {
  const mockPrisma = { order: { findUnique: jest.fn() } };
  const mockLimiter = { consume: jest.fn() };
  const mockSettings = { getOrderStatusRateLimit: jest.fn() };
  const setHeader = jest.fn();
  const mockRes = { setHeader } as unknown as Response;
  let controller: CheckoutController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLimiter.consume.mockReturnValue({ allowed: true, retryAfterMs: 0 });
    mockSettings.getOrderStatusRateLimit.mockResolvedValue({ ...ORDER_STATUS_RATE_LIMIT_FALLBACK });
    controller = new CheckoutController(
      {} as never, // CheckoutService inutilisé par cet endpoint
      mockPrisma as never,
      mockLimiter as never,
      mockSettings as never,
    );
  });

  it('commande existante → uniquement { found: true, status }', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ status: OrderStatus.PROVISIONING });
    const out = await controller.status('cm123abc', '1.2.3.4', mockRes);
    expect(out).toEqual({ found: true, status: OrderStatus.PROVISIONING });
  });

  it('n’expose JAMAIS customerEmail, invoiceNumber, createdAt ni orderId', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ status: OrderStatus.ACTIVE });
    const out = (await controller.status('cm123abc', '1.2.3.4', mockRes)) as Record<string, unknown>;
    expect(out).not.toHaveProperty('customerEmail');
    expect(out).not.toHaveProperty('invoiceNumber');
    expect(out).not.toHaveProperty('createdAt');
    expect(out).not.toHaveProperty('orderId');
    expect(Object.keys(out).sort()).toEqual(['found', 'status']);
    // La requête Prisma elle-même ne sélectionne aucune donnée personnelle.
    const arg = mockPrisma.order.findUnique.mock.calls[0]![0] as {
      select: Record<string, unknown>;
    };
    expect(arg.select).toEqual({ status: true });
  });

  it('commande inexistante → { found: false }', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    const out = await controller.status('cmunknown0', '1.2.3.4', mockRes);
    expect(out).toEqual({ found: false });
  });

  it('rate-limit appelé avec l’IP, la clé dédiée et la CONFIG ADMIN (pas de preset fixe)', async () => {
    mockSettings.getOrderStatusRateLimit.mockResolvedValue({ enabled: true, limit: 7, windowMs: 15_000 });
    mockPrisma.order.findUnique.mockResolvedValue(null);
    await controller.status('cm123abc', '9.9.9.9', mockRes);
    expect(mockSettings.getOrderStatusRateLimit).toHaveBeenCalled();
    expect(mockLimiter.consume).toHaveBeenCalledWith(
      rateKey('9.9.9.9', 'store-order-status'),
      7,
      15_000,
    );
  });

  it('dépassement → HTTP 429 précis + Retry-After, sans toucher à la base', async () => {
    mockLimiter.consume.mockReturnValue({ allowed: false, retryAfterMs: 42_000 });
    let caught: unknown;
    try {
      await controller.status('cm123abc', '1.2.3.4', mockRes);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect((caught as HttpException).message).toMatch(/Trop de demandes/);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '42');
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('Retry-After = entier positif en secondes (arrondi supérieur, jamais 0)', async () => {
    // 1500 ms → 2 s ; 0 ms → 1 s (jamais « 0 », qui inviterait à re-tenter aussitôt).
    for (const [ms, expected] of [
      [1_500, '2'],
      [0, '1'],
      [999, '1'],
      [60_000, '60'],
    ] as Array<[number, string]>) {
      setHeader.mockClear();
      mockLimiter.consume.mockReturnValue({ allowed: false, retryAfterMs: ms });
      await expect(controller.status('cm123abc', '1.2.3.4', mockRes)).rejects.toBeInstanceOf(
        HttpException,
      );
      expect(setHeader).toHaveBeenCalledWith('Retry-After', expected);
    }
  });

  it('enabled=false → le limiteur n’est PAS appelé (protection désactivée par l’admin)', async () => {
    mockSettings.getOrderStatusRateLimit.mockResolvedValue({ enabled: false, limit: 30, windowMs: 60_000 });
    mockPrisma.order.findUnique.mockResolvedValue(null);
    const out = await controller.status('cm123abc', '1.2.3.4', mockRes);
    expect(mockLimiter.consume).not.toHaveBeenCalled();
    expect(out).toEqual({ found: false });
  });
});
