import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class MfaEmailSendDto {
  @ApiProperty({ description: 'Challenge id from the login response' })
  @IsString()
  challengeId!: string;
}