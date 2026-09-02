import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OAuthAuthorizeInput,
  OAuthExchangeInput,
  OAuthProviderClient,
  ProviderProfile,
} from './oauth-provider.client';

/** GitHub OAuth (Phase 10, ADR-027) — native fetch, no library. */
@Injectable()
export class GithubOAuthClient implements OAuthProviderClient {
  readonly kind = 'github' as const;

  constructor(private readonly config: ConfigService) {}

  private secret() {
    return {
      clientId: this.config.get<string>('githubClientId') ?? '',
      clientSecret: this.config.get<string>('githubClientSecret') ?? '',
    };
  }

  getAuthorizeUrl(input: OAuthAuthorizeInput): string {
    const { clientId } = this.secret();
    const scope = input.scope || 'user:email';
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: input.redirectUri,
      scope,
      state: input.state,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  async exchangeCode(input: OAuthExchangeInput): Promise<ProviderProfile> {
    const { clientId, clientSecret } = this.secret();
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        code: input.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: input.redirectUri,
      }).toString(),
    });
    if (!tokenRes.ok) throw new Error('GitHub token exchange failed');
    const tokenData = (await tokenRes.json()) as { access_token: string };
    // Require the primary, verified GitHub email.
    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers: {
        authorization: `Bearer ${tokenData.access_token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!emailsRes.ok) throw new Error('GitHub emails fetch failed');
    const emails = (await emailsRes.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    const primary = emails.find((e) => e.primary) ?? emails[0];
    if (!primary?.email) throw new Error('GitHub profile has no email');
    return {
      email: primary.email,
      emailVerified: primary.verified === true,
      accessToken: tokenData.access_token,
    };
  }
}