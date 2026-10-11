import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * PATCH admin des PARCOURS de paiement (PaymentSettings, singleton) :
 * trois interrupteurs indépendants, persistés en base (aucune édition d'env).
 * Aucun secret ici — seuls des booléens d'activation.
 */
export class UpdatePaymentSettingsDto {
  @ApiPropertyOptional({
    description: 'Règlement d’une commande par solde (portefeuille)',
  })
  @IsOptional()
  @IsBoolean()
  walletPaymentEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Paiement direct d’une commande par carte (sans passage par le solde)',
  })
  @IsOptional()
  @IsBoolean()
  cardOrderPaymentEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Recharge du portefeuille par carte' })
  @IsOptional()
  @IsBoolean()
  cardTopupEnabled?: boolean;
}
