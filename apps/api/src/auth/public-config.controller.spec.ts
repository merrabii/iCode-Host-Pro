import { PublicAuthConfigController } from './public-config.controller';

describe('PublicAuthConfigController (Phase 3 — turnstile runtime aligned with admin flag)', () => {
  const mockSettings = {
    getTurnstileSiteKey: jest.fn(),
    isOAuthGoogleEnabled: jest.fn(),
    isOAuthGithubEnabled: jest.fn(),
    isSelfRegistrationEnabled: jest.fn(),
    isDeployEnabled: jest.fn(),
  };
  const mockConfig = { get: jest.fn() };
  const mockTurnstile = { isActive: jest.fn(), getSiteKey: jest.fn() };

  const makeCtrl = () =>
    new PublicAuthConfigController(
      mockSettings as never,
      mockConfig as never,
      mockTurnstile as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.get.mockReturnValue(undefined);
    mockSettings.isOAuthGoogleEnabled.mockResolvedValue(false);
    mockSettings.isOAuthGithubEnabled.mockResolvedValue(false);
    mockSettings.isSelfRegistrationEnabled.mockResolvedValue(false);
    mockSettings.isDeployEnabled.mockResolvedValue(false);
  });

  // TEST 1 — flag OFF, keys present ⇒ Turnstile NOT exposed (not "active").
  it('TEST 1 — turnstile OFF (even with site key present) ⇒ site key not exposed', async () => {
    mockTurnstile.isActive.mockResolvedValue(false); // flag off ⇒ inactive
    const res = await makeCtrl().get();
    expect(res.turnstileSiteKey).toBe('');
    // Frontend therefore renders no widget → sends no token → backend skips.
  });

  // TEST 3 — flag ON + full config ⇒ ONLY the public data needed is exposed.
  it('TEST 3 — turnstile ON + valid config ⇒ exposes the PUBLIC site key only', async () => {
    mockTurnstile.isActive.mockResolvedValue(true);
    mockTurnstile.getSiteKey.mockResolvedValue('0x4AAA…');
    const res = await makeCtrl().get();
    expect(res.turnstileSiteKey).toBe('0x4AAA…');
  });

  // TEST 5 — the SECRET key is never part of the public payload.
  it('TEST 5 — secret key never present in public config', async () => {
    mockTurnstile.isActive.mockResolvedValue(true);
    mockTurnstile.getSiteKey.mockResolvedValue('0x4AAA…');
    const res = await makeCtrl().get();
    expect(res).not.toHaveProperty('turnstileSecretKey');
    expect(Object.keys(res).sort()).toEqual([
      'deployEnabled',
      'oauthGithubEnabled',
      'oauthGoogleEnabled',
      'selfRegistrationEnabled',
      'turnstileSiteKey',
    ]);
  });

  // TEST 8 — ON but incomplete config (backend cannot verify) ⇒ NOT exposed.
  it('TEST 8 — turnstile ON but incomplete (no secret) ⇒ NOT exposed, deterministic safe', async () => {
    mockTurnstile.isActive.mockResolvedValue(false); // site or secret missing ⇒ inactive
    const res = await makeCtrl().get();
    expect(res.turnstileSiteKey).toBe('');
  });

  // Non-régression — OAuth availability still gated on flag AND keys.
  it('OAuth availability is unchanged (flag AND env keys required)', async () => {
    mockSettings.isOAuthGithubEnabled.mockResolvedValue(true);
    mockConfig.get.mockImplementation((k: string) =>
      k === 'githubClientId' || k === 'githubClientSecret' ? 'key' : undefined,
    );
    const res = await makeCtrl().get();
    expect(res.oauthGithubEnabled).toBe(true);
    expect(res.oauthGoogleEnabled).toBe(false);
  });
});