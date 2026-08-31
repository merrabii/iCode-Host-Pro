import { IsEmail, IsString } from 'class-validator';

// Phase 6 (ADR-022): payload for the test email endpoint.
export class TestMailDto {
  @IsEmail()
  @IsString()
  to: string;
}