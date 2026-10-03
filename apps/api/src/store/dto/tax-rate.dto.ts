import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * GO P5 (lot B2) — administration des taux de taxe (décision §6-6 : page
 * dédiée `/manager/taxe`). `ratePercent` borné 0..100 (Decimal(5,2)) ;
 * `isDefault` = taux appliqué aux produits sans `taxRateId` — UN SEUL défaut
 * à la fois (garanti en transaction côté service).
 */
export class CreateTaxRateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  ratePercent!: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateTaxRateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  ratePercent?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
