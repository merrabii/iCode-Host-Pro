import { Module, forwardRef } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { CryptoModule } from '../crypto/crypto.module';
import { InvitationsModule } from '../invitations/invitations.module';
import { MailModule } from '../mail/mail.module';
import { AuthController } from './auth.controller';
import { AuthCookiesService } from './auth-cookies.service';
import { AuthService } from './auth.service';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { SaRateLimiter } from './rate-limiter';
import { RolesGuard } from './guards/roles.guard';
import { MfaChallengeStore } from './mfa/mfa-challenge.store';
import { MfaController } from './mfa/mfa.controller';
import { MfaService } from './mfa/mfa.service';
import { GoogleOAuthClient } from './oauth/google.client';
import { GithubOAuthClient } from './oauth/github.client';
import { OAuthController } from './oauth/oauth.controller';
import { OAuthService } from './oauth/oauth.service';
import { GITHUB_OAUTH, GOOGLE_OAUTH } from './oauth/oauth-provider.client';
import { PublicAuthConfigController } from './public-config.controller';
import { SecuritySettingsController } from './security/security-settings.controller';
import { SecuritySettingsService } from './security/security-settings.service';
import { TurnstileService } from './turnstile.service';

// Phase 10 (ADR-027): the whole security-and-accounts core lives here so the
// feature-flag toggle (SecuritySettingsService) and the guard semantics stay
// one coherent unit. forwardRef on InvitationsModule + MailModule: the import
// chain Auth → Invitations → Mail → Auth is circular at the module-file level.
@Module({
  imports: [
    forwardRef(() => InvitationsModule),
    forwardRef(() => MailModule),
    CryptoModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        secret: config.getOrThrow<string>('jwtSecret'),
        signOptions: {
          expiresIn: (config.get<string>('jwtExpiresIn') ?? '15m') as NonNullable<
            JwtModuleOptions['signOptions']
          >['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [
    AuthController,
    CheckoutController,
    MfaController,
    OAuthController,
    PublicAuthConfigController,
    SecuritySettingsController,
  ],
  providers: [
    AuthService,
    AuthCookiesService,
    CheckoutService,
    SaRateLimiter,
    RolesGuard,
    MfaService,
    MfaChallengeStore,
    MfaController,
    OAuthService,
    OAuthController,
    { provide: GOOGLE_OAUTH, useClass: GoogleOAuthClient },
    { provide: GITHUB_OAUTH, useClass: GithubOAuthClient },
    SecuritySettingsService,
    SecuritySettingsController,
    TurnstileService,
  ],
  exports: [
    AuthService,
    AuthCookiesService,
    CheckoutService,
    SaRateLimiter,
    MfaService,
    MfaChallengeStore,
    OAuthService,
    SecuritySettingsService,
    TurnstileService,
    RolesGuard,
    JwtModule,
  ],
})
export class AuthModule {}
