import { Transform, Type } from 'class-transformer';
import { WalletTxStatus } from '@prisma/client';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * GO P6 (lot C2 + C3a) — DTOs du portefeuille.
 * `amountCents` : entier strict (multipart = string → `@Type(Number)`), bornes
 * [100 ; 10 000 000] (1 USD → 100 000 USD) — le service re-bloque aussi.
 */
export class CreateRechargeDto {
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(10_000_000)
  amountCents!: number;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}

export class RejectRechargeDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  reason?: string;
}

/**
 * GO Q8 — validation admin : référence de rapprochement bancaire OBLIGATOIRE
 * (unicité DB = un encaissement ne finance qu'un crédit). Le montant, la
 * devise et l'acteur sont déjà figés sur la ligne ; ce DTO n'ajoute que la
 * preuve du rapprochement.
 */
export class ValidateRechargeDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  bankRef!: string;
}

/** Pagination stricte (convention P4 : page=0 → 400, perPage borné à 200). */
export class WalletPageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  perPage?: number;
}

/** Liste admin des recharges : statut + recherche (référence / email client). */
export class AdminRechargeQueryDto extends WalletPageQueryDto {
  @IsOptional()
  @IsIn([WalletTxStatus.PENDING, WalletTxStatus.SUCCEEDED, WalletTxStatus.CANCELED])
  status?: WalletTxStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
