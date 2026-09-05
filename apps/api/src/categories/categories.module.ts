import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

// Phase 12 (Catalog) — Catégories de produits. Lecture authentifiée (tout
// connecté), mutations ADMIN-only, audit. PrismaService + AuditService sont
// globaux (@Global) → injectés sans import.
@Module({
  imports: [AuthModule],
  controllers: [CategoriesController],
  providers: [CategoriesService],
})
export class CategoriesModule {}