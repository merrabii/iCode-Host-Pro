import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Corps de POST /store/admin/orders/:id/cancel-provisioning (17B.4E-D-B1).
 * `reason` obligatoire — tracé dans OrderStatusHistory + AuditLog.
 * Aucun flag monétaire, aucun ID d'infra côté client.
 */
export class CancelProvisioningDto {
  @ApiProperty({
    description: 'Motif d’annulation du provisioning (audit + historique)',
    minLength: 8,
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: 'Le motif doit faire au moins 8 caractères.' })
  @MaxLength(500)
  reason!: string;
}
