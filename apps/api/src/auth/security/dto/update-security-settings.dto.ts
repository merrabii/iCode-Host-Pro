import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

// Phase 10 (ADR-027): every security option is NON-mandatory and admin-toggleable.
// PATCH semantics — undefined = leave unchanged. All flags default OFF.
// Phase 11: the admin also manages the Turnstile KEYS in the UI (site = public,
// secret = write-only, encrypted at rest). For both: '' = effacer.
export class UpdateSecuritySettingsDto {
  @IsOptional()
  @IsBoolean()
  turnstileEnabled?: boolean;

  /** Clé SITE Turnstile (publique, servie au widget). Absent = inchangé ; '' = effacé. */
  @IsOptional()
  @IsString()
  turnstileSiteKey?: string;

  /** Clé SECRET Turnstile (write-only, chiffrée AES-256-GCM au repos). Absent = inchangé ; '' = effacé. */
  @IsOptional()
  @IsString()
  turnstileSecretKey?: string;

  @IsOptional()
  @IsBoolean()
  oauthGoogleEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  oauthGithubEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  mfaRequiredForAdmins?: boolean;

  @IsOptional()
  @IsBoolean()
  selfRegistrationEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  deployEnabled?: boolean;

  /** Rate-limit du statut public de commande. Défauts : actif, 30 requêtes / 60 s. */
  @IsOptional()
  @IsBoolean()
  orderStatusRateLimitEnabled?: boolean;

  /** Nombre maximal de requêtes par IP dans la fenêtre (5..1000, défaut 30). */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1000)
  orderStatusRateLimitMax?: number;

  /** Fenêtre en secondes (10..3600, défaut 60). */
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(3600)
  orderStatusRateLimitWindowSec?: number;
}
