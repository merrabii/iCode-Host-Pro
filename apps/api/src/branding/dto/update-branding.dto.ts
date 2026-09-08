import { IsBoolean, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { BrandLogoType } from '@prisma/client';

/** Hex couleur strict #RRGGBB (minuscules acceptées, normalisées au service). */
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Phase 14 — mise à jour du branding white-label (singleton). Tous les champs
 * sont optionnels : seuls ceux présents sont appliqués. `null` efface un champ
 * nullable (tagline, hostname, logoText, accentColor). primaryColor/accentColor
 * doivent être des hex #RRGGBB valides.
 */
export class UpdateBrandingDto {
  /** Nom de la marque — peut être VIDE : une marque « image seule » n'affiche pas de nom. */
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  sub?: string;

  @IsOptional()
  @IsString()
  tagline?: string | null;

  @IsOptional()
  @IsString()
  hostname?: string | null;

  @IsOptional()
  @IsIn(['DEFAULT', 'TEXT', 'IMAGE'])
  logoType?: BrandLogoType;

  @IsOptional()
  @IsString()
  logoText?: string | null;

  /** IMAGE : afficher aussi le wordmark à côté du logo (défaut false). */
  @IsOptional()
  @IsBoolean()
  logoShowText?: boolean;

  @IsOptional()
  @Matches(HEX, { message: 'primaryColor doit être un hex #RRGGBB.' })
  primaryColor?: string;

  @IsOptional()
  @Matches(HEX, { message: 'accentColor doit être un hex #RRGGBB.' })
  accentColor?: string | null;
}