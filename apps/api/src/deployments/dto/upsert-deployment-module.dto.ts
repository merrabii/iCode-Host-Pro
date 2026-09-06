import { PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { DeploymentModuleKind } from '@prisma/client';

// Phase 13 — module/méthode de déploiement (A projet partagé / B projet client).
// L'admin configure ces modules sur la page Packs (« Configuration de
// déploiement ») : nom, code (A/B/C…), type, serveur Coolify, projet partagé
// (liste live) ou préfixe client, et overrides de limites RAM/CPU (et disque,
// enregistré mais non appliqué pour l'instant).
export class CreateDeploymentModuleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9_-]{1,10}$/, {
    message: 'Code invalide (1-10 caractères alphanumériques, tirets).',
  })
  code!: string;

  @IsEnum(DeploymentModuleKind)
  kind!: DeploymentModuleKind;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  serverId?: string;

  // Module A — projet partagé (uuid + snapshot lisible du nom pour le support).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  sharedProjectUuid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  sharedProjectName?: string;

  // Module B — préfixe du nom de projet client (« client » → client-<uid>).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  perClientPrefix?: string;

  // Overrides de limites (appliqués aux apps déployées par ce module).
  @IsOptional()
  @IsInt()
  @Min(1)
  overrideRamMb?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  overrideCpuCores?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  overrideStorageLimit?: number;
}

export class UpdateDeploymentModuleDto extends PartialType(CreateDeploymentModuleDto) {}