import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecuritySettingsService } from './security/security-settings.service';

/**
 * Cloudflare Turnstile (Phase 10, ADR-027) — server-side verification of the
 * client widget token. Deliberately DEGRADES SAFE: without a configured secret
 * key the service returns `true` (skipped), so enabling the feature in the
 * admin SecuritySetting is what actually gates it. Enforcement order: the
 * caller checks `SecuritySettingsService.isTurnstileEnabled()` (the admin
 * flag) THEN calls `verify()` here (the key presence).
 *
 * Phase 11: the secret key can be stored in the SecuritySetting singleton
 * (admin manages it in /manager/securite, AES-256-GCM at rest). The env
 * `TURNSTILE_SECRET_KEY` remains a fallback so existing setups keep working.
 */
@Injectable()
export class TurnstileService {
  constructor(
    private readonly config: ConfigService,
    private readonly settings: SecuritySettingsService,
  ) {}

  /** Env fallback check — kept for backwards-compat; live path uses the DB secret. */
  isConfigured(): boolean {
    return !!this.config.get<string>('turnstileSecretKey');
  }

  /** Async DB-aware check — the call sites that gate Turnstile can keep the sync isConfigured(). */
  async isConfiguredAsync(): Promise<boolean> {
    const stored = await this.settings.getTurnstileSecretKey().catch(() => null);
    if (stored) return true;
    return !!this.config.get<string>('turnstileSecretKey');
  }

  /**
   * Resolve the secret to use: DB-stored key first (admin-managed), then the
   * env fallback. Never throws — decrypt failure degrades to "not configured".
   */
  private async secret(): Promise<string | null> {
    const stored = await this.settings.getTurnstileSecretKey();
    if (stored) return stored;
    const env = this.config.get<string>('turnstileSecretKey');
    return env || null;
  }

  /**
   * Verify a widget token against Cloudflare. `ip` is optional; only the
   * secret key is required. Returns false on any network/verification error so
   * a failed Turnstile never lets a bot through.
   */
  async verify(token: string, ip?: string): Promise<boolean> {
    const secret = await this.secret();
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
