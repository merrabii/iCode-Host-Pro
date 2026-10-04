import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Q-A (GO item 4) — armement/révocation du renouvellement automatique d'une
 * commande récurrente par le client. `enabled=true` = consentement explicite
 * (daté en base) ; `enabled=false` = révocation immédiate (le consentement
 * historique reste daté, `autoRenew` bascule à false).
 */
export class RenewalToggleDto {
  @ApiProperty({
    description:
      'true = activer le renouvellement automatique (consentement daté) ; false = le révoquer immédiatement.',
  })
  @IsBoolean()
  enabled!: boolean;
}
