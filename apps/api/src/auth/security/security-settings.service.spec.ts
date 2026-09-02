import { SecuritySettingsService } from './security-settings.service';

describe('SecuritySettingsService (singleton admin flags, ADR-027)', () => {
  const mockPrisma = {
    securitySetting: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  };
  const mockAudit = { record: jest.fn() };
  const actor = { sub: 'a1', email: 'admin@example.com' };

  const row = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    turnstileEnabled: false,
    oauthGoogleEnabled: false,
    oauthGithubEnabled: false,
    mfaRequiredForAdmins: false,
    selfRegistrationEnabled: false,
    deployEnabled: false,
    createdAt: new Date('2026-09-02T00:00:00Z'),
    updatedAt: new Date('2026-09-02T00:00:00Z'),
    ...over,
  });

  let service: SecuritySettingsService;
  beforeEach(() => {
    service = new SecuritySettingsService(mockPrisma as never, mockAudit as never);
    jest.clearAllMocks();
  });

  it('returns all-off defaults when no row exists', async () => {
    mockPrisma.securitySetting.findFirst.mockResolvedValue(null);
    const view = await service.get();
    expect(view.id).toBeNull();
    expect(view.turnstileEnabled).toBe(false);
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
});
