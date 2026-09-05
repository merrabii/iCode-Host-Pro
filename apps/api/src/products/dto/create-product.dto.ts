import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ProductStatus } from '@prisma/client';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  kind?: string;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  // Phase 12 (Catalog) — classification + ressources. Optionnels (rétro-compatible
  // avec les produits sans catégorie/pack ; existence vérifiée au service).
  @IsOptional()
  @IsString()
  @MaxLength(60)
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  packId?: string;
}