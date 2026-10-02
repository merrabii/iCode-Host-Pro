import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

/** GO socle (lot A1): "mot de passe oublie" — email only. The endpoint always
 *  answers the same way whether or not the account exists (no enumeration). */
export class ForgotPasswordDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;
}
