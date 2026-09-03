import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SecuritySettingsService } from './security/security-settings.service';

/**
 * Phase 10 (ADR-027): PUBLIC read of what the auth UI must render — which
 * OAuth buttons exist and the Turnstile site key. No secrets: only the PUBLIC
 * site key is exposed (never the secret), and an OAuth provider is only
 * "available" when the admin flag AND the env keys are both present.
 */
export interface PublicAuthConfig {
  turnstileSiteKey: string;
  oauthGoogleEnabled: boolean;
  oauthGithubEnabled: boolean;
  selfRegistrationEnabled: boolean;
}

@ApiTags('public/auth-config')
@Controller('public/auth-config')
export class PublicAuthConfigController {
  constructor(
    private readonly settings: SecuritySettingsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Public auth UI config — OAuth availability + Turnstile site key' })
  async get(): Promise<PublicAuthConfig> {
    const googleKeys =
      !!this.config.get<string>('googleClientId') &&
      !!this.config.get<string>('googleClientSecret');
    const githubKeys =
      !!this.config.get<string>('githubClientId') &&
      !!this.config.get<string>('githubClientSecret');
    // Phase 11: la clé SITE gérée par l'admin (SecuritySetting) prime ; le env
    // reste le fallback pour les déploiements configurés par variable.
    const siteKey =
      (await this.settings.getTurnstileSiteKey()) ??
      this.config.get<string>('turnstileSiteKey') ??
      '';
    return {
      turnstileSiteKey: siteKey,
      oauthGoogleEnabled: (await this.settings.isOAuthGoogleEnabled()) && googleKeys,
      oauthGithubEnabled: (await this.settings.isOAuthGithubEnabled()) && githubKeys,
      selfRegistrationEnabled: await this.settings.isSelfRegistrationEnabled(),
    };
  }
}
