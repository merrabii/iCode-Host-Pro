import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateStoreSettingsDto } from './dto/update-store-settings.dto';
import {
  CreateCheckoutFieldDto,
  UpdateCheckoutFieldDto,
  ReorderCheckoutFieldsDto,
} from './dto/checkout-field.dto';

// Phase 2 (ADR-017): Product is a PLATFORM-GLOBAL reference (catalog item).
// - Read (GET): any authenticated user (ADMIN + USER) — it is a public catalogue
//   reference that future client consumers will rely on.
// - Mutation (POST/PATCH/DELETE): ADMIN only.
@ApiTags('products')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a product (ADMIN)' })
  create(@Body() dto: CreateProductDto, @CurrentUser() actor: JwtPayload) {
    return this.products.create(dto, actor);
  }

  @Get()
  @ApiOperation({ summary: 'List products (any authenticated)' })
  findAll() {
    return this.products.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one product (any authenticated)' })
  findOne(@Param('id') id: string) {
    return this.products.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a product (ADMIN)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.update(id, dto, actor);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete a product (ADMIN)' })
  remove(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.products.remove(id, actor);
  }

  // ── Réglages store par produit (ADMIN) ────────────────────────────
  @Patch(':id/store-settings')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update per-product store settings (ADMIN)' })
  updateStoreSettings(
    @Param('id') id: string,
    @Body() dto: UpdateStoreSettingsDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.updateStoreSettings(id, dto, actor);
  }

  @Get(':id/checkout-fields')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List checkout fields of a product (ADMIN)' })
  listCheckoutFields(@Param('id') id: string) {
    return this.products.listCheckoutFields(id);
  }

  @Post(':id/checkout-fields')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a checkout field (ADMIN)' })
  createCheckoutField(
    @Param('id') id: string,
    @Body() dto: CreateCheckoutFieldDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.createCheckoutField(id, dto, actor);
  }

  @Patch('checkout-fields/:fieldId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a checkout field (ADMIN)' })
  updateCheckoutField(
    @Param('fieldId') fieldId: string,
    @Body() dto: UpdateCheckoutFieldDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.updateCheckoutField(fieldId, dto, actor);
  }

  @Delete('checkout-fields/:fieldId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete a checkout field (ADMIN)' })
  deleteCheckoutField(@Param('fieldId') fieldId: string, @CurrentUser() actor: JwtPayload) {
    return this.products.deleteCheckoutField(fieldId, actor);
  }

  @Post(':id/checkout-fields/reorder')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Reorder checkout fields (ADMIN)' })
  reorderCheckoutFields(
    @Param('id') id: string,
    @Body() dto: ReorderCheckoutFieldsDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.reorderCheckoutFields(id, dto.ids, actor);
  }
}