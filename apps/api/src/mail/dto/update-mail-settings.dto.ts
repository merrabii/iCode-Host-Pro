import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Phase 6 (ADR-022): PATCH-semantics upsert of the SMTP settings row.
// All fields optional — undefined = leave unchanged. `password`: empty string
// = unchanged (never echoed); a value is AES-256-GCM encrypted at rest.
export class UpdateMailSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsBoolean()
  secure?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  user?: string; // '' = clear the auth user

  @IsOptional()
  @IsString()
  @MaxLength(255)
  password?: string; // '' = keep the stored one

  @IsOptional()
  @IsEmail()
  fromEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fromName?: string; // '' = clear the display name
}