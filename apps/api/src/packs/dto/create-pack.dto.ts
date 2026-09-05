import { PartialType } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PackStatus } from '@prisma/client';

export class CreatePackDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  // Limites de ressources — RAM obligatoire ; CPU par défaut à 1 (validation
  // IsPositive pour rejeter 0/négatif), disque >= 0 (opt), bande passante libellé.
  @IsInt()
  @Min(1)
  ramMb!: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  cpuCores?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  diskGb?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  bandwidth?: string;

  @IsOptional()
  @IsEnum(PackStatus)
  status?: PackStatus;
}

export class UpdatePackDto extends PartialType(CreatePackDto) {}