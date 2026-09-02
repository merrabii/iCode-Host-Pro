import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class MfaConfirmDto {
  @ApiProperty({ example: '123456', description: '6-digit TOTP code' })
  @Matches(/^\d{6}$/)
  code!: string;
}