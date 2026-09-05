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

  // Crédentials API panneau (Phase 9, ADR-010) — le token est un secret ENTRANT
  // uniquement : il n'existe jamais dans le DTO de sortie, le service le chiffre
  // au repos (apiTokenEnc) et ne renvoie que `hasApiToken`.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  apiBaseUrl?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  apiToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  apiUser?: string;

  // Projet Coolify cible pour les déploiements (uuid du projet). Absent ⇒ la
  // plateforme utilise le projet par défaut Coolify ("0").
  @IsOptional()
  @IsString()
  @MaxLength(64)
  coolifyProjectUuid?: string;

  // Serveur Coolify cible (uuid) pour les déploiements. Absent ⇒ la plateforme
  // utilise le serveur par défaut Coolify ("0").
  @IsOptional()
  @IsString()
  @MaxLength(64)
  coolifyServerUuid?: string;

  // Métriques annoncées (Phase 9bis) — auto-détectées via l'API du panneau quand
  // c'est possible (Hestia sysinfo), sinon saisies manuellement par l'admin.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1048576) // 1 To de RAM max raisonnable
  ramMb?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1024)
  cpuCores?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1048576)
  diskGb?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  bandwidthLimit?: string; // label libre, ex. "2 To / mois"
}
