import { TurnstileService } from './turnstile.service';

describe('TurnstileService (Cloudflare anti-bot, ADR-027)', () => {
  const mockConfig = { get: jest.fn() };
  const mockSettings = {
    getTurnstileSecretKey: jest.fn(),
    getTurnstileSiteKey: jest.fn(),
    isTurnstileEnabled: jest.fn(),
  };
  const makeSvc = () => new TurnstileService(mockConfig as never, mockSettings as never);

  beforeEach(() => {
    mockConfig.get.mockReset();
    mockConfig.get.mockReturnValue(undefined);
    mockSettings.getTurnstileSecretKey.mockReset();
    mockSettings.getTurnstileSecretKey.mockResolvedValue(null);
    mockSettings.getTurnstileSiteKey.mockReset();
    mockSettings.getTurnstileSiteKey.mockResolvedValue(null);
    mockSettings.isTurnstileEnabled.mockReset();
    mockSettings.isTurnstileEnabled.mockResolvedValue(true);
    global.fetch = jest.fn();
  });

  it('degrades safe: without a secret key the check is skipped (verify → true)', async () => {
    const svc = makeSvc();
    expect(svc.isConfigured()).toBe(false);
    await expect(svc.verify('tok', '1.2.3.4')).resolves.toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('isConfigured true when a secret key is present (env fallback)', () => {
    mockConfig.get.mockReturnValue('s3cret');
    const svc = makeSvc();
    expect(svc.isConfigured()).toBe(true);
  });

  it('the DB-stored secret (admin-managed) takes precedence over env', async () => {
    mockSettings.getTurnstileSecretKey.mockResolvedValue('db-secret');
    mockConfig.get.mockImplementation((k: string) =>
      k === 'turnstileSecretKey' ? 'env-secret' : undefined,
    );
    const svc = makeSvc();
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ success: true }) });
    await expect(svc.verify('tok')).resolves.toBe(true);
    const body = (global.fetch as jest.Mock).mock.calls[0][1].body as URLSearchParams;
    expect(body.get('secret')).toBe('db-secret');
  });

  it('returns true when Cloudflare reports success, forwarding secret/response/remoteip', async () => {
    mockSettings.getTurnstileSecretKey.mockResolvedValue('s3cret');
    const svc = makeSvc();
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ success: true }) });
    await expect(svc.verify('tok', '1.2.3.4')).resolves.toBe(true);
    const body = (global.fetch as jest.Mock).mock.calls[0][1].body as URLSearchParams;
    expect(body.get('secret')).toBe('s3cret');
    expect(body.get('response')).toBe('tok');
    expect(body.get('remoteip')).toBe('1.2.3.4');
  });

  it('returns false on a failed verification or on any network error', async () => {
    mockSettings.getTurnstileSecretKey.mockResolvedValue('s3cret');
    const svc = makeSvc();
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ success: false }) });
    await expect(svc.verify('tok')).resolves.toBe(false);
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    await expect(svc.verify('tok')).resolves.toBe(false);
  });

  describe('getSiteKey / isActive (Phase 3 — shared effective activation)', () => {
    it('getSiteKey: the DB admin site key wins over the env fallback', async () => {
      mockSettings.getTurnstileSiteKey.mockResolvedValue('db-site');
      mockConfig.get.mockImplementation((k: string) =>
        k === 'turnstileSiteKey' ? 'env-site' : undefined,
      );
      await expect(makeSvc().getSiteKey()).resolves.toBe('db-site');
    });

    it('getSiteKey: env fallback used when no DB site key', async () => {
      mockConfig.get.mockReturnValue('env-site');
      await expect(makeSvc().getSiteKey()).resolves.toBe('env-site');
    });

    it('getSiteKey: empty when neither DB nor env is configured', async () => {
      await expect(makeSvc().getSiteKey()).resolves.toBe('');
    });

    it('isActive = OFF (flag false) even with full keys ⇒ false', async () => {
      mockSettings.isTurnstileEnabled.mockResolvedValue(false);
      mockSettings.getTurnstileSiteKey.mockResolvedValue('site');
      mockSettings.getTurnstileSecretKey.mockResolvedValue('sec');
      await expect(makeSvc().isActive()).resolves.toBe(false);
    });

    it('isActive = ON + full config (site + secret) ⇒ true', async () => {
      mockSettings.getTurnstileSiteKey.mockResolvedValue('site');
      mockSettings.getTurnstileSecretKey.mockResolvedValue('sec');
      await expect(makeSvc().isActive()).resolves.toBe(true);
    });

    it('isActive = ON but missing SITE key ⇒ false (backend never demands an unproducible token)', async () => {
      mockSettings.getTurnstileSecretKey.mockResolvedValue('sec');
      await expect(makeSvc().isActive()).resolves.toBe(false);
    });

    it('isActive = ON but missing SECRET key ⇒ false', async () => {
      mockSettings.getTurnstileSiteKey.mockResolvedValue('site');
      await expect(makeSvc().isActive()).resolves.toBe(false);
    });

    it('isActive = ON with both keys via env only ⇒ true (resolution fully reused)', async () => {
      mockConfig.get.mockImplementation((k: string) =>
        k === 'turnstileSiteKey' ? 'env-site' : k === 'turnstileSecretKey' ? 'env-sec' : undefined,
      );
      await expect(makeSvc().isActive()).resolves.toBe(true);
    });
  });
});
