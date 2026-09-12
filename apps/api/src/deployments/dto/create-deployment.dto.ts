import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { BUILD_PACKS } from '../github.service';

// Phase 10bis (N) : un déploiement = un dépôt git + une cible. DEUX modes
// (10bis.5) :
//  - mode GitHub lié : `repoFullName` (owner/repo autodétecté) ;
//  - mode URL collée : `repoUrl` (détection auto, sans liaison GitHub) — le
//    client peut corriger `buildPack` (suggéré) et `appName`.
// Exactement un des deux (`repoFullName` | `repoUrl`) est requis.
// (Bloc 4 : la table `Service` a été supprimée — la cible est TOUJOURS résolue
// automatiquement depuis le pack ACTIF du client → module A/B.)
export class CreateDeploymentDto {
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

  // ── Phase 16 — build « file-based » (codediali.toml / page de build) ──────
  // Champs édités par le client sur la page de build professionnelle, pré-remplis
  // par le serveur depuis codediali.toml/netlify.toml/détection. Serveur re-sane
  // et re-déduit : jamais reçus du client en autorité sinueuse.
  @IsOptional()
  @IsString()
  @MaxLength(400)
  baseDirectory?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  buildCommand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  installCommand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  publishDirectory?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  functionsDirectory?: string;

  @IsOptional()
  @IsObject()
  environment?: Record<string, string>;
}
