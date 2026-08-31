import { MailException, MailService } from './mail.service';

describe('MailService (Phase 6, ADR-022)', () => {
  const factory = { create: jest.fn() };
  const config = { get: jest.fn() };
  let service: MailService;
  let transporter: { sendMail: jest.Mock };

  const cfg = {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: 'smtp-user',
    pass: 'smtp-pass',
    fromEmail: 'from@example.com',
    fromName: 'iCode Host Pro',
  };

  beforeEach(() => {
    config.get.mockReturnValue(undefined); // default PUBLIC_BASE_URL localhost:3000
    transporter = { sendMail: jest.fn().mockResolvedValue(undefined) };
    factory.create.mockReturnValue(transporter);
    service = new MailService(factory as never, config as never);
  });

  describe('buildInviteMessage', () => {
    it('builds the FR invitation body with the one-time /auth link', () => {
      const msg = service.buildInviteMessage({
        to: 'guest@example.com',
        token: 'tok_123',
        email: 'guest@example.com',
      });
      expect(msg.to).toBe('guest@example.com');
      expect(msg.subject).toBe('Votre invitation — iCode Host Pro');
      expect(msg.text).toContain(
        'http://localhost:3000/auth?invite=tok_123&email=guest%40example.com',
      );
      expect(msg.text).toContain("qu'une seule fois");
    });

    it('uses PUBLIC_BASE_URL and strips a trailing slash', () => {
      config.get.mockReturnValue('https://host.example.com/');
      const msg = service.buildInviteMessage({
        to: 'guest@example.com',
        token: 'tok_9',
        email: 'guest@example.com',
      });
      expect(msg.text).toContain('https://host.example.com/auth?invite=tok_9');
      expect(msg.text).not.toContain('//auth');
    });
  });

  describe('sendMail', () => {
    it('creates the transporter from the config and sends (auth user)', async () => {
      await service.sendMail(cfg, { to: 'r@x.com', subject: 'S', text: 'B' });
      expect(factory.create).toHaveBeenCalledWith(cfg);
      expect(transporter.sendMail).toHaveBeenCalledWith({
        from: '"iCode Host Pro" <from@example.com>',
        to: 'r@x.com',
        subject: 'S',
        text: 'B',
      });
    });

    it('uses a bare from address when no display name', async () => {
      await service.sendMail({ ...cfg, fromName: null }, { to: 'r@x.com', subject: 'S', text: 'B' });
      expect(transporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'from@example.com' }),
      );
    });

    it('wraps a transport failure in MailException with the SMTP message', async () => {
      transporter.sendMail = jest.fn().mockRejectedValue(new Error('EHOSTUNREACH smtp.example.com'));
      await expect(
        service.sendMail(cfg, { to: 'r@x.com', subject: 'S', text: 'B' }),
      ).rejects.toBeInstanceOf(MailException);
      await expect(
        service.sendMail(cfg, { to: 'r@x.com', subject: 'S', text: 'B' }),
      ).rejects.toThrow('EHOSTUNREACH');
    });
  });
});
