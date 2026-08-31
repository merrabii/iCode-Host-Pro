import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

// forwardRef: AuthModule depends on InvitationsService (accept-invite) while
// InvitationsModule depends on AuthModule (guards). Resolved lazily by Nest.
// MailModule (Phase 6, ADR-022): best-effort automatic invitation emails when
// the admin has enabled the SMTP settings.
@Module({
  imports: [forwardRef(() => AuthModule), MailModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
