import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class TicketMessageDto {
  @ApiProperty({ example: 'Nous avons corrigé le problème, merci de réessayer.' })
  @IsString()
  @MinLength(1)
  body!: string;
}
