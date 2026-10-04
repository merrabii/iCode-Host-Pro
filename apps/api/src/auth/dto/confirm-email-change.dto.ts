import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/** GO Q3 : consomme le jeton unique reçu sur la NOUVELLE adresse email et
 *  bascule User.email (confirmation atomique, usage unique). Le jeton brut
 *  n'existe que dans le lien email (sha256 au repos). */
export class ConfirmEmailChangeDto {
  @ApiProperty({ description: 'One-time token from the verification email' })
  @IsString()
  @MinLength(1)
  token!: string;
}
