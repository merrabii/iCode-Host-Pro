import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

// Phase 5 (ADR-020): inscription fermée. Le seul moyen de créer un compte USER
// est d'accepter une invitation ADMIN via un jeton ponctuel.
export class AcceptInviteDto {
  @ApiProperty({ description: 'Raw invitation token (one-time, returned once to the admin)' })
  @IsString()
  token!: string;

  @ApiProperty({ example: 'guest@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiPropertyOptional({ example: 'Ada' })
  @IsOptional()
  @IsString()
  name?: string;
}
