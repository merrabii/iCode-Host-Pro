import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OAuthAuthorizeInput,
  OAuthExchangeInput,
  OAuthProviderClient,
  ProviderProfile,
} from './oauth-provider.client';

/** Google OAuth 2.0 (Phase 10, ADR-027) — native fetch, no library. */
@Injectable()
export class GoogleOAuthClient implements OAuthProviderClient {
  readonly kind = 'google' as const;

  constructor(private readonly config: ConfigService) {}

  private secret() {
    return {
      clientId: this.config.get<string>('googleClientId') ?? '',
      clientSecret: this.config.get<string>('googleClientSecret') ?? '',
    };
  }

  getAuthorizeUrl(input: OAuthAuthorizeInput): string {
    const { clientId } = this.secret();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: input.scope || 'openid email profile',
      access_type: 'online',
      prompt: 'select_account',
      state: input.state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCode(input: OAuthExchangeInput): Promise<ProviderProfile> {
    const { clientId, clientSecret } = this.secret();
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenRes.ok) throw new Error('Google token exchange failed');
    const tokenData = (await tokenRes.json()) as { access_token: string };
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!profileRes.ok) throw new Error('Google profile fetch failed');
    const profile = (await profileRes.json()) as {
      email?: string;
      verified_email?: boolean;
    };
    if (!profile.email) throw new Error('Google profile has no email');
    return {
      email: profile.email,
      emailVerified: profile.verified_email === true,
      accessToken: tokenData.access_token,
    };
  }
}