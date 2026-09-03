import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  ClientKnowledgeController,
  KnowledgeController,
} from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

// Phase 11 — base de connaissance (admin + client). Acyclic: AuthModule only
// (guards + JwtPayload). Both controllers registered: the admin CRUD AND the
// public client catalogue.
@Module({
  imports: [AuthModule],
  controllers: [KnowledgeController, ClientKnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
