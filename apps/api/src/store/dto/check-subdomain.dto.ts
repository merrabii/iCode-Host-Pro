import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Corps public de vérification du sous-domaine au checkout (Plan Gratuit/…). */
export class CheckSubdomainPublicDto {
  @ApiProperty({ description: 'slug du produit commandé (porteur d’une FreeSubdomainRule)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  productSlug!: string;

  @ApiProperty({ description: 'sous-domaine demandé par le client' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, {
    message: 'Sous-domaine invalide (a-z, 0-9, tirets, pas de tiret aux extrémités).',
  })
  subdomain!: string;

  @ApiPropertyOptional({
    description:
      'id du domaine racine choisi (Phase 4, multi-domaines). Requis quand plusieurs racines éligibles.',
  })
  @IsOptional()
  @IsString()
  requestedDomainId?: string;
}