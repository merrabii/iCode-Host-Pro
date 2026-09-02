import { TurnstileService } from './turnstile.service';

describe('TurnstileService (Cloudflare anti-bot, ADR-027)', () => {
  const mockConfig = { get: jest.fn() };

  beforeEach(() => {
    mockConfig.get.mockReset();
    mockConfig.get.mockReturnValue(undefined);
    global.fetch = jest.fn();
  });

  it('degrades safe: without a secret key the check is skipped (verify → true)', async () => {
    const svc = new TurnstileService(mockConfig as never);
    expect(svc.isConfigured()).toBe(false);
    await expect(svc.verify('tok', '1.2.3.4')).resolves.toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('isConfigured true when a secret key is present', () => {
    mockConfig.get.mockReturnValue('s3cret');
    const svc = new TurnstileService(mockConfig as never);
    expect(svc.isConfigured()).toBe(true);
  });

  it('returns true when Cloudflare reports success, forwarding secret/response/remoteip', async () => {
    mockConfig.get.mockImplementation((k: string) =>
      k === 'turnstileSecretKey' ? 's3cret' : undefined,
    );
    const svc = new TurnstileService(mockConfig as never);
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ success: true }) });
    await expect(svc.verify('tok', '1.2.3.4')).resolves.toBe(true);
    const body = (global.fetch as jest.Mock).mock.calls[0][1].body as URLSearchParams;
    expect(body.get('secret')).toBe('s3cret');
    expect(body.get('response')).toBe('tok');
    expect(body.get('remoteip')).toBe('1.2.3.4');
  });

  it('returns false on a failed verification or on any network error', async () => {
    mockConfig.get.mockImplementation((k: string) =>
      k === 'turnstileSecretKey' ? 's3cret' : undefined,
    );
    const svc = new TurnstileService(mockConfig as never);
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ success: false }) });
    await expect(svc.verify('tok')).resolves.toBe(false);
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    await expect(svc.verify('tok')).resolves.toBe(false);
  });
});
