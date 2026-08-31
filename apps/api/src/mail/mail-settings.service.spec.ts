import { BadRequestException } from '@nestjs/common';
import { MailCryptoError } from '../crypto/crypto.service';
import { MailException } from './mail.service';
import { MailSettingsService } from './mail-settings.service';

describe('MailSettingsService (Phase 6, ADR-022)', () => {
  const mockPrisma = { mailSetting: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() } };
  const mockCrypto = { encrypt: jest.fn(), decrypt: jest.fn() };
  const mockMail = { sendMail: jest.fn(), buildInviteMessage: jest.fn() };
  const mockAudit = { record: jest.fn() };
  const actor = { sub: 'admin', email: 'admin@example.com' };
  let service: MailSettingsService;

  const baseRow = (over: Record<string, unknown> = {}) => ({
    id: 'm1',
    enabled: false,
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: null,
    passwordEnc: null,
    fromEmail: 'from@example.com',
    fromName: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    mockPrisma.mailSetting.findFirst.mockReset();
    mockPrisma.mailSetting.create.mockReset();
    mockPrisma.mailSetting.update.mockReset();
    mockCrypto.encrypt.mockReset();
    mockCrypto.decrypt.mockReset();
    mockMail.sendMail.mockReset();
    mockMail.buildInviteMessage.mockReset();
    mockAudit.record.mockReset();
    service = new MailSettingsService(
      mockPrisma as never,
      mockCrypto as never,
      mockMail as never,
      mockAudit as never,
    );
  });

  describe('get', () => {
    it('returns masked defaults when no row exists', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(null);
      const view = await service.get();
      expect(view).toMatchObject({
        id: null,
        enabled: false,
        host: null,
        port: 587,
        hasPassword: false,
      });
      expect('passwordEnc' in view).toBe(false); // never exposed
    });

    it('masks the row — password never returned, only hasPassword', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(
        baseRow({ enabled: true, passwordEnc: 'iv-tag-cipher', user: 'u' }),
      );
      const view = await service.get();
      expect(view.enabled).toBe(true);
      expect(view.hasPassword).toBe(true);
      expect(view.user).toBe('u');
      expect(JSON.stringify(view)).not.toContain('iv-tag-cipher');
      expect('passwordEnc' in view).toBe(false);
    });
  });

  describe('isEnabled', () => {
    it('returns the enabled flag (false when no row)', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(null);
      await expect(service.isEnabled()).resolves.toBe(false);
      mockPrisma.mailSetting.findFirst.mockResolvedValue(baseRow({ enabled: false }));
      await expect(service.isEnabled()).resolves.toBe(false);
      mockPrisma.mailSetting.findFirst.mockResolvedValue(baseRow({ enabled: true }));
      await expect(service.isEnabled()).resolves.toBe(true);
    });
  });

  describe('update', () => {
    it('encrypts a new password, stores it, and never echoes it (hasPassword only)', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(baseRow());
      mockCrypto.encrypt.mockReturnValue('iv-tag-cipher');
      mockPrisma.mailSetting.update.mockImplementation(async ({ data }) =>
        baseRow({ passwordEnc: data.passwordEnc }),
      );

      const view = await service.update({ password: 'hunter2' }, actor);

      expect(mockCrypto.encrypt).toHaveBeenCalledWith('hunter2');
      expect(mockPrisma.mailSetting.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({ passwordEnc: 'iv-tag-cipher' }),
      });
      expect(view.hasPassword).toBe(true);
      expect(JSON.stringify(view)).not.toContain('hunter2');
      expect(JSON.stringify(view)).not.toContain('iv-tag-cipher');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'mail.settings.update',
          details: expect.objectContaining({ hasPassword: true }),
        }),
      );
      const audit = mockAudit.record.mock.calls.find((c) => c[0].action === 'mail.settings.update')[0];
      expect(audit.details).not.toHaveProperty('password');
    });

    it('empty password = unchanged (no re-encrypt, no write)', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(baseRow({ passwordEnc: 'existing' }));
      const view = await service.update({ password: '' }, actor);
      expect(mockCrypto.encrypt).not.toHaveBeenCalled();
      expect(mockPrisma.mailSetting.update).not.toHaveBeenCalled();
      expect(view.hasPassword).toBe(true);
    });

    it("' user/fromName clear the nullable fields to null", async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(baseRow({ user: 'old', fromName: 'Old Name' }));
      mockPrisma.mailSetting.update.mockImplementation(async ({ data }) =>
        baseRow({ user: data.user, fromName: data.fromName }),
      );
      await service.update({ user: '', fromName: '' }, actor);
      expect(mockPrisma.mailSetting.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({ user: null, fromName: null }),
      });
    });

    it('refuses to enable without host+fromEmail', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(null);
      await expect(service.update({ enabled: true, host: 'smtp.x.com' }, actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.update({ enabled: true }, actor)).rejects.toThrow(
        'host et fromEmail sont requis',
      );
    });

    it('creates the singleton row on first save (host + fromEmail)', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(null);
      mockPrisma.mailSetting.create.mockImplementation(async ({ data }) =>
        baseRow({
          host: data.host,
          fromEmail: data.fromEmail,
          port: data.port,
          secure: data.secure,
          enabled: data.enabled,
        }),
      );
      const view = await service.update({ host: 'smtp.google.com', fromEmail: 'a@b.com', port: 465 }, actor);
      expect(mockPrisma.mailSetting.create).toHaveBeenCalled();
      expect(view.host).toBe('smtp.google.com');
      expect(view.port).toBe(465);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'mail.settings.update', resourceType: 'mailSetting' }),
      );
    });

    it('surfaces a missing ENCRYPTION_KEY as a 400', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(null);
      mockCrypto.encrypt.mockImplementation(() => {
        throw new MailCryptoError('Clé de chiffrement manquante (ENCRYPTION_KEY) dans apps/api/.env');
      });
      await expect(
        service.update({ password: 'x', host: 'h', fromEmail: 'f@x.com' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.update({ password: 'x', host: 'h', fromEmail: 'f@x.com' }, actor),
      ).rejects.toThrow('ENCRYPTION_KEY');
    });
  });

  describe('getMailConfig', () => {
    it('decrypts the stored password into the transport config', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(
        baseRow({ user: 'smtp-user', passwordEnc: 'iv-tag-cipher' }),
      );
      mockCrypto.decrypt.mockReturnValue('plain-pass');
      const cfg = await service.getMailConfig();
      expect(cfg).toMatchObject({ host: 'smtp.example.com', port: 587, user: 'smtp-user' });
      expect(cfg.pass).toBe('plain-pass');
    });

    it('throws MailException when there is no usable config', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(null);
      await expect(service.getMailConfig()).rejects.toBeInstanceOf(MailException);
    });

    it('maps a decrypt failure to MailException', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(baseRow({ passwordEnc: 'x' }));
      mockCrypto.decrypt.mockImplementation(() => {
        throw new MailCryptoError('Clé de chiffrement manquante (ENCRYPTION_KEY)');
      });
      await expect(service.getMailConfig()).rejects.toBeInstanceOf(MailException);
    });
  });

  describe('test', () => {
    it('sends through the saved config and journals mail.test ok', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(baseRow());
      mockMail.sendMail.mockResolvedValue(undefined);
      const res = await service.test('me@example.com', actor);
      expect(res.ok).toBe(true);
      expect(res.message).toContain('me@example.com');
      expect(mockMail.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'smtp.example.com' }),
        expect.objectContaining({ to: 'me@example.com', subject: 'Test — iCode Host Pro' }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'mail.test', details: expect.objectContaining({ ok: true }) }),
      );
    });

    it('surfaces the SMTP error as a 400 and journals mail.test error', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(baseRow());
      mockMail.sendMail.mockRejectedValue(
        new MailException('535 5.7.8 Username and Password not accepted'),
      );
      await expect(service.test('me@example.com', actor)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.test('me@example.com', actor)).rejects.toThrow('535 5.7.8');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'mail.test',
          details: expect.objectContaining({ ok: false, error: '535 5.7.8 Username and Password not accepted' }),
        }),
      );
    });

    it('refuses the test when no config is saved', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(null);
      await expect(service.test('me@example.com', actor)).rejects.toThrow(
        'Configuration mail non définie',
      );
    });
  });

  describe('sendInvitationMail', () => {
    it('builds the invite message and sends it through the saved config', async () => {
      mockPrisma.mailSetting.findFirst.mockResolvedValue(baseRow());
      mockMail.buildInviteMessage.mockReturnValue({ to: 'g@x', subject: 'S', text: 'B' });
      mockMail.sendMail.mockResolvedValue(undefined);
      await service.sendInvitationMail({ to: 'guest@x.com', token: 'tok', email: 'guest@x.com' });
      expect(mockMail.buildInviteMessage).toHaveBeenCalledWith({
        to: 'guest@x.com',
        token: 'tok',
        email: 'guest@x.com',
      });
      expect(mockMail.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'smtp.example.com' }),
        { to: 'g@x', subject: 'S', text: 'B' },
      );
    });
  });
});
