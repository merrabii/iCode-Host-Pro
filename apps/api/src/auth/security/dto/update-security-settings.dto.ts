import { IsBoolean, IsOptional } from 'class-validator';

// Phase 10 (ADR-027): every security option is NON-mandatory and admin-toggleable.
// PATCH semantics — undefined = leave unchanged. All flags default OFF.
export class UpdateSecuritySettingsDto {
  @IsOptional()
  @IsBoolean()
  turnstileEnabled?: boolean;

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