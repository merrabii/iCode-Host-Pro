import { PartialType } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PackStatus } from '@prisma/client';

export class CreatePackDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  // Limites de ressources — RAM obligatoire ; CPU par défaut à 1 (validation
  // IsPositive pour rejeter 0/négatif). `storageLimit` = quota disque (Go),
  // VALEUR ENREGISTRÉE mais système de quota NON actif encore (Plan.cpu_limit/
  // memory_limit/storage_limit) ; seuls RAM/CPU sont appliqués pour l'instant.
  @IsInt()
  @Min(1)
  ramMb!: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  cpuCores?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  storageLimit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  bandwidth?: string;

  // Phase 13 — quota d'applications du plan (1 / 5 / 10… ; null = illimité).
  @IsOptional()
  @IsInt()
  @Min(1)
  maxApps?: number;

  // Phase 13 — module/méthode de déploiement lié à ce pack (A/B/C…).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  deploymentModuleId?: string;

  @IsOptional()
  @IsEnum(PackStatus)
  status?: PackStatus;
}

export class UpdatePackDto extends PartialType(CreatePackDto) {}