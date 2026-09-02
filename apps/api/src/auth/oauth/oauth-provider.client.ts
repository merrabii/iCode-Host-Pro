export type OAuthProvider = 'google' | 'github';
export type OAuthMode = 'login' | 'link';

export interface OAuthAuthorizeInput {
  redirectUri: string;
  state: string;
  scope: string;
}

export interface OAuthExchangeInput {
  redirectUri: string;
  code: string;
}

export interface ProviderProfile {
  email: string;
  emailVerified: boolean;
  /** OAuth access token — stored AES-encrypted ONLY for GitHub (Phase 10bis). */
  accessToken: string;
}

export interface OAuthProviderClient {
  kind: OAuthProvider;
  getAuthorizeUrl(input: OAuthAuthorizeInput): string;
  exchangeCode(input: OAuthExchangeInput): Promise<ProviderProfile>;
}

/** Injectable provider tokens — overridable in e2e for a mocked provider. */
export const GOOGLE_OAUTH = Symbol('GOOGLE_OAUTH');
export const GITHUB_OAUTH = Symbol('GITHUB_OAUTH');