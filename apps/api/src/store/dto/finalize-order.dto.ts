import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Corps de POST /store/admin/orders/:id/finalize (17B.4F-C4).
 * `reason` obligatoire — tracé dans l'audit de finalisation. Aucun booléen de
 * contournement, aucun identifiant d'infra côté client, aucune preuve fournie
 * par l'entrée HTTP (la preuve est relue côté serveur).
 */
export class FinalizeOrderDto {
  @ApiProperty({
    description: "Motif de la finalisation C4 (audit)",
    minLength: 8,
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: 'Le motif doit faire au moins 8 caractères.' })
  @MaxLength(500)
  reason!: string;
}
