import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateProductDto } from './create-product.dto';

/** Paramètres du déploiement par défaut du produit (moduleParams de Coolify :
 *  repoUrl → l'URL du dépôt/du site static déployé à la première commande). */
export class ProductModuleParamsDto {
  @IsOptional()
  @IsString()
  @MaxLength(400)
  repoUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  branch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  buildPack?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  appName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  publishDirectory?: string;

  @IsOptional()
  @IsBoolean()
  isStatic?: boolean;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {
  // ── Déploiement par défaut (admin) — ce que le provisioning déploie pour la
  //    première commande (ex. le Plan Gratuit sert un site static depuis une URL).
  @IsOptional()
  @IsObject()
  moduleParams?: ProductModuleParamsDto;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  provisionModuleId?: string;

  // Sécurité : ne jamais autoriser l'admin à passer un objet Json arbitraire ;
  // moduleParams est whitelisté aux clés ci-dessus.

  // (ModuleParams est un objet Json côté Prisma ; on n'expose que les clés utiles.)
}