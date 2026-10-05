import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
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

  @ApiPropertyOptional({
    description:
      'id du domaine racine explicitement choisi par le client (Phase 4, multi-domaines). ' +
      'Obligatoire quand plusieurs racines sont éligibles pour ce produit (sinon erreur d’ambiguïté).',
  })
  @IsOptional()
  @IsString()
  requestedDomainId?: string;

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

  @ApiPropertyOptional({
    description:
      'Consentement EXPLICITE au renouvellement automatique (produits récurrents) — Q-A (GO item 4). ' +
      'Sans cette case cochée, aucun prélèvement automatique ne sera JAMAIS planifié.',
  })
  @IsOptional()
  @IsBoolean()
  renewalConsent?: boolean;

  @ApiPropertyOptional({
    description:
      'Total TTC (centimes) tel qu’AFFICHÉ/accepté par le client sur son dernier devis serveur ' +
      '— Q7 (GO item 7). OBLIGATOIRE pour toute commande payante (GO P7 : l’omission est un ' +
      'refus 409 PRICING_CHANGED, jamais un contournement) ; commande gratuite (total 0) : ' +
      'facultatif, mais si fourni il doit valoir 0. Si le tarif a changé depuis (prix, promo, ' +
      'taxe, frais), le serveur refuse en 409 (code PRICING_CHANGED) pour imposer une NOUVELLE ' +
      'acceptation.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  acceptedTotalTtcCents?: number;

  @ApiPropertyOptional({
    description:
      'Devise (ISO 4217, ex « USD ») affichée/acceptée par le client — OBLIGATOIRE pour une ' +
      'commande payante (GO P7 : la preuve couvre la devise, pas seulement un total numérique).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'acceptedCurrency invalide (ISO 4217, ex USD).' })
  acceptedCurrency?: string;

  @ApiPropertyOptional({
    description:
      'Moyen de paiement affiché/accepté (ses frais inclus dans le total accepté) — ' +
      'OBLIGATOIRE pour une commande payante (GO P7). Doit correspondre au paymentMethodId ' +
      'de la commande.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  acceptedPaymentMethodId?: string;

  @ApiPropertyOptional({
    description:
      'Empreinte (sha256) du devis accepté, renvoyée par POST /store/quote — OBLIGATOIRE ' +
      'pour une commande payante (GO P7 : couvre configuration, prix, promo, taux de taxe, ' +
      'installation et frais ; toute divergence refuse en 409 même à total inchangé).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  acceptedQuoteKey?: string;
}

/** Représentation lisible (jamais les secrets) d’un moyen de paiement pour /cart/checkout. */
export class PaymentMethodPublicView {
  id!: string;
  name!: string;
  type!: string;
  config?: Record<string, unknown> | null;
  /** Q7 — frais APPLIQUÉS au total (plus seulement journalisés côté admin). */
  feeType!: string;
  feePercent?: number | null;
  feeFixedCents?: number | null;
}

/**
 * Corps du devis / re-fetch des prix du panier (GO P5, lot B2) : la config
 * d’achat du checkout SANS coordonnées ni moyen de paiement — aucun montant
 * n’est jamais reçu du client (tout est recalculé serveur, même `buildPricing`
 * que la commande).
 */
export class QuoteDto {
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

  @ApiPropertyOptional({
    description:
      'Moyen de paiement cible (Q7, GO item 7) : les FRAIS configurés sur ce moyen ' +
      '(feeType/feePercent/feeFixedCents) sont alors APPLIQUÉS dans le devis, comme dans la ' +
      'commande. Omis (étape /cart) = devis sans frais de paiement.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  paymentMethodId?: string;
}