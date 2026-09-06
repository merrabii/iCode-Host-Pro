import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { BUILD_PACKS } from '../github.service';

// Phase 10bis (N) : un déploiement = un dépôt git + le Service ACTIVE du client
// (affecté par l'admin à un serveur Coolify connecté). DEUX modes (10bis.5) :
//  - mode GitHub lié : `repoFullName` (owner/repo autodétecté) ;
//  - mode URL collée : `repoUrl` (détection auto, sans liaison GitHub) — le
//    client peut corriger `buildPack` (suggéré) et `appName`.
// Exactement un des deux (`repoFullName` | `repoUrl`) est requis.
export class CreateDeploymentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  serviceId!: string;

  @ValidateIf((o) => !o.repoUrl)
  @IsString()
  @IsNotEmpty()
  @Matches(/^[\w.-]+\/[\w.-]+$/, {
    message: 'Format attendu : owner/repo (dépôt GitHub).',
  })
  @MaxLength(200)
  repoFullName?: string;

  @ValidateIf((o) => !o.repoFullName)
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  repoUrl?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  branch?: string;

  @IsOptional()
  @IsIn(BUILD_PACKS, { message: 'Build pack inconnu (nixpacks, dockerfile, dockercompose, static).' })
  buildPack?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  appName?: string;

  // Phase 3 — sous-domaine gratuit choisi par le client sous le domaine racine
  // (ex "monapp" → monapp.arumdigital.com). Vide/absent = slug automatique depuis
  // le nom de la Service. Alloué + CNAME créé via Cloudflare au déploiement.
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, {
    message: 'Sous-domaine invalide (lettres minuscules, chiffres, tirets).',
  })
  @MaxLength(63)
  subdomain?: string;
}
