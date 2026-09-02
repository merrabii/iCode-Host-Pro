import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ProductStatus, Role } from '@prisma/client';
import { AuthService } from './auth.service';

jest.mock('bcryptjs', () => ({
  compare: jest.fn(async () => true),
  hash: jest.fn(async (s: string) => `hashed:${s}`),
}));

describe('AuthService (impersonation + order-time registration, ADR-027)', () => {
  const mockPrisma = {
    user: { findUnique: jest.fn() },
    product: { findUnique: jest.fn() },
    refreshToken: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    subscription: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const mockJwt = { signAsync: jest.fn(), verifyAsync: jest.fn() };
  const mockConfig = { get: jest.fn() };
  const mockAudit = { record: jest.fn() };
  const mockInvitations = {};
  const mockLimiter = { consume: jest.fn() };
  const mockTurnstile = { verify: jest.fn() };
  const mockMfa = { evaluateLogin: jest.fn() };
  const mockSettings = { isSelfRegistrationEnabled: jest.fn(), isTurnstileEnabled: jest.fn() };

  let service: AuthService;
  beforeEach(() => {
    service = new AuthService(
      mockPrisma as never,
      mockJwt as never,
      mockConfig as never,
      mockAudit as never,
      mockInvitations as never,
      mockLimiter as never,
      mockTurnstile as never,
      mockMfa as never,
      mockSettings as never,
    );
    jest.clearAllMocks();
    mockConfig.get.mockReturnValue(undefined);
    mockSettings.isSelfRegistrationEnabled.mockResolvedValue(true);
    mockJwt.signAsync.mockResolvedValue('jwt.token');
  });

  const admin = { sub: 'a1', email: 'admin@example.com' };
  const client = {
    id: 'u1',
    email: 'client@example.com',
    role: Role.USER,
    isActive: true,
    mfaEnabled: false,
  };

  describe('impersonate', () => {
    it('refuses impersonating yourself', async () => {
      await expect(service.impersonate('a1', admin, 'admin')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockJwt.signAsync).not.toHaveBeenCalled();
    });

    it('refuses an unknown target', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.impersonate('nope', admin, 'admin')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses a disabled account', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...client, isActive: false });
      await expect(service.impersonate('u1', admin, 'admin')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('refuses to impersonate an ADMIN (anti-escalation)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...client,
        role: Role.ADMIN,
        isActive: true,
      });
      await expect(service.impersonate('u1', admin, 'admin')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('signs a USER-pinned token with an imp marker, no refresh row, TTL capped at 24h, audited', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(client);
      mockConfig.get.mockImplementation((k: string) => (k === 'impersonationExpiresIn' ? '999d' : undefined));
      const res = await service.impersonate('u1', admin, 'admin');
      expect(res.accessToken).toBe('jwt.token');
      expect(mockJwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'u1',
          role: Role.USER,
          imp: { by: 'a1', kind: 'admin' },
        }),
        { expiresIn: 24 * 60 * 60 }, // capped
      );
      expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'impersonate.start', resourceId: 'u1' }),
      );
    });

    it('support kind passes the marker through', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(client);
      await service.impersonate('u1', { sub: 'l2', email: 'l2@example.com' }, 'support');
      expect(mockJwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ imp: { by: 'l2', kind: 'support' } }),
        expect.anything(),
      );
    });
  });

  describe('returnFromImpersonation', () => {
    it('audits impersonate.end only when the token carries an imp marker', async () => {
      await service.returnFromImpersonation({
        sub: 'u1',
        email: 'client@example.com',
        role: Role.USER,
        imp: { by: 'a1', kind: 'admin' },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'impersonate.end' }),
      );

      await service.returnFromImpersonation({
        sub: 'u1',
        email: 'client@example.com',
        role: Role.USER,
      });
      expect(mockAudit.record).toHaveBeenCalledTimes(1); // no extra audit
    });
  });

  describe('register (order-time account creation)', () => {
    const dto = { email: 'new@example.com', password: 'password123', name: 'New' };

    it('requires a checkout intent (no intent → 403)', async () => {
      await expect(service.register(dto, null)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('requires the admin self-registration flag (off → 403)', async () => {
      mockSettings.isSelfRegistrationEnabled.mockResolvedValue(false);
      await expect(service.register(dto, 'p1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses when the email already has an account', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(client);
      await expect(service.register(dto, 'p1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('creates the account + PENDING subscription atomically and issues tokens', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.product.findUnique.mockResolvedValue({ id: 'p1', status: ProductStatus.ACTIVE });
      mockPrisma.$transaction.mockImplementation(async (cb) =>
        cb({ ...mockPrisma, user: { create: jest.fn().mockResolvedValue(client) } }),
      );
      mockPrisma.subscription.create.mockResolvedValue({ id: 'sub1' });

      await service.register(dto, 'p1');
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.subscription.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ productId: 'p1' }) }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.register', details: { productId: 'p1' } }),
      );
    });

    it('rejects an order for a DRAFT product', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.product.findUnique.mockResolvedValue({ id: 'p1', status: ProductStatus.DRAFT });
      await expect(service.register(dto, 'p1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('issueTokens', () => {
    it('issues an access token and persists a refresh row (impersonation never uses this path)', async () => {
      mockPrisma.refreshToken.create.mockResolvedValue({});
      const tokens = await service.issueTokens(client as never);
      expect(tokens.accessToken).toBe('jwt.token');
      expect(tokens.refreshToken).toBeTruthy();
      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: 'u1' }) }),
      );
    });
  });
});
