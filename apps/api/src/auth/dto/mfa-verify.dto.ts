import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';

export class MfaVerifyDto {
  @ApiProperty({ description: 'Challenge id from the login response' })
  @IsString()
  challengeId!: string;

  @ApiProperty({ example: '123456', description: '6-digit code (TOTP or email)' })
  @Matches(/^\d{6}$/)
  code!: string;

  @ApiProperty({ enum: ['totp', 'email'] })
  @IsIn(['totp', 'email'])
  method!: 'totp' | 'email';
}