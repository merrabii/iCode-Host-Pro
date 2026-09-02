import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class OauthUnlinkDto {
  @ApiProperty({ enum: ['google', 'github'] })
  @IsIn(['google', 'github'])
  provider!: 'google' | 'github';
}