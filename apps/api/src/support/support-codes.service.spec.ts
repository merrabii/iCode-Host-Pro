import { createHmac } from 'crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { SupportCodesService } from './support-codes.service';

const PEPPER = 'test-pepper';
const hashWithPepper = (code: string) =>
  createHmac('sha256', PEPPER).update(code).digest('hex');

describe('SupportCodesService (6-digit access codes, ADR-027)', () => {
  const mockPrisma = {
    $transaction: jest.fn(),
    supportCode: {
      updateMany: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };
  const mockConfig = { get: jest.fn() };
  const mockAudit = { record: jest.fn() };
  const mockMail = { canSend: jest.fn(), sendOtpMail: jest.fn() };
  const mockAuth = { impersonate: jest.fn() };

  let service: SupportCodesService;
  beforeEach(() => {
    service = new SupportCodesService(
      mockPrisma as never,
      mockConfig as never,
      mockAudit as never,
      mockMail as never,
      mockAuth as never,
    );
    jest.clearAllMocks();
    mockConfig.get.mockImplementation((k: string) => {
      if (k === 'supportCodeTtlMinutes') return 60;
      if (k === 'supportCodePepper') return PEPPER;
      return undefined;
    });
  });

  const client = { sub: 'u1', email: 'client@example.com', role: Role.USER };
  const actor = { sub: 'l2', email: 'l2@example.com' };

  describe('generate', () => {
    it('creates a 6-digit code, stores only its HMAC digest and revokes the previous one atomically', async () => {
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
      mockPrisma.supportCode.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.supportCode.create.mockResolvedValue({
        id: 'sc1',
        userId: 'u1',
        codeHash: 'digest',
      });
      mockMail.canSend.mockResolvedValue(false);

      const res = await service.generate(client);
      expect(res.code).toMatch(/^\d{6}$/);
      expect(res.expiresAt).toBeTruthy();
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.supportCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'u1', revokedAt: null }),
        }),
      );
      const createData = mockPrisma.supportCode.create.mock.calls[0][0].data;
      expect(createData.codeHash).not.toBe(res.code); // never stored in clear
      expect(createData.codeHash).toBe(hashWithPepper(res.code));
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'support.code.generate' }),
      );
    });

    it('emails the code best-effort and audits the delivery outcome', async () => {
      mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
      mockPrisma.supportCode.create.mockResolvedValue({ id: 'sc2', userId: 'u1' });
      mockMail.canSend.mockResolvedValue(true);
      mockMail.sendOtpMail.mockResolvedValue(undefined);

      await service.generate(client);
      expect(mockMail.sendOtpMail).toHaveBeenCalledWith(
        'client@example.com',
        expect.stringMatching(/^\d{6}$/),
        'support',
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'support.code.email' }),
      );
    });
  });

  describe('status / revoke', () => {
    it('status reports the active code expiry (never the code)', async () => {
      mockPrisma.supportCode.findFirst.mockResolvedValue({
        expiresAt: new Date('2026-09-02T01:00:00Z'),
      });
      await expect(service.status('u1')).resolves.toEqual({
        active: true,
        expiresAt: '2026-09-02T01:00:00.000Z',
      });
    });

    it('status reports inactive when nothing is active', async () => {
      mockPrisma.supportCode.findFirst.mockResolvedValue(null);
      await expect(service.status('u1')).resolves.toEqual({ active: false, expiresAt: null });
    });

    it('revoke audits only when something was actually revoked', async () => {
      mockPrisma.supportCode.updateMany.mockResolvedValue({ count: 1 });
      await expect(service.revoke(client)).resolves.toEqual({ revoked: true });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'support.code.revoke' }),
      );
      mockPrisma.supportCode.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.revoke(client)).resolves.toEqual({ revoked: false });
    });
  });

  describe('redeem (support L2+)', () => {
    function codeRow(over: Record<string, unknown> = {}) {
      return {
        id: 'sc1',
        userId: 'u1',
        codeHash: hashWithPepper('123456'),
        expiresAt: new Date(Date.now() + 60_000),
        user: { id: 'u1', isActive: true },
        ...over,
      };
    }

    it('rejects a malformed code', async () => {
      await expect(service.redeem('abc', actor)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockPrisma.supportCode.findMany).not.toHaveBeenCalled();
    });

    it('rejects a code matching nothing (full timing-safe pass, no impersonation)', async () => {
      mockPrisma.supportCode.findMany.mockResolvedValue([codeRow()]);
      await expect(service.redeem('999999', actor)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockAuth.impersonate).not.toHaveBeenCalled();
    });

    it('redeems a correct code and opens a read-only support impersonation of its owner', async () => {
      mockPrisma.supportCode.findMany.mockResolvedValue([codeRow()]);
      mockPrisma.supportCode.update.mockResolvedValue({});
      mockAuth.impersonate.mockResolvedValue({ accessToken: 'imp.jwt' });
      await expect(service.redeem('123456', actor)).resolves.toEqual({ accessToken: 'imp.jwt' });
      expect(mockPrisma.supportCode.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sc1' }, data: { attempts: 0 } }),
      );
      expect(mockAuth.impersonate).toHaveBeenCalledWith('u1', actor, 'support');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'support.code.redeem' }),
      );
    });

    it('refuses to redeem a code whose owner is disabled', async () => {
      mockPrisma.supportCode.findMany.mockResolvedValue([
        codeRow({ user: { id: 'u1', isActive: false } }),
      ]);
      await expect(service.redeem('123456', actor)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
