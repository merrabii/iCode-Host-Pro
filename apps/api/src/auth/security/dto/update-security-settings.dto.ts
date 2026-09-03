import { IsBoolean, IsOptional, IsString } from 'class-validator';

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
}