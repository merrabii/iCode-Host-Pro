import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Une option configurable choisie : l'id d'un choix d'une option du produit. */
export class CheckoutOptionDto {
  @IsString()
  @IsNotEmpty()
  optionId!: string;

  @IsString()
  @IsNotEmpty()
  choiceId!: string;
}

/**
 * Corps du checkout guest (Bloc C). Montants JAMAIS reçus : tout est recalculé
 * serveur (produit + options + addons + taxe). La saisie porte uniquement les
 * identifiants de configuration et les coordonnées du client.
 */
export class CheckoutDto {
  @ApiProperty({ description: 'slug du produit (ex "managed-wp")' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  productSlug!: string;

  @ApiPropertyOptional({ type: [CheckoutOptionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutOptionDto)
  options?: CheckoutOptionDto[];

  @ApiPropertyOptional({ type: [String], description: 'ids des add-ons sélectionnés' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  addonIds?: string[];

  @ApiProperty({ description: 'valeurs des champs de facturation (key → valeur)' })
  @IsOptional()
  extraFields?: Record<string, string>;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @MinLength(2)
  name!: string;

  @ApiProperty({ description: 'email de réception des détails de compte' })
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^[+0-9 ()-]{6,20}$/, { message: 'phone invalide' })
  phone?: string;

  @ApiPropertyOptional({ description: 'sous-domaine choisi par le client (produits avec sous-domaine)' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, {
    message: 'Sous-domaine invalide (a-z, 0-9, tirets, pas de tiret aux extrémités).',
  })
  subdomain?: string;

  @ApiProperty({ description: 'id d’un moyen de paiement actif (PaymentMethod)' })
  @IsString()
  @IsNotEmpty()
  paymentMethodId!: string;

  @ApiPropertyOptional({
    description:
      'Membre connecté : true = réutiliser les coordonnées du compte (nom/email, défaut) ; false = facturer sous d’autres coordonnées (nom/email/téléphone du corps) — ex. une société.',
  })
  @IsOptional()
  @IsBoolean()
  useAccountDetails?: boolean;
}

/** Représentation lisible (jamais les secrets) d’un moyen de paiement pour /cart/checkout. */
export class PaymentMethodPublicView {
  id!: string;
  name!: string;
  type!: string;
  config?: Record<string, unknown> | null;
}