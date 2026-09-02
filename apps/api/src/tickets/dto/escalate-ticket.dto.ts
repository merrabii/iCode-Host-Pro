import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsIn } from 'class-validator';

export class EscalateTicketDto {
  @ApiProperty({ enum: [Role.SUPPORT_L2, Role.SUPPORT_L3] })
  @IsIn([Role.SUPPORT_L2, Role.SUPPORT_L3])
  to!: Extract<Role, 'SUPPORT_L2' | 'SUPPORT_L3'>;
}
