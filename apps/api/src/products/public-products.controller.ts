import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProductsService } from './products.service';

/**
 * Phase 10 (ADR-027): PUBLIC catalogue — no guard at all, browsable by a
 * visitor. Only orderable products (DRAFT/DISABLED are hidden). The existing
 * `GET /api/products` stays authenticated (non-regression, core e2e).
 */
@ApiTags('public/products')
@Controller('public/products')
export class PublicProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @ApiOperation({ summary: 'Public catalogue — orderable products only (no auth)' })
  findAll() {
    return this.products.findPublicCatalog();
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Public product page by slug — orderable products only (no auth), Étape 2' })
  findBySlug(@Param('slug') slug: string) {
    return this.products.findPublicBySlug(slug);
  }
}
