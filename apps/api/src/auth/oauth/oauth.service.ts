import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SecuritySettingsService } from '../security/security-settings.service';
import {
  GITHUB_OAUTH,
  GOOGLE_OAUTH,
  OAuthMode,
  OAuthProvider,
  OAuthProviderClient,
  ProviderProfile,
} from './oauth-provider.client';

/** Dead-simple state TTL guard lives in the controller (cookie). */
export class OAuthConfigError extends Error {}

@Injectable()
export class OAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly settings: SecuritySettingsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(GOOGLE_OAUTH) private readonly google: OAuthProviderClient,
    @Inject(GITHUB_OAUTH) private readonly github: OAuthProviderClient,
  ) {}

  private client(provider: OAuthProvider): OAuthProviderClient {
    return provider === 'google' ? this.google : this.github;
  }

  /** Is this provider both admin-enabled AND env-configured? */
  async isEnabled(provider: OAuthProvider): Promise<boolean> {
    if (provider === 'google' && !(await this.settings.isOAuthGoogleEnabled())) return false;
    if (provider === 'github' && !(await this.settings.isOAuthGithubEnabled())) return false;
    return this.isConfigured(provider);
  }

  isConfigured(provider: OAuthProvider): boolean {
    if (provider === 'google') {
      return !!(
        this.config.get<string>('googleClientId') &&
        this.config.get<string>('googleClientSecret')
      );
    }
    return !!(
      this.config.get<string>('githubClientId') &&
      this.config.get<string>('githubClientSecret')
    );
  }

  redirectUri(provider: OAuthProvider): string {
    const base = (this.config.get<string>('publicBaseUrl') ??
      'http://localhost:3000').replace(/\/+$/, '');
    return `${base}/api/auth/oauth/${provider}/callback`;
  }

  /** GitHub scope: `user:email` always, plus `repo` when linking (Phase 10bis
   *  repo auto-detection). Google scope is fixed (`openid email profile`). */
  private scope(provider: OAuthProvider, mode: OAuthMode): string {
    if (provider === 'github') {
      return mode === 'link' ? 'user:email repo' : 'user:email';
    }
    return 'openid email profile';
  }

  getAuthorizeUrl(provider: OAuthProvider, state: string, mode: OAuthMode): string {
    return this.client(provider).getAuthorizeUrl({
      redirectUri: this.redirectUri(provider),
      state,
      scope: this.scope(provider, mode),
    });
  }

  /** Detach a provider identity from the user's account (self-service /profil).
   *  Rejecting a provider not currently linked is a no-op 200 with the same
   *  shape. GitHub unlinking also drops the stored Phase 10bis token. */
  async unlink(
    userId: string,
    provider: OAuthProvider,
    actor: { sub: string; email: string },
  ): Promise<{ unlinked: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Compte introuvable.');
    if (user.oauthProvider !== provider) {
      return { unlinked: false };
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        oauthProvider: null,
        oauthSubject: null,
        ...(provider === 'github' ? { githubTokenEnc: null } : {}),
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'oauth.unlink',
      resourceType: 'user',
      resourceId: userId,
      details: { provider, targetEmail: updated.email },
    });
    return { unlinked: true };
  }

  async resolve(provider: OAuthProvider, code: string): Promise<ProviderProfile> {
    if (!(await this.isEnabled(provider))) {
      throw new BadRequestException('Fournisseur OAuth désactivé.');
    }
    try {
      return await this.client(provider).exchangeCode({
        redirectUri: this.redirectUri(provider),
        code,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new BadRequestException(`Échec de l’échange OAuth ${provider} : ${msg}`);
    }
  }
}