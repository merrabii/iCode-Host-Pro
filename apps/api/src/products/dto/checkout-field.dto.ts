import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { CheckoutFieldType } from '@prisma/client';
import {
  ArrayNotEmpty,
  IsArray,
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

/** Champ de facturation configurable d'un produit (admin). */
export class CreateCheckoutFieldDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  key!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label!: string;

  @IsOptional()
  @IsEnum(CheckoutFieldType)
  type?: CheckoutFieldType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  placeholder?: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

export class UpdateCheckoutFieldDto extends PartialType(CreateCheckoutFieldDto) {}

export class ReorderCheckoutFieldsDto {
  @ApiPropertyOptional({ type: [String], description: 'ids dans le nouvel ordre' })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids!: string[];
}