import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/** GO Stripe — validation des entrées carte (stripte inconnu = rejet). */

export class CreateCardTopupDto {
  @IsInt()
  @Min(100) // 1,00 (identique à la recharge virement)
  @Max(10_000_000) // 100 000,00
  amountCents!: number;

  /** Devise de la recharge — doit ÊTRE la devise du portefeuille (pas de change). */
  @IsOptional()
  @IsIn(['USD', 'EUR'])
  currency?: string;

  /** Clé d'idempotence fournie par le client (double-clic = une session). */
  @IsOptional()
  @IsString()
  @Length(8, 128)
  idempotencyKey?: string;
}

export class SaveProviderDto {
  @IsIn(['stripe'])
  code!: 'stripe';

  @IsString()
  @Length(1, 80)
  displayName!: string;

  @IsBoolean()
  isActive!: boolean;

  /** LIVE refusé explicitement dans ce lot (voir service). */
  @IsOptional()
  @IsIn(['test'])
  environment?: 'test';

  @IsOptional()
  @IsBoolean()
  liveEnabled?: boolean;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  merchantAccount?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  publishableKey?: string;

  /** Écriture seule : jamais retournée à l'UI (indicateur hasSecretKey). */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  secretKey?: string;

  @IsOptional()
  @IsString()
  @Length(1, 400)
  webhookSecret?: string;

  @IsOptional()
  @IsString()
  @Length(1, 300)
  webhookEndpointUrl?: string;

  @IsOptional()
  @IsArray()
  @IsIn(['USD', 'EUR'], { each: true })
  allowedCurrencies?: string[];
}

export class CreateCardRefundDto {
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  amountCents!: number;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  reason?: string;
}

export class AdminCardPaymentQueryDto {
  // `page`/`perPage` arrivent en chaîne depuis l'URL : sans `@Type(Number)` la
  // validation rejette toute liste paginée (l'UI admin envoie page & perPage).
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

  @IsOptional()
  @IsString()
  @Length(0, 120)
  q?: string;

  @IsOptional()
  @IsIn([
    'CREATED',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'CANCELED',
    'EXPIRED',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'NEEDS_REVIEW',
  ])
  status?: string;
}

export class SimulatedCompleteDto {
  @IsIn(['success', 'failed', 'expired'])
  outcome!: 'success' | 'failed' | 'expired';
}

export class ResolveInterventionDto {
  @IsString()
  @Length(3, 300)
  note!: string;
}

export class CancelCardRefundDto {
  @IsOptional()
  @IsString()
  @Length(0, 300)
  reason?: string;
}
