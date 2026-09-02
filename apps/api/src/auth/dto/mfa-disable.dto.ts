import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';

export class MfaDisableDto {
  @ApiProperty({ description: 'Password re-verification' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ example: '123456', description: 'Current 6-digit TOTP code' })
  @Matches(/^\d{6}$/)
  code!: string;
}