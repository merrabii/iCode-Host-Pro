import { SecuritySettingsService } from './security-settings.service';

describe('SecuritySettingsService (singleton admin flags, ADR-027)', () => {
  const mockPrisma = {
    securitySetting: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  };
  const mockAudit = { record: jest.fn() };
  const mockCrypto = { encrypt: jest.fn((s: string) => `enc:${s}`), decrypt: jest.fn((s: string) => s.replace(/^enc:/, '')) };
  const actor = { sub: 'a1', email: 'admin@example.com' };

  const row = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    turnstileEnabled: false,
    turnstileSiteKey: null,
    turnstileSecretEnc: null,
    oauthGoogleEnabled: false,
    oauthGithubEnabled: false,
    mfaRequiredForAdmins: false,
    selfRegistrationEnabled: false,
    deployEnabled: false,
    orderStatusRateLimitEnabled: true,
    orderStatusRateLimitMax: 30,
    orderStatusRateLimitWindowSec: 60,
    createdAt: new Date('2026-09-02T00:00:00Z'),
    updatedAt: new Date('2026-09-02T00:00:00Z'),
    ...over,
  });

  let service: SecuritySettingsService;
  beforeEach(() => {
    service = new SecuritySettingsService(
      mockPrisma as never,
      mockAudit as never,
      mockCrypto as never,
    );
    jest.clearAllMocks();
  });

  it('returns all-off defaults when no row exists', async () => {
    mockPrisma.securitySetting.findFirst.mockResolvedValue(null);
    const view = await service.get();
    expect(view.id).toBeNull();
    expect(view.turnstileEnabled).toBe(false);
    expect(view.turnstileSiteKey).toBeNull();
    expect(view.turnstileHasSecretKey).toBe(false);
    expect(view.oauthGoogleEnabled).toBe(false);
    expect(view.oauthGithubEnabled).toBe(false);
    expect(view.mfaRequiredForAdmins).toBe(false);
    expect(view.selfRegistrationEnabled).toBe(false);
    expect(view.deployEnabled).toBe(false);
  });

  it('every policy helper defaults to false', async () => {
    mockPrisma.securitySetting.findFirst.mockResolvedValue(null);
    await expect(service.isTurnstileEnabled()).resolves.toBe(false);
    await expect(service.isOAuthGoogleEnabled()).resolves.toBe(false);
    await expect(service.isOAuthGithubEnabled()).resolves.toBe(false);
    await expect(service.isMfaRequiredForAdmins()).resolves.toBe(false);
    await expect(service.isSelfRegistrationEnabled()).resolves.toBe(false);
    await expect(service.isDeployEnabled()).resolves.toBe(false);
    await expect(service.getTurnstileSiteKey()).resolves.toBeNull();
    await expect(service.getTurnstileSecretKey()).resolves.toBeNull();
  });

  it('update creates the singleton on first use, applies the patch and audits', async () => {
    mockPrisma.securitySetting.findFirst.mockResolvedValueOnce(null);
    mockPrisma.securitySetting.create.mockResolvedValue(row());
    mockPrisma.securitySetting.update.mockResolvedValue(row({ turnstileEnabled: true }));

    const view = await service.update({ turnstileEnabled: true }, actor);
    expect(mockPrisma.securitySetting.create).toHaveBeenCalled();
    expect(mockPrisma.securitySetting.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { turnstileEnabled: true },
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'security.settings.update', actorId: 'a1' }),
    );
    expect(view.turnstileEnabled).toBe(true);
  });

  it('update with an empty patch leaves the row untouched (no write, no audit)', async () => {
    mockPrisma.securitySetting.findFirst.mockResolvedValue(row());
    const view = await service.update({}, actor);
    expect(mockPrisma.securitySetting.update).not.toHaveBeenCalled();
    expect(mockAudit.record).not.toHaveBeenCalled();
    expect(view.id).toBe('s1');
  });

  it('stores the Turnstile site key (public) and encrypts the secret (write-only)', async () => {
    mockPrisma.securitySetting.findFirst.mockResolvedValue(row());
    mockPrisma.securitySetting.update.mockResolvedValue(
      row({ turnstileSiteKey: '0x4AAA…', turnstileSecretEnc: 'enc:sec' }),
    );
    const view = await service.update(
      { turnstileSiteKey: '0x4AAA…', turnstileSecretKey: 'sec' },
      actor,
    );
    expect(mockPrisma.securitySetting.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { turnstileSiteKey: '0x4AAA…', turnstileSecretEnc: 'enc:sec' },
    });
    expect(mockCrypto.encrypt).toHaveBeenCalledWith('sec');
    // Jamais la clé secret dans l'audit — seulement l'état.
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          turnstileSiteKey: '0x4AAA…',
          turnstileHasSecretKey: true,
        }),
      }),
    );
    expect(view.turnstileSiteKey).toBe('0x4AAA…');
    expect(view.turnstileHasSecretKey).toBe(true);
  });

  it("'' efface les clés Turnstile", async () => {
    mockPrisma.securitySetting.findFirst.mockResolvedValue(row({ turnstileSecretEnc: 'enc:old' }));
    mockPrisma.securitySetting.update.mockResolvedValue(
      row({ turnstileSiteKey: null, turnstileSecretEnc: null }),
    );
    await service.update({ turnstileSiteKey: '', turnstileSecretKey: '' }, actor);
    expect(mockPrisma.securitySetting.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { turnstileSiteKey: null, turnstileSecretEnc: null },
    });
  });

  // ── Rate-limit du statut public de commande (cache TTL 30 s + fallback) ────
  describe('getOrderStatusRateLimit (cache + fallback sécurisé)', () => {
    const rlRow = (over: Record<string, unknown> = {}) =>
      row({
        orderStatusRateLimitEnabled: true,
        orderStatusRateLimitMax: 30,
        orderStatusRateLimitWindowSec: 60,
        ...over,
      });

    it('row absente → fallback sécurisé { enabled: true, limit: 30, windowMs: 60_000 }', async () => {
      mockPrisma.securitySetting.findFirst.mockResolvedValue(null);
      await expect(service.getOrderStatusRateLimit()).resolves.toEqual({
        enabled: true,
        limit: 30,
        windowMs: 60_000,
      });
    });

    it('lit les valeurs admin (fenêtre secondes → millisecondes)', async () => {
      mockPrisma.securitySetting.findFirst.mockResolvedValue(
        rlRow({ orderStatusRateLimitMax: 100, orderStatusRateLimitWindowSec: 300 }),
      );
      await expect(service.getOrderStatusRateLimit()).resolves.toEqual({
        enabled: true,
        limit: 100,
        windowMs: 300_000,
      });
    });

    it('cache frais (30 s) : une seule lecture DB pour plusieurs appels', async () => {
      mockPrisma.securitySetting.findFirst.mockResolvedValue(rlRow());
      await service.getOrderStatusRateLimit();
      await service.getOrderStatusRateLimit();
      await service.getOrderStatusRateLimit();
      expect(mockPrisma.securitySetting.findFirst).toHaveBeenCalledTimes(1);
    });

    it('TTL expiré → relecture DB', async () => {
      jest.useFakeTimers();
      try {
        mockPrisma.securitySetting.findFirst.mockResolvedValue(rlRow());
        await service.getOrderStatusRateLimit();
        jest.advanceTimersByTime(30_001);
        await service.getOrderStatusRateLimit();
        expect(mockPrisma.securitySetting.findFirst).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('update admin → invalidation immédiate du cache', async () => {
      // 1ʳᵉ lecture = 30 (mise en cache) ; l'update admin réécrit la config à 50.
      mockPrisma.securitySetting.findFirst
        .mockResolvedValueOnce(rlRow({ orderStatusRateLimitMax: 30 }))
        .mockResolvedValue(rlRow({ orderStatusRateLimitMax: 50 }));
      mockPrisma.securitySetting.update.mockResolvedValue(rlRow({ orderStatusRateLimitMax: 50 }));
      await service.getOrderStatusRateLimit(); // remplit le cache (30)
      await service.update({ orderStatusRateLimitMax: 50 }, actor); // invalide le cache
      const out = await service.getOrderStatusRateLimit(); // re-lit la DB → 50
      expect(out.limit).toBe(50);
    });

    it('erreur DB avec cache exploitable → dernier cache conservé (même périmé)', async () => {
      jest.useFakeTimers();
      try {
        mockPrisma.securitySetting.findFirst.mockResolvedValueOnce(
          rlRow({ orderStatusRateLimitMax: 42 }),
        );
        await service.getOrderStatusRateLimit(); // cache = 42
        jest.advanceTimersByTime(60_000); // cache périmé
        mockPrisma.securitySetting.findFirst.mockRejectedValueOnce(new Error('DB down'));
        await expect(service.getOrderStatusRateLimit()).resolves.toEqual({
          enabled: true,
          limit: 42,
          windowMs: 60_000,
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('erreur DB sans cache → fallback sécurisé 30/60', async () => {
      mockPrisma.securitySetting.findFirst.mockRejectedValue(new Error('DB down'));
      await expect(service.getOrderStatusRateLimit()).resolves.toEqual({
        enabled: true,
        limit: 30,
        windowMs: 60_000,
      });
    });

    it('valeurs DB hors bornes re-clampées (5..1000 / 10..3600 s)', async () => {
      mockPrisma.securitySetting.findFirst.mockResolvedValue(
        rlRow({ orderStatusRateLimitMax: 99999, orderStatusRateLimitWindowSec: 1 }),
      );
      await expect(service.getOrderStatusRateLimit()).resolves.toEqual({
        enabled: true,
        limit: 1000,
        windowMs: 10_000,
      });
    });

    it('enabled absent/undefined → true (jamais de désactivation silencieuse)', async () => {
      mockPrisma.securitySetting.findFirst.mockResolvedValue(
        rlRow({ orderStatusRateLimitEnabled: undefined }),
      );
      await expect(service.getOrderStatusRateLimit()).resolves.toEqual({
        enabled: true,
        limit: 30,
        windowMs: 60_000,
      });
    });

    it('limite/fenêtre absentes → 30 / 60 s (fallback sécurisé)', async () => {
      mockPrisma.securitySetting.findFirst.mockResolvedValue(
        rlRow({ orderStatusRateLimitMax: undefined, orderStatusRateLimitWindowSec: undefined }),
      );
      await expect(service.getOrderStatusRateLimit()).resolves.toEqual({
        enabled: true,
        limit: 30,
        windowMs: 60_000,
      });
    });
  });
});
