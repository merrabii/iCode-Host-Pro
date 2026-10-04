import {
  BadRequestException,
  ConflictException,
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

const bcryptMock = jest.requireMock('bcryptjs') as { compare: jest.Mock; hash: jest.Mock };

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
      updateMany: jest.fn(),
    },
    emailChangeToken: {
      findUnique: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
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
    // clearAllMocks ne remet PAS les implémentations : on reprend la main sur
    // $transaction (chaque bloc pose la sienne : fonction interactive vs tableau).
    mockPrisma.$transaction.mockReset();
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

  // ── GO Q3: reset atomique (CAS usage unique + expiration dans la tx) ───────
  describe('resetPassword (atomic single-use CAS, generic 400, sessions destroyed)', () => {
    const rawToken = 'one-time-raw-token';
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const record = {
      id: 'pr1',
      userId: 'u1',
      tokenHash,
      usedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 60_000),
    };

    /** Tx « heureuse » : CAS count 1, puis écritures. */
    const happyTx = () => {
      const tx = {
        passwordResetToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        user: { update: jest.fn().mockResolvedValue({}) },
        refreshToken: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
      };
      mockPrisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) =>
        cb(tx),
      );
      return tx;
    };

    /** Tx « perdante » : le CAS retourne count 0 (déjà consommé / expiré en DB). */
    const losingTx = () => {
      const tx = {
        passwordResetToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        user: { update: jest.fn() },
        refreshToken: { deleteMany: jest.fn() },
      };
      mockPrisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) =>
        cb(tx),
      );
      return tx;
    };

    it('short password: 400 BEFORE burning the token', async () => {
      await expect(service.resetPassword(rawToken, 'short')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockPrisma.passwordResetToken.findUnique).not.toHaveBeenCalled();
    });

    it('valid token: CAS consumption + password + session destruction in ONE tx, audited', async () => {
      mockPrisma.passwordResetToken.findUnique.mockResolvedValue(record);
      mockPrisma.user.findUnique.mockResolvedValue({ ...client, passwordHash: 'old' });
      const tx = happyTx();

      await expect(service.resetPassword(rawToken, 'new-password-1')).resolves.toEqual({ ok: true });

      // CAS conditionnel : usage unique + expiration revérifiés DANS la tx.
      expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: {
          tokenHash,
          usedAt: null,
          expiresAt: { gt: expect.any(Date) },
        },
        data: { usedAt: expect.any(Date) },
      });
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { passwordHash: 'hashed:new-password-1' },
      });
      expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.password.reset', actorId: 'u1' }),
      );
      const dump = JSON.stringify(mockAudit.record.mock.calls);
      expect(dump).not.toContain('new-password-1');
      expect(dump).not.toContain(rawToken);
    });

    it('concurrent loser (CAS count 0): generic 400, NO password write, NO reset audit', async () => {
      mockPrisma.passwordResetToken.findUnique.mockResolvedValue(record);
      mockPrisma.user.findUnique.mockResolvedValue({ ...client, passwordHash: 'old' });
      const tx = losingTx();

      await expect(service.resetPassword(rawToken, 'new-password-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.refreshToken.deleteMany).not.toHaveBeenCalled();
      const actions = mockAudit.record.mock.calls.map((c) => c[0]?.action);
      expect(actions).not.toContain('auth.password.reset');
    });

    it('unknown / used / expired all yield the SAME generic 400 (no oracle)', async () => {
      const generic = 'Lien de réinitialisation invalide ou expiré.';
      const outcomes: unknown[] = [];

      // Inconnu : échec avant toute écriture (pre-read négatif).
      mockPrisma.passwordResetToken.findUnique.mockResolvedValueOnce(null);
      await service.resetPassword('bad', 'long-enough-1').catch((e) => outcomes.push(e.message));

      // Déjà consommé : pre-read trouve la ligne, le CAS tranche (count 0) en tx.
      mockPrisma.passwordResetToken.findUnique.mockResolvedValueOnce({
        ...record,
        usedAt: new Date(),
      });
      losingTx();
      await service.resetPassword(rawToken, 'long-enough-1').catch((e) => outcomes.push(e.message));

      // Expiré : idem (le CAS exige expiresAt > now).
      mockPrisma.passwordResetToken.findUnique.mockResolvedValueOnce({
        ...record,
        expiresAt: new Date(Date.now() - 1000),
      });
      losingTx();
      await service.resetPassword(rawToken, 'long-enough-1').catch((e) => outcomes.push(e.message));

      expect(outcomes).toEqual([generic, generic, generic]);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ── GO Q3: rotation CAS, fenêtre de rejeu, isActive, session déconnectée ───
  describe('refresh (CAS rotation, reuse window, isActive, logout absence)', () => {
    const rt = {
      id: 'rt1',
      userId: 'u1',
      tokenHash: 'hash',
      revokedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 60_000),
    };

    it('active row: CAS rotation + audit auth.refresh + new pair', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(rt);
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.user.findUnique.mockResolvedValue(client);
      mockPrisma.refreshToken.create.mockResolvedValue({});

      const res = await service.refresh('raw-refresh');
      expect(res.accessToken).toBe('jwt.token');
      // Seule une ligne ENCORE ACTIVE peut être révoquée (CAS).
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'rt1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.refresh', actorId: 'u1' }),
      );
    });

    it('rotated <10 s ago (concurrent double-refresh) → reuse window: new pair, NO re-revoke', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        ...rt,
        revokedAt: new Date(Date.now() - 1_000),
      });
      mockPrisma.user.findUnique.mockResolvedValue(client);
      mockPrisma.refreshToken.create.mockResolvedValue({});

      const res = await service.refresh('raw-refresh');
      expect(res.accessToken).toBe('jwt.token');
      expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.refresh.reuse' }),
      );
    });

    it('rotated >10 s ago → 401 (stale reuse is not forgiven)', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        ...rt,
        revokedAt: new Date(Date.now() - 30_000),
      });
      await expect(service.refresh('raw-refresh')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.refresh.reuse' }),
      );
    });

    it('row ABSENT (destroyed by logout) → 401, never enters the reuse window', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(null);
      await expect(service.refresh('raw-refresh')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('expired row → 401', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        ...rt,
        expiresAt: new Date(Date.now() - 1_000),
      });
      await expect(service.refresh('raw-refresh')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('user deleted after rotation → 401', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(rt);
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.refresh('raw-refresh')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('disabled account → 401 even with a valid active row (admin kill-switch)', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(rt);
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.user.findUnique.mockResolvedValue({ ...client, isActive: false });
      await expect(service.refresh('raw-refresh')).rejects.toBeInstanceOf(UnauthorizedException);
      const actions = mockAudit.record.mock.calls.map((c) => c[0]?.action);
      expect(actions).not.toContain('auth.refresh');
    });

    it('CAS lost (count 0, concurrent winner) → reuse path issues a pair + audit', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(rt);
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.user.findUnique.mockResolvedValue(client);
      mockPrisma.refreshToken.create.mockResolvedValue({});

      const res = await service.refresh('raw-refresh');
      expect(res.accessToken).toBe('jwt.token');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.refresh.reuse' }),
      );
    });
  });

  // ── GO Q3: logout supprime la ligne (aucune ressuscitation) ────────────────
  describe('logout (deletes the session row — no resurrection)', () => {
    it('deletes the session row (not just revoking) + audits', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({ id: 'rt1', userId: 'u1' });
      mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.user.findUnique.mockResolvedValue(client);

      await service.logout('raw-refresh');
      expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { tokenHash: createHash('sha256').update('raw-refresh').digest('hex') },
      });
      expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.logout', actorId: 'u1' }),
      );
    });

    it('unknown token: idempotent no-op, no audit', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(null);
      mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.logout('raw-refresh')).resolves.toBeUndefined();
      expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });
  });

  // ── GO Q3: changement de mot de passe détruit toutes les sessions ──────────
  describe('changePassword (kills ALL active sessions)', () => {
    it('wrong current password → 401, no write', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(client);
      bcryptMock.compare.mockResolvedValueOnce(false);
      await expect(service.changePassword('u1', 'bad', 'new-password-1')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('short new password → 400 before any write', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(client);
      await expect(service.changePassword('u1', 'current', 'short')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('success: password updated AND every active session destroyed in one tx, audited', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...client, passwordHash: 'old' });
      mockPrisma.$transaction.mockResolvedValue(undefined);

      await expect(service.changePassword('u1', 'current', 'new-password-1')).resolves.toEqual({
        ok: true,
      });
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { passwordHash: 'hashed:new-password-1' },
      });
      expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.password.change',
          details: { sessionsRevoked: true },
        }),
      );
    });
  });

  // ── GO Q3: changement d'email (demande + confirmation atomique) ────────────
  describe('requestEmailChange (verification mail to the NEW address)', () => {
    it('supersedes pending tokens, stores sha256, mails the NEW address, audits', async () => {
      mockPrisma.emailChangeToken.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.emailChangeToken.create.mockImplementation(
        async (args: { data: Record<string, unknown> }) => ({ id: 'ec1', ...args.data }),
      );

      const res = await service.requestEmailChange(
        { id: 'u1', email: 'old@example.com' },
        'new@example.com',
      );
      expect(res.pendingEmail).toBe('new@example.com');
      expect(mockPrisma.emailChangeToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', usedAt: null },
      });
      const created = mockPrisma.emailChangeToken.create.mock.calls[0][0].data as {
        tokenHash: string;
        newEmail: string;
        expiresAt: Date;
      };
      expect(created.tokenHash).toHaveLength(64); // sha256 hex
      expect(created.newEmail).toBe('new@example.com');
      expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const msg = mockMailSettings.sendPlain.mock.calls[0][0];
      expect(msg.to).toBe('new@example.com'); // recipient is the NEW address
      const raw = /token=([A-Za-z0-9_-]+)/.exec(msg.text)?.[1];
      expect(raw).toBeTruthy();
      expect(created.tokenHash).toBe(createHash('sha256').update(raw!).digest('hex'));
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.email.change_requested',
          details: expect.objectContaining({ newEmail: 'new@example.com' }),
        }),
      );
    });

    it('mail failure: response unchanged, emailSent:false in audit', async () => {
      mockPrisma.emailChangeToken.create.mockImplementation(
        async (args: { data: Record<string, unknown> }) => ({ id: 'ec1', ...args.data }),
      );
      mockMailSettings.sendPlain.mockRejectedValueOnce(new Error('smtp down'));
      await expect(
        service.requestEmailChange({ id: 'u1', email: 'old@example.com' }, 'new@example.com'),
      ).resolves.toMatchObject({ pendingEmail: 'new@example.com' });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({ emailSent: false }),
        }),
      );
    });

    it('never journals the raw token', async () => {
      mockPrisma.emailChangeToken.create.mockImplementation(
        async (args: { data: Record<string, unknown> }) => ({ id: 'ec1', ...args.data }),
      );
      await service.requestEmailChange(
        { id: 'u1', email: 'old@example.com' },
        'new@example.com',
      );
      const msg = mockMailSettings.sendPlain.mock.calls[0][0];
      const raw = /token=([A-Za-z0-9_-]+)/.exec(msg.text)?.[1];
      const dump = JSON.stringify(mockAudit.record.mock.calls);
      expect(dump).not.toContain(raw!);
      expect(dump).not.toContain(msg.text);
    });
  });

  describe('confirmEmailChange (atomic single-use CAS)', () => {
    const ecRecord = {
      id: 'ec1',
      userId: 'u1',
      tokenHash: createHash('sha256').update('raw-email-token').digest('hex'),
      newEmail: 'new@example.com',
      usedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 60_000),
    };

    it('unknown token → 400, no transaction', async () => {
      mockPrisma.emailChangeToken.findUnique.mockResolvedValue(null);
      await expect(service.confirmEmailChange('bad')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('CAS count 0 (already used / expired) → generic 400, email untouched', async () => {
      mockPrisma.emailChangeToken.findUnique.mockResolvedValue(ecRecord);
      const tx = {
        emailChangeToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        user: { update: jest.fn() },
      };
      mockPrisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) =>
        cb(tx),
      );

      await expect(service.confirmEmailChange('raw-email-token')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.user.update).not.toHaveBeenCalled();
      const actions = mockAudit.record.mock.calls.map((c) => c[0]?.action);
      expect(actions).not.toContain('auth.email.change_confirmed');
    });

    it('valid: consumes the token AND switches the email inside ONE tx, audited', async () => {
      mockPrisma.emailChangeToken.findUnique.mockResolvedValue(ecRecord);
      const tx = {
        emailChangeToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        user: { update: jest.fn().mockResolvedValue({ email: 'new@example.com' }) },
      };
      mockPrisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) =>
        cb(tx),
      );

      await expect(service.confirmEmailChange('raw-email-token')).resolves.toEqual({
        ok: true,
        email: 'new@example.com',
      });
      expect(tx.emailChangeToken.updateMany).toHaveBeenCalledWith({
        where: {
          tokenHash: ecRecord.tokenHash,
          usedAt: null,
          expiresAt: { gt: expect.any(Date) },
        },
        data: { usedAt: expect.any(Date) },
      });
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { email: 'new@example.com' },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.email.change_confirmed', actorId: 'u1' }),
      );
    });

    it('address taken between request and confirm → ConflictException, tx rolled back', async () => {
      mockPrisma.emailChangeToken.findUnique.mockResolvedValue(ecRecord);
      const tx = {
        emailChangeToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        user: {
          update: jest.fn().mockRejectedValue(
            Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
          ),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) =>
        cb(tx),
      );

      await expect(service.confirmEmailChange('raw-email-token')).rejects.toBeInstanceOf(
        ConflictException,
      );
      const actions = mockAudit.record.mock.calls.map((c) => c[0]?.action);
      expect(actions).not.toContain('auth.email.change_confirmed');
    });
  });
});
