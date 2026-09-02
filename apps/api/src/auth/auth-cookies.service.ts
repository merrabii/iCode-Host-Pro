import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';

/** Shared refresh + state cookie helpers for every auth flow (login, MFA,
 *  OAuth callback). One source of truth for the httpOnly options. */
@Injectable()
export class AuthCookiesService {
  readonly refreshName: string;
  readonly checkoutName = 'ihp_checkout';
  readonly oauthStateName = 'ihp_oauth_state';
  readonly mfaName = 'ihp_mfa';

  constructor(private readonly config: ConfigService) {
    this.refreshName = this.config.get<string>('cookieName') ?? 'ihp_refresh';
  }

  refreshOptions() {
    const days = this.config.get<number>('refreshExpiresInDays') ?? 30;
    const isProduction =
      (this.config.get<string>('nodeEnv') ?? 'development') === 'production';
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: isProduction,
      path: '/',
      maxAge: days * 24 * 60 * 60 * 1000,
    };
  }

  /** Set the refresh cookie (only when a refresh token exists — impersonation
   *  flows must NOT set one). */
  setRefresh(res: Response, refreshToken: string): void {
    if (refreshToken) {
      res.cookie(this.refreshName, refreshToken, this.refreshOptions());
    }
  }

  clearRefresh(res: Response): void {
    res.clearCookie(this.refreshName, { httpOnly: true, path: '/' });
  }

  clearCheckout(res: Response): void {
    res.clearCookie(this.checkoutName, { httpOnly: true, path: '/' });
  }

  /** Short-lived httpOnly cookie for the order-time checkout intent. */
  checkoutOptions(maxAgeSeconds: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.isProduction(),
      path: '/',
      maxAge: maxAgeSeconds * 1000,
    };
  }

  /** Short-lived httpOnly cookie carrying the OAuth CSRF state. */
  oauthStateOptions(ttlSeconds: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.isProduction(),
      path: '/',
      maxAge: ttlSeconds * 1000,
    };
  }

  setCheckout(res: Response, token: string, maxAgeSeconds: number): void {
    res.cookie(this.checkoutName, token, this.checkoutOptions(maxAgeSeconds));
  }

  /** Carry the pending MFA challenge id across the OAuth → /auth redirect. */
  setMfaChallenge(res: Response, challengeId: string, ttlSeconds: number): void {
    res.cookie(
      this.mfaName,
      challengeId,
      { ...this.refreshOptions(), maxAge: ttlSeconds * 1000 },
    );
  }

  clearMfa(res: Response): void {
    res.clearCookie(this.mfaName, { httpOnly: true, path: '/' });
  }

  setOauthState(res: Response, value: string, ttlSeconds: number): void {
    res.cookie(this.oauthStateName, value, this.oauthStateOptions(ttlSeconds));
  }

  clearOauthState(res: Response): void {
    res.clearCookie(this.oauthStateName, { httpOnly: true, path: '/' });
  }

  private isProduction(): boolean {
    return (this.config.get<string>('nodeEnv') ?? 'development') === 'production';
  }
}