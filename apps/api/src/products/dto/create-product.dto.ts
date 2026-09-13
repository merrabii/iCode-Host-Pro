import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { BillingCycle, ProductStatus } from '@prisma/client';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  kind?: string;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  // Phase 12 (Catalog) — classification + ressources. Optionnels (rétro-compatible
  // avec les produits sans catégorie/pack ; existence vérifiée au service).
  @IsOptional()
  @IsString()
  @MaxLength(60)
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  packId?: string;

  // ── Bloc A (page produit 10 onglets) — champs store-front (onglets 1 & 2) ──
  // Tous optionnels pour rester rétro-compatible ; '' côté update = effacer.

  @IsOptional()
  @IsString()
  @MaxLength(160)
  slug?: string | null; // URL publique /store/<slug>

  @IsOptional()
  @IsString()
  @MaxLength(200)
  slogan?: string | null; // cross-sell panier

  @IsOptional()
  @IsString()
  @MaxLength(600)
  shortDescription?: string | null; // ≤ 50 mots (description courte, cross-sell)

  @IsOptional()
  @IsBoolean()
  freePlan?: boolean; // $0, inscription directe

  @IsOptional()
  @IsString()
  @MaxLength(6000)
  description?: string | null; // HTML basique (br/strong/em)

  @IsOptional()
  @IsString()
  @MaxLength(24)
  color?: string | null; // accent visuel de la fiche

  @IsOptional()
  @IsBoolean()
  hidden?: boolean; // « Créer en tant que Masqué » — prime sur ACTIVE

  @IsOptional()
  @IsInt()
  displayOrder?: number; // ordre d'affichage vitrine

  @IsOptional()
  @IsInt()
  @Min(0)
  priceHtCents?: number | null; // prix HT en centimes

  @IsOptional()
  @IsInt()
  @Min(0)
  promoPriceHtCents?: number | null; // prix promo HT (affiché barré)

  @IsOptional()
  @IsEnum(BillingCycle)
  billingCycle?: BillingCycle; // MONTHLY | YEARLY | ONETIME

  @IsOptional()
  @IsString()
  @MaxLength(60)
  taxRateId?: string | null; // taux référencé (null = exonéré)

  @IsOptional()
  @IsBoolean()
  domainRequired?: boolean; // active l'étape « choix du domaine » au checkout

  @IsOptional()
  @IsString()
  @MaxLength(80)
  welcomeEmailTemplate?: string | null; // template de bienvenue (après provisioning)

  @IsOptional()
  @IsBoolean()
  stockEnabled?: boolean; // stock limité on/off

  @IsOptional()
  @IsInt()
  @Min(0)
  stockQty?: number | null; // quantité si stock limité

  @IsOptional()
  @IsBoolean()
  crossSell?: boolean; // éligible ventes croisées
}