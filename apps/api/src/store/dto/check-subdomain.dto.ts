import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

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
}