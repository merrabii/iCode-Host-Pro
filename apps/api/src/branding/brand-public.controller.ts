import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BrandingService } from './branding.service';

/**
 * Partie publique du branding — PAS de guard : le front (Next) l'appelle sans
 * session pour le nom, le logo et les couleurs à l'init. Ne renvoie jamais
 * d'id interne, de timestamps ni de updatedById (toPublic).
 */
@ApiTags('brand')
@Controller('brand')
export class BrandPublicController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  @ApiOperation({ summary: 'Public branding (name, logo, colors) — no auth' })
  get() {
    return this.branding.getPublic();
  }
}