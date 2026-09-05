import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PacksController } from './packs.controller';
import { PacksService } from './packs.service';

// Phase 12 (Catalog) — Packs d'hébergement (limites RAM/CPU/disque/bande
// passante). Lecture authentifiée, mutations ADMIN-only, audit.
@Module({
  imports: [AuthModule],
  controllers: [PacksController],
  providers: [PacksService],
})
export class PacksModule {}