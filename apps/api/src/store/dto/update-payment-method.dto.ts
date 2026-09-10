import { ApiPropertyOptional } from '@nestjs/swagger';
import { FeeType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  Min,
} from 'class-validator';

/**
 * PATCH admin d'un PaymentMethod — active/désactive, ordre d'affichage,
 * config d'affichage NON secrète (coordonnées virement, instructions) et frais.
 * `configEnc` (secrets carte) n'est JAMAIS modifiable/exposé via l'API.
 */
export class UpdatePaymentMethodDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @ApiPropertyOptional({ description: 'Config non secrète (coordonnées virement, instructions)' })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: FeeType })
  @IsOptional()
  @IsEnum(FeeType)
  feeType?: FeeType;

  @ApiPropertyOptional({ description: '% si feeType=PERCENT' })
  @IsOptional()
  @IsNumber()
  feePercent?: number;

  @ApiPropertyOptional({ description: 'frais fixe en cents si feeType=FIXED' })
  @IsOptional()
  @IsInt()
  @Min(0)
  feeFixedCents?: number;
}
