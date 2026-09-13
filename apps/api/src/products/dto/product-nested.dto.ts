import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// ── Onglet 4 — catégories liées (multi, ProductCategoryLink) ─────────────
/** Remplace l'ensemble des catégories liées du produit (transaction). */
export class SetCategoriesDto {
  @ApiPropertyOptional({ type: [String], description: 'categoryIds (nouvel ensemble)' })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  categoryIds!: string[];
}

// ── Onglet 5/8 — règle des sous-domaines gratuits (1:1, upsert) ──────────
export class UpsertFreeSubdomainRuleDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedDomainIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  reservedPrefixes?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  minLength?: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(80)
  maxLength?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  allowedChars?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  rejectPattern?: string;
}

// ── Onglet 6 — option configurable + ses choix ───────────────────────────
export class CreateOptionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

export class UpdateOptionDto extends PartialType(CreateOptionDto) {}

export class CreateOptionChoiceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label!: string;

  @IsInt()
  priceDeltaHtCents!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

export class UpdateOptionChoiceDto extends PartialType(CreateOptionChoiceDto) {
  // `priceDeltaHtCents` peut être 0 : l'update partiel doit toutefois pouvoir
  // le préciser ; PartialType le rend optionnel, 0 est accepté via IsInt.
}

// ── Onglet 7 — supplément / add-on ───────────────────────────────────────
export class CreateAddonDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @IsInt()
  priceHtCents!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

export class UpdateAddonDto extends PartialType(CreateAddonDto) {}

// ── Réordonnancement (générique, comme checkout-fields) ──────────────────
export class ReorderDto {
  @ApiPropertyOptional({ type: [String], description: 'ids dans le nouvel ordre' })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids!: string[];
}