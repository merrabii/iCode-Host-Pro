import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** GO socle (lot A1): consume the one-time token received by email and set the
 *  new password. The raw token exists only in the email link (sha256 at rest). */
export class ResetPasswordDto {
  @ApiProperty({ description: 'One-time token from the reset email' })
  @IsString()
  token!: string;

  @ApiProperty({ description: 'New password - min 8 characters' })
  @IsString()
  @MinLength(8)
  password!: string;
}
