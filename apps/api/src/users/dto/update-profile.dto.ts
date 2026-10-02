import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/** GO socle (lot A1): self-service profile edit — only the caller's OWN account
 *  (route PATCH /users/me, JWT-bound). At least one field must be provided;
 *  an empty/blank name clears it (null). The email uniqueness rule mirrors
 *  register/invitation: exact match, conflict on an existing other account. */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Ada Lovelace', description: 'Blank clears the name' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'ada@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;
}
