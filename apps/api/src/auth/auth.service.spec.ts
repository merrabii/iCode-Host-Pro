import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ProductStatus, Role } from '@prisma/client';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';

jest.mock('bcryptjs', () => ({
  compare: jest.fn(async () => true),
  hash: jest.fn(async (s: string) => `hashed:${s}`),
}));

describe('AuthService (impersonation + order-time registration, ADR-027)', () => {
  const mockPrisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    product: { findUnique: jest.fn() },
    refreshToken: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    passwordResetToken: {
      findUnique: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
      update: jest.fn(),
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
  const mockTurnstile = { verify: jest.fn(), isActive: jest.fn() };
  const mockMfa = { evaluateLogin: jest.fn() };
  const mockSettings = { isSelfRegistrationEnabled: jest.fn(), isTurnstileEnabled: jest.fn() };
  const mockMailSettings = { isEnabled: jest.fn(), sendPlain: jest.fn() };

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
      mockMailSettings as never,
    );
    jest.clearAllMocks();
    mockConfig.get.mockReturnValue(undefined);
    mockSettings.isSelfRegistrationEnabled.mockResolvedValue(true);
    mockMailSettings.isEnabled.mockResolvedValue(true);
    mockMailSettings.sendPlain.mockResolvedValue(undefined);
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

  describe('login — Turnstile enforcement (Phase 3, gated on the effective notion isActive)', () => {
    const creds = { email: 'client@example.com', password: 'pw' };
    const allowLogin = () => {
      mockLimiter.consume.mockReturnValue({ allowed: true });
      mockPrisma.user.findUnique.mockResolvedValue(client);
      mockMfa.evaluateLogin.mockResolvedValue({ status: 'pass' });
    };

    it('OFF (even with full keys present) → no Turnstile verification', async () => {
      mockTurnstile.isActive.mockResolvedValue(false);
      allowLogin();
      const res = (await service.login({ ...creds, turnstileToken: 'tok' }, '1.2.3.4')) as {
        accessToken: string;
      };
      expect(mockTurnstile.verify).not.toHaveBeenCalled();
      expect(res.accessToken).toBe('jwt.token');
    });

    it('ON + full config → token verified against Cloudflare', async () => {
      mockTurnstile.isActive.mockResolvedValue(true);
      mockTurnstile.verify.mockResolvedValue(true);
      allowLogin();
      const res = (await service.login({ ...creds, turnstileToken: 'tok' }, '1.2.3.4')) as {
        accessToken: string;
      };
      expect(mockTurnstile.verify).toHaveBeenCalledWith('tok', '1.2.3.4');
      expect(res.accessToken).toBe('jwt.token');
    });

    it('ON + incomplete config → no verification (coherent with a frontend without widget)', async () => {
      mockTurnstile.isActive.mockResolvedValue(false);
      allowLogin();
      const res = (await service.login(creds, '1.2.3.4')) as { accessToken: string };
      expect(mockTurnstile.verify).not.toHaveBeenCalled();
      expect(res.accessToken).toBe('jwt.token');
    });

    it('ON + full config but verification fails → login rejected (fail-closed)', async () => {
      mockTurnstile.isActive.mockResolvedValue(true);
      mockTurnstile.verify.mockResolvedValue(false);
      mockLimiter.consume.mockReturnValue({ allowed: true });
      await expect(
        service.login({ ...creds, turnstileToken: 'bad' }, '1.2.3.4'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockTurnstile.verify).toHaveBeenCalled();
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

  // ── GO socle (lot A1): password recovery ────────────────────────────────────
  describe('requestPasswordReset (no enumeration, token hashed at rest)', () => {
    it('unknown email: identical { ok: true }, no token row, no mail, audited found:false', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.requestPasswordReset('ghost@example.com')).resolves.toEqual({ ok: true });
      expect(mockPrisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(mockMailSettings.sendPlain).not.toHaveBeenCalled();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.password.reset_requested',
          details: expect.objectContaining({ found: false }),
        }),
      );
    });

    it('known email: sha256-only row, mail carries the raw link, previous links superseded', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'user@example.com' });
      mockPrisma.passwordResetToken.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.passwordResetToken.create.mockResolvedValue({});
      await expect(service.requestPasswordReset('user@example.com')).resolves.toEqual({ ok: true });

      expect(mockPrisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', usedAt: null },
      });
      const created = mockPrisma.passwordResetToken.create.mock.calls[0][0].data;
      expect(created.tokenHash).toHaveLength(64); // sha256 hex
      expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const msg = mockMailSettings.sendPlain.mock.calls[0][0];
      const raw = /token=([A-Za-z0-9_-]+)/.exec(msg.text)?.[1];
      expect(raw).toBeTruthy();
      expect(created.tokenHash).toBe(
        createHash('sha256').update(raw!).digest('hex'),
      );
      expect(created.tokenHash).not.toBe(raw); // raw never stored
      expect(msg.to).toBe('user@example.com');
    });

    it('mail disabled: still { ok: true }, no send, audit emailSent:false', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'user@example.com' });
      mockMailSettings.isEnabled.mockResolvedValue(false);
      await expect(service.requestPasswordReset('user@example.com')).resolves.toEqual({ ok: true });
      expect(mockMailSettings.sendPlain).not.toHaveBeenCalled();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ details: expect.objectContaining({ emailSent: false }) }),
      );
    });

    it('send failure: response never changes (anti-enum), only the audit flips', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'user@example.com' });
      mockMailSettings.sendPlain.mockRejectedValue(new Error('smtp down'));
      await expect(service.requestPasswordReset('user@example.com')).resolves.toEqual({ ok: true });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ details: expect.objectContaining({ emailSent: false }) }),
      );
    });

    it('never journals the raw token nor a password', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'user@example.com' });
      await service.requestPasswordReset('user@example.com');
      const msg = mockMailSettings.sendPlain.mock.calls[0][0];
      const raw = /token=([A-Za-z0-9_-]+)/.exec(msg.text)?.[1];
      const auditDump = JSON.stringify(mockAudit.record.mock.calls);
      expect(auditDump).not.toContain(raw!);
      expect(auditDump).not.toContain(msg.text);
    });
  });

  describe('resetPassword (single-use, generic 400, sessions revoked)', () => {
    const rawToken = 'one-time-raw-token';
    const record = {
      id: 'pr1',
      userId: 'u1',
      usedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 60_000),
    };

    it('short password: 400 BEFORE burning the token', async () => {
      await expect(service.resetPassword(rawToken, 'short')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockPrisma.passwordResetToken.findUnique).not.toHaveBeenCalled();
    });

    it('valid token: password updated, token consumed, ALL refresh tokens revoked, audited', async () => {
      mockPrisma.passwordResetToken.findUnique.mockResolvedValue(record);
      mockPrisma.user.findUnique.mockResolvedValue({ ...client, passwordHash: 'old' });
      mockPrisma.passwordResetToken.update.mockResolvedValue({});
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });
      // Override the register-test implementation left in place by clearAllMocks.
      mockPrisma.$transaction.mockResolvedValue(undefined);

      await expect(service.resetPassword(rawToken, 'new-password-1')).resolves.toEqual({ ok: true });

      expect(mockPrisma.passwordResetToken.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { usedAt: expect.any(Date) } }),
      );
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { passwordHash: 'hashed:new-password-1' } }),
      );
      expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1', revokedAt: null } }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.password.reset', actorId: 'u1' }),
      );
      const dump = JSON.stringify(mockAudit.record.mock.calls);
      expect(dump).not.toContain('new-password-1');
      expect(dump).not.toContain(rawToken);
    });

    it('unknown / used / expired all yield the SAME generic 400 (no oracle)', async () => {
      const generic = 'Lien de réinitialisation invalide ou expiré.';
      const outcomes: unknown[] = [];

      mockPrisma.passwordResetToken.findUnique.mockResolvedValueOnce(null);
      await service.resetPassword('bad', 'long-enough-1').catch((e) => outcomes.push(e.message));

      mockPrisma.passwordResetToken.findUnique.mockResolvedValueOnce({
        ...record,
        usedAt: new Date(),
      });
      await service.resetPassword(rawToken, 'long-enough-1').catch((e) => outcomes.push(e.message));

      mockPrisma.passwordResetToken.findUnique.mockResolvedValueOnce({
        ...record,
        expiresAt: new Date(Date.now() - 1000),
      });
      await service.resetPassword(rawToken, 'long-enough-1').catch((e) => outcomes.push(e.message));

      expect(outcomes).toEqual([generic, generic, generic]);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });
});
