import { Type } from 'class-transformer';
import { InvoiceStatus, OrderStatus } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Socle commercial (GO P4 / lot B1 - visibilité) : pagination commune à toutes
 * les listes commandes/factures/clients. Convention alignée sur le journal
 * d'audit (`page` 1-based, `perPage` borné) — validation stricte : `page=0` est
 * un 400, pas un clamp silencieux.
 */
export class StorePageQueryDto {
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

/** Filtres de liste de commandes (statut exact + recherche libre). */
export class OrderListQueryDto extends StorePageQueryDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

/** Filtres de liste de factures (statut exact + recherche libre). */
export class InvoiceListQueryDto extends StorePageQueryDto {
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

/** Filtres de liste de clients (recherche email/nom). */
export class CustomerListQueryDto extends StorePageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
