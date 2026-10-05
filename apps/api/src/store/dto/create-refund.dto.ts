import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RefundKind } from '@prisma/client';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * GO Q9 — création d'un remboursement (ADMIN). La clé d'idempotence n'est PAS
 * dans le corps : elle voyage dans le header `Idempotency-Key` (même contrat
 * que le checkout) et est validée par le service avant toute écriture.
 */
export class CreateRefundDto {
  /** Montant à rembourser en cents, strictement positif (plafond = encaissé). */
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amountCents!: number;

  @IsEnum(RefundKind)
  kind!: RefundKind;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;

  /** Émettre un avoir (Invoice lié par creditNoteOfId) — wallet uniquement. */
  @IsOptional()
  @IsBoolean()
  issueCreditNote?: boolean;
}
