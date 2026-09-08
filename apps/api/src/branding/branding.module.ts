import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandingService } from './branding.service';
import { BrandPublicController } from './brand-public.controller';
import { AdminBrandingController } from './admin-branding.controller';
import { BrandingAssetsController } from './branding-assets.controller';

// Phase 14 — branding white-label (un brand/install). Partie publique
// GET /api/brand (front Next) + mutations ADMIN + assets logo. AuthModule
// fournit JwtService (guards). La ligne singleton est garantie au démarrage.
@Module({
  imports: [AuthModule],
  providers: [BrandingService],
  controllers: [
    BrandPublicController,
    AdminBrandingController,
    BrandingAssetsController,
  ],
  exports: [BrandingService],
})
export class BrandingModule {}