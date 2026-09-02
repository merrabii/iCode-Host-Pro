import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { SupportCodesController } from './support-codes.controller';
import { SupportCodesService } from './support-codes.service';

// Phase 10 (ADR-027): the 6-digit support access code. Imports AuthModule for
// the guards, the rate limiter, Turnstile, security-settings and the
// impersonation primitive (AuthService), and MailModule for the best-effort
// email delivery of the code — acyclic (AuthModule never imports us).
@Module({
  imports: [AuthModule, MailModule],
  controllers: [SupportCodesController],
  providers: [SupportCodesService],
  exports: [SupportCodesService],
})
export class SupportModule {}
