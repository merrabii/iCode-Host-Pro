import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

// forwardRef: AuthModule depends on InvitationsService (accept-invite) while
// InvitationsModule depends on AuthModule (guards). Resolved lazily by Nest.
@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
