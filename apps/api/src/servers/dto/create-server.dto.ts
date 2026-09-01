import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ServerPanelProvider, ServerStatus } from '@prisma/client';

export class CreateServerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  hostname!: string;

  @IsOptional()
  @IsEnum(ServerStatus)
  status?: ServerStatus;

  // Détails d'infrastructure (ADR-024).
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ipAddress?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  provider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  region?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  quotaMaxAccounts?: number;

  @IsOptional()
  @IsBoolean()
  strictTls?: boolean;

  @IsOptional()
  @IsEnum(ServerPanelProvider)
  panelProvider?: ServerPanelProvider;
}
