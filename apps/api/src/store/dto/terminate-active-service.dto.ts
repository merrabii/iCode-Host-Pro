import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Corps de POST /store/admin/orders/:id/terminate (17B.4E-E2-B).
 * `reason` obligatoire — tracé dans OrderStatusHistory + AuditLog.
 * Aucun flag monétaire, aucun ID d'infra côté client, aucun statut pilotable.
 */
export class TerminateActiveServiceDto {
  @ApiProperty({
    description: 'Motif de terminaison du service (audit + historique)',
    minLength: 8,
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: 'Le motif doit faire au moins 8 caractères.' })
  @MaxLength(500)
  reason!: string;
}
