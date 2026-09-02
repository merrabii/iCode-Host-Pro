import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Cloudflare Turnstile (Phase 10, ADR-027) — server-side verification of the
 * client widget token. Deliberately DEGRADES SAFE: without a configured secret
 * key the service returns `true` (skipped), so enabling the feature in the
 * admin SecuritySetting is what actually gates it. Enforcement order: the
 * caller checks `SecuritySettingsService.isTurnstileEnabled()` (the admin
 * flag) THEN calls `verify()` here (the env key presence).
 */
@Injectable()
export class TurnstileService {
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.config.get<string>('turnstileSecretKey');
  }

  /**
   * Verify a widget token against Cloudflare. `ip` is optional; only the
   * secret key is required. Returns false on any network/verification error so
   * a failed Turnstile never lets a bot through.
   */
  async verify(token: string, ip?: string): Promise<boolean> {
    const secret = this.config.get<string>('turnstileSecretKey');
    if (!secret) return true; // not configured → skipped
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    try {
      const res = await fetch(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        },
      );
      const data = (await res.json()) as {
        success?: boolean;
        'error-codes'?: string[];
      };
      return data?.success === true;
    } catch {
      return false;
    }
  }
}