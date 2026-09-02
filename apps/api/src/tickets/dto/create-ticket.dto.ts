import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TicketPriority } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateTicketDto {
  @ApiProperty({ example: 'Impossible de me connecter' })
  @IsString()
  @MinLength(3)
  subject!: string;

  @ApiProperty({ example: 'Depuis ce matin, mon accès client renvoie une erreur…' })
  @IsString()
  @MinLength(5)
  body!: string;

  @ApiPropertyOptional({ enum: TicketPriority, default: TicketPriority.NORMAL })
  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;
}
