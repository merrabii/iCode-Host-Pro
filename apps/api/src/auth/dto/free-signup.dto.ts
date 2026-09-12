import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { RegisterDto } from './register.dto';

/** Inscription autonome du Plan Gratuit (sans checkout-intent) — boundée au
 *  produit marqué `freePlan` pour garder la surface minimale (Phase 16). */
export class FreeSignupDto extends RegisterDto {
  @ApiPropertyOptional({ example: 'plan-gratuit' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  planSlug?: string;
}