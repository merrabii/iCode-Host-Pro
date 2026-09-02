import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class MfaSetupDto {
  @ApiProperty({ description: 'Password re-verification before enabling TOTP' })
  @IsString()
  @MinLength(8)
  password!: string;
}