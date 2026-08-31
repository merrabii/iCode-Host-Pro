import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

// Phase 5 (ADR-020): an ADMIN invites a NEW user by email. Public registration
// is closed. The raw one-time token is returned once and surfaced in /manager.
export class CreateInvitationDto {
  @ApiProperty({ example: 'guest@example.com' })
  @IsEmail()
  email!: string;
}
