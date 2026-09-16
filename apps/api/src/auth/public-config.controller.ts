import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SecuritySettingsService } from './security/security-settings.service';
import { TurnstileService } from './turnstile.service';

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
  /** Phase 10bis : drapeau NON sensible (même veine que selfRegistrationEnabled)
   *  — le web l'utilise pour afficher/cacher le panneau Déploiements du /client. */
  deployEnabled: boolean;
}

@ApiTags('public/auth-config')
@Controller('public/auth-config')
export class PublicAuthConfigController {
  constructor(
    private readonly settings: SecuritySettingsService,
    private readonly config: ConfigService,
    private readonly turnstile: TurnstileService,
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
    // Phase 3: la clé SITE publique n'est servie QUE si Turnstile est ACTIF
    // (flag admin ET clés SITE + SECRET présentes). Sinon '' → le frontend
    // (auth/page.tsx gate sur `turnstileSiteKey !== ''`) ne rend pas de widget
    // et n'envoie pas de token — cohérent avec auth.service qui gate verify sur
    // la même notion isActive(). Une config incomplète n'annonce jamais un
    // Turnstile utilisable, et le SECRET n'est jamais exposé. Le env reste le
    // fallback géré par TurnstileService.getSiteKey().
    const active = await this.turnstile.isActive();
    return {
      turnstileSiteKey: active ? await this.turnstile.getSiteKey() : '',
      oauthGoogleEnabled: (await this.settings.isOAuthGoogleEnabled()) && googleKeys,
      oauthGithubEnabled: (await this.settings.isOAuthGithubEnabled()) && githubKeys,
      selfRegistrationEnabled: await this.settings.isSelfRegistrationEnabled(),
      deployEnabled: await this.settings.isDeployEnabled(),
    };
  }
}
