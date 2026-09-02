import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { MfaService } from './mfa.service';
import { MfaChallengeStore } from './mfa-challenge.store';
import { totp } from './totp';

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  // Deterministic 6-digit codes for the email-OTP path.
  randomInt: jest.fn(() => 123456),
}));

jest.mock('bcryptjs', () => ({
  compare: jest.fn(async () => true),
  hash: jest.fn(async (s: string) => `hashed:${s}`),
}));

jest.mock('./totp', () => ({
  totp: {
    generateSecret: jest.fn(() => 'BASE32SECRET'),
    check: jest.fn(() => true),
    keyuri: jest.fn(
      (label: string, issuer: string, secret: string) =>
        `otpauth://totp/${issuer}:${label}?secret=${secret}`,
    ),
  },
}));

describe('MfaService (TOTP + email OTP, ADR-027)', () => {
  const mockPrisma = { user: { findUnique: jest.fn(), update: jest.fn() } };
  const mockCrypto = {
    encrypt: jest.fn((s: string) => `enc:${s}`),
    decrypt: jest.fn((s: string) => s.replace(/^enc:/, '')),
  };
  const mockConfig = { get: jest.fn() };
  const mockAudit = { record: jest.fn() };
  const mockSettings = { isMfaRequiredForAdmins: jest.fn() };
  const mockMail = { canSend: jest.fn(), sendOtpMail: jest.fn() };

  let service: MfaService;
  let store: MfaChallengeStore;

  beforeEach(() => {
    store = new MfaChallengeStore();
    service = new MfaService(
      mockPrisma as never,
      mockCrypto as never,
      mockConfig as never,
      mockAudit as never,
      mockSettings as never,
      mockMail as never,
      store,
    );
    jest.clearAllMocks();
    (totp.check as jest.Mock).mockReturnValue(true);
    mockSettings.isMfaRequiredForAdmins.mockResolvedValue(false);
    mockMail.canSend.mockResolvedValue(false);
  });

  const user = (over: Record<string, unknown> = {}) =>
    ({
      id: 'u1',
      email: 'u@example.com',
      role: Role.USER,
      mfaEnabled: false,
      mfaSecretEnc: null,
      passwordHash: 'hash',
      ...over,
    }) as never;

  describe('evaluateLogin', () => {
    it('opens a TOTP challenge when MFA is enabled', async () => {
      const out = await service.evaluateLogin(user({ mfaEnabled: true }));
      expect(out.status).toBe('verify');
      if (out.status === 'verify') {
        expect(out.methods).toContain('totp');
        expect(out.challengeId).toBeTruthy();
      }
    });

    it('adds the email method when the mail channel is available', async () => {
      mockMail.canSend.mockResolvedValue(true);
      const out = await service.evaluateLogin(user({ mfaEnabled: true }));
      expect(out.status).toBe('verify');
      if (out.status === 'verify') expect(out.methods).toEqual(['totp', 'email']);
    });

    it('forces enroll when the admin policy applies to an admin without MFA', async () => {
      mockSettings.isMfaRequiredForAdmins.mockResolvedValue(true);
      await expect(service.evaluateLogin(user({ role: Role.ADMIN }))).resolves.toEqual({
        status: 'enroll',
      });
    });

    it('passes straight through when no MFA and no admin policy', async () => {
      await expect(service.evaluateLogin(user())).resolves.toEqual({ status: 'pass' });
    });
  });

  describe('verify (2-step login)', () => {
    it('rejects an unknown challenge', async () => {
      await expect(service.verify('nope', '123456', 'totp')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('verifies a correct TOTP code, consumes the challenge and audits', async () => {
      const out = await service.evaluateLogin(user({ mfaEnabled: true, mfaSecretEnc: 'enc:s' }));
      expect(out.status).toBe('verify');
      if (out.status !== 'verify') throw new Error('expected verify');
      mockPrisma.user.findUnique.mockResolvedValue(user({ mfaEnabled: true, mfaSecretEnc: 'enc:s' }));

      await expect(service.verify(out.challengeId, '123456', 'totp')).resolves.toMatchObject({
        id: 'u1',
      });
      expect(store.get(out.challengeId)).toBeUndefined(); // single-use
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.mfa.verify', details: { method: 'totp' } }),
      );
    });

    it('locks the challenge out after 5 wrong codes (destroyed)', async () => {
      const out = await service.evaluateLogin(user({ mfaEnabled: true, mfaSecretEnc: 'enc:s' }));
      expect(out.status).toBe('verify');
      if (out.status !== 'verify') throw new Error('expected verify');
      mockPrisma.user.findUnique.mockResolvedValue(user({ mfaEnabled: true, mfaSecretEnc: 'enc:s' }));
      (totp.check as jest.Mock).mockReturnValue(false);

      for (let i = 0; i < 5; i++) {
        await expect(service.verify(out.challengeId, '000000', 'totp')).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      }
      expect(store.get(out.challengeId)).toBeUndefined();
    });

    it('sends an email OTP and verifies it (deterministic code 123456)', async () => {
      const out = await service.evaluateLogin(user({ mfaEnabled: true }));
      expect(out.status).toBe('verify');
      if (out.status !== 'verify') throw new Error('expected verify');
      mockPrisma.user.findUnique.mockResolvedValue(user({ mfaEnabled: true }));

      await expect(service.sendEmailOtp(out.challengeId)).resolves.toMatchObject({ sent: true });
      expect(mockMail.sendOtpMail).toHaveBeenCalledWith(
        'u@example.com',
        '123456',
        'mfa',
      );

      await expect(service.verify(out.challengeId, '123456', 'email')).resolves.toMatchObject({
        id: 'u1',
      });
      expect(store.get(out.challengeId)).toBeUndefined();
    });

    it('rejects a wrong email OTP without consuming the challenge', async () => {
      const out = await service.evaluateLogin(user({ mfaEnabled: true }));
      expect(out.status).toBe('verify');
      if (out.status !== 'verify') throw new Error('expected verify');
      mockPrisma.user.findUnique.mockResolvedValue(user({ mfaEnabled: true }));
      await service.sendEmailOtp(out.challengeId);
      await expect(service.verify(out.challengeId, '000000', 'email')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(store.get(out.challengeId)).toBeDefined();
    });
  });

  describe('setup / confirm / disable (self-service)', () => {
    it('setup refuses a wrong password', async () => {
      const { compare } = jest.requireMock<{ compare: jest.Mock }>('bcryptjs');
      compare.mockResolvedValueOnce(false);
      mockPrisma.user.findUnique.mockResolvedValue(user());
      await expect(service.setupTOTP('u1', 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('setup refuses when MFA is already active', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user({ mfaEnabled: true }));
      await expect(service.setupTOTP('u1', 'pass')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('setup stores an encrypted secret and returns secret + uri', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user());
      mockPrisma.user.update.mockResolvedValue(user());
      const res = await service.setupTOTP('u1', 'pass');
      expect(res.secret).toBe('BASE32SECRET');
      expect(res.uri).toContain('otpauth://totp/');
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { mfaSecretEnc: 'enc:BASE32SECRET' },
      });
    });

    it('confirm activates MFA and audits', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        user({ mfaEnabled: false, mfaSecretEnc: 'enc:BASE32SECRET' }),
      );
      mockPrisma.user.update.mockResolvedValue(user({ mfaEnabled: true }));
      await expect(service.confirmTOTP('u1', '123456')).resolves.toEqual({ mfaEnabled: true });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'mfa.enable' }),
      );
    });

    it('confirm refuses when no secret is pending', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user());
      await expect(service.confirmTOTP('u1', '123456')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('confirm refuses a wrong TOTP code', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        user({ mfaEnabled: false, mfaSecretEnc: 'enc:BASE32SECRET' }),
      );
      (totp.check as jest.Mock).mockReturnValue(false);
      await expect(service.confirmTOTP('u1', '000000')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('disable requires an active MFA and a valid code', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user());
      await expect(service.disable('u1', 'pass', '123456')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      mockPrisma.user.findUnique.mockResolvedValue(
        user({ mfaEnabled: true, mfaSecretEnc: 'enc:BASE32SECRET' }),
      );
      mockPrisma.user.update.mockResolvedValue(user({ mfaEnabled: false }));
      await expect(service.disable('u1', 'pass', '123456')).resolves.toEqual({ mfaEnabled: false });
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { mfaEnabled: false, mfaSecretEnc: null },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'mfa.disable' }),
      );
    });
  });

  describe('adminReset (recovery)', () => {
    it('refuses an unknown account', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.adminReset('nope', { sub: 'a1', email: 'a@example.com' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('clears MFA and audits the recovery', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user({ mfaEnabled: true }));
      mockPrisma.user.update.mockResolvedValue(user({ mfaEnabled: false }));
      const actor = { sub: 'a1', email: 'a@example.com' };
      await expect(service.adminReset('u1', actor)).resolves.toEqual({ mfaEnabled: false });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'mfa.admin-reset', actorId: 'a1' }),
      );
    });
  });
});
