import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

export class SupportAccessDto {
  @ApiProperty({ example: '123456', description: '6-digit code relayed by the client' })
  @Matches(/^\d{6}$/)
  code!: string;

  @ApiPropertyOptional({ description: 'Cloudflare Turnstile token (when enabled)' })
  @IsOptional()
  @IsString()
  turnstileToken?: string;
}
