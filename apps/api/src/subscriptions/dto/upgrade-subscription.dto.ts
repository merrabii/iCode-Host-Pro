import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

// Phase 13 (upgrade) : mise à niveau d'une souscription ACTIVE vers un autre
// produit/pack — la MÊME ligne d'abonnement est basculée (services, apps et
// données préservés), seules les limites/quota des PROCHAINS déploiements
// changent. Le produit cible doit être disponible et son pack actif.
export class UpgradeSubscriptionDto {
  @ApiProperty({ description: 'Product id (pack supérieur) à basculer' })
  @IsString()
  @IsNotEmpty()
  productId!: string;
}
