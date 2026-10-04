import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClosureRequestStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** GO Q3 : ouverture d'une demande de clôture de compte (demander, pas
 *  exécuter — aucune pièce financière n'est supprimée). */
export class RequestClosureDto {
  @ApiPropertyOptional({
    example: 'Je neutilise plus la plateforme.',
    description: 'Motif facultatif de la demande de clôture',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** GO Q3 : décision admin sur une demande PENDING (tranche, n'exécute pas). */
export class ResolveClosureDto {
  @ApiProperty({ enum: ClosureRequestStatus, description: 'COMPLETED ou CANCELLED' })
  @IsEnum(ClosureRequestStatus)
  status!: ClosureRequestStatus;

  @ApiPropertyOptional({ description: 'Note interne facultative' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
