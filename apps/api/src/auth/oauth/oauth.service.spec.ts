import { BadRequestException } from '@nestjs/common';
import { OAuthService } from './oauth.service';

describe('OAuthService (login / link / order-time register, ADR-027)', () => {
  const mockConfig = { get: jest.fn() };
  const mockSettings = {
    isOAuthGoogleEnabled: jest.fn(),
    isOAuthGithubEnabled: jest.fn(),
  };
  const mockPrisma = { user: { findUnique: jest.fn(), update: jest.fn() } };
  const mockAudit = { record: jest.fn() };
  const google = {
    kind: 'google',
    getAuthorizeUrl: jest.fn(),
    exchangeCode: jest.fn(),
  };
  const github = {
    kind: 'github',
    getAuthorizeUrl: jest.fn(),
    exchangeCode: jest.fn(),
  };

  let service: OAuthService;
  beforeEach(() => {
    service = new OAuthService(
      mockConfig as never,
      mockSettings as never,
      mockPrisma as never,
      mockAudit as never,
      google as never,
      github as never,
    );
    jest.clearAllMocks();
    mockSettings.isOAuthGoogleEnabled.mockResolvedValue(true);
    mockSettings.isOAuthGithubEnabled.mockResolvedValue(true);
    mockConfig.get.mockImplementation((k: string) => {
      if (k === 'googleClientId') return 'gid';
      if (k === 'googleClientSecret') return 'gsec';
      if (k === 'githubClientId') return 'ghid';
      if (k === 'githubClientSecret') return 'ghsec';
      if (k === 'publicBaseUrl') return 'https://app.example.com/';
      return undefined;
    });
  });

  it('isEnabled requires BOTH the admin flag AND the env keys', async () => {
    mockSettings.isOAuthGoogleEnabled.mockResolvedValue(false);
    await expect(service.isEnabled('google')).resolves.toBe(false);

    mockSettings.isOAuthGoogleEnabled.mockResolvedValue(true);
    await expect(service.isEnabled('google')).resolves.toBe(true);

    mockConfig.get.mockImplementation((k: string) =>
      k === 'publicBaseUrl' ? 'https://app.example.com/' : undefined,
    );
    await expect(service.isEnabled('google')).resolves.toBe(false); // no keys
  });

  it('redirectUri always uses the public base — never :3001', () => {
    expect(service.redirectUri('google')).toBe(
      'https://app.example.com/api/auth/oauth/google/callback',
    );
    expect(service.redirectUri('github')).toBe(
      'https://app.example.com/api/auth/oauth/github/callback',
    );
  });

  it('getAuthorizeUrl forwards redirect/state/scope, requesting repo scope when linking GitHub', () => {
    google.getAuthorizeUrl.mockReturnValue('https://accounts.google.com/o/oauth2/auth?…');
    github.getAuthorizeUrl.mockReturnValue('https://github.com/login/oauth/authorize?…');

    service.getAuthorizeUrl('google', 'st', 'login');
    expect(google.getAuthorizeUrl).toHaveBeenCalledWith({
      redirectUri: 'https://app.example.com/api/auth/oauth/google/callback',
      state: 'st',
      scope: 'openid email profile',
    });

    service.getAuthorizeUrl('github', 'st', 'login');
    expect(github.getAuthorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'user:email' }),
    );

    service.getAuthorizeUrl('github', 'st', 'link');
    expect(github.getAuthorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'user:email repo' }),
    );
  });

  it('resolve exchanges the code through the provider client', async () => {
    google.exchangeCode.mockResolvedValue({
      email: 'u@example.com',
      emailVerified: true,
      accessToken: 'at',
    });
    await expect(service.resolve('google', 'code')).resolves.toEqual({
      email: 'u@example.com',
      emailVerified: true,
      accessToken: 'at',
    });
  });

  it('resolve refuses a disabled provider', async () => {
    mockSettings.isOAuthGoogleEnabled.mockResolvedValue(false);
    await expect(service.resolve('google', 'code')).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('unlink', () => {
    it('unlinks a matching provider and drops the stored GitHub token', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'u@example.com',
        oauthProvider: 'github',
        oauthSubject: 's',
        githubTokenEnc: 'enc',
      });
      mockPrisma.user.update.mockResolvedValue({
        id: 'u1',
        email: 'u@example.com',
        oauthProvider: null,
        oauthSubject: null,
        githubTokenEnc: null,
      });
      const res = await service.unlink('u1', 'github', { sub: 'u1', email: 'u@example.com' });
      expect(res.unlinked).toBe(true);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { oauthProvider: null, oauthSubject: null, githubTokenEnc: null },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'oauth.unlink' }),
      );
    });

    it('is a no-op for a provider that is not the one linked', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', oauthProvider: 'google' });
      await expect(
        service.unlink('u1', 'github', { sub: 'u1', email: 'u@example.com' }),
      ).resolves.toEqual({ unlinked: false });
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });
});
