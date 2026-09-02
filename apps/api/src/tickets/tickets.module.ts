import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SupportTicketsController, TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

// Phase 10 (ADR-027): minimal support tickets. Acyclic — AuthModule only.
// Both controllers are registered: the client-facing /api/tickets AND the
// support console queue /api/support/tickets (L1+).
@Module({
  imports: [AuthModule],
  controllers: [TicketsController, SupportTicketsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
