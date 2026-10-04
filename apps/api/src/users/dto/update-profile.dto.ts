import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/** GO socle (lot A1) + GO Q3: self-service profile edit — only the caller's
 *  OWN account (route PATCH /users/me, JWT-bound). At least one field must be
 *  provided; an empty/blank name clears it (null). Email: **no immediate
 *  write** — the request sends a verification link to the NEW address and
 *  User.email changes only after confirmation (POST /auth/confirm-email-change);
 *  the 409 pre-check is UX only, the uniqueness that counts is the constraint
 *  re-checked inside the confirmation transaction. */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Ada Lovelace', description: 'Blank clears the name' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'ada@example.com', description: 'Pending until verified via the link sent to this address' })
  @IsOptional()
  @IsEmail()
  email?: string;
}
