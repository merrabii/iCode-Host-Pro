import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
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
import {
  SetCategoriesDto,
  UpsertFreeSubdomainRuleDto,
  CreateOptionDto,
  UpdateOptionDto,
  CreateOptionChoiceDto,
  UpdateOptionChoiceDto,
  CreateAddonDto,
  UpdateAddonDto,
  ReorderDto,
} from './dto/product-nested.dto';

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

  @Get('provision-methods')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List active provision methods (ADMIN)' })
  listActiveProvisionMethods() {
    return this.products.listActiveProvisionMethods();
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

  // ── Onglet 4 — catégories liées (multi, ProductCategoryLink) ─────────────
  @Get(':id/categories')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List categories linked to a product (ADMIN)' })
  listCategoryLinks(@Param('id') id: string) {
    return this.products.listCategoryLinks(id);
  }

  @Put(':id/categories')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Replace the linked categories of a product (ADMIN)' })
  setCategories(
    @Param('id') id: string,
    @Body() dto: SetCategoriesDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.setCategories(id, dto.categoryIds, actor);
  }

  @Delete(':id/categories/:categoryId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Unlink a category from a product (ADMIN)' })
  unlinkCategory(
    @Param('id') id: string,
    @Param('categoryId') categoryId: string,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.unlinkCategory(id, categoryId, actor);
  }

  // ── Onglet 5/8 — règle des sous-domaines gratuits (1:1, upsert) ──────────
  @Get(':id/free-subdomain-rule')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Get the free-subdomain rule of a product (ADMIN)' })
  getFreeSubdomainRule(@Param('id') id: string) {
    return this.products.getFreeSubdomainRule(id);
  }

  @Put(':id/free-subdomain-rule')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create or update the free-subdomain rule of a product (ADMIN)' })
  upsertFreeSubdomainRule(
    @Param('id') id: string,
    @Body() dto: UpsertFreeSubdomainRuleDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.upsertFreeSubdomainRule(id, dto, actor);
  }

  @Delete(':id/free-subdomain-rule')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete the free-subdomain rule of a product (ADMIN)' })
  deleteFreeSubdomainRule(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.products.deleteFreeSubdomainRule(id, actor);
  }

  // ── Onglet 6 — options configurables (niveau produit) ────────────────────
  @Get(':id/options')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List product options with their choices (ADMIN)' })
  listOptions(@Param('id') id: string) {
    return this.products.listOptions(id);
  }

  @Post(':id/options')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a product option (ADMIN)' })
  createOption(
    @Param('id') id: string,
    @Body() dto: CreateOptionDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.createOption(id, dto, actor);
  }

  @Patch('options/:optionId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a product option (ADMIN)' })
  updateOption(
    @Param('optionId') optionId: string,
    @Body() dto: UpdateOptionDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.updateOption(optionId, dto, actor);
  }

  @Delete('options/:optionId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete a product option (ADMIN)' })
  deleteOption(@Param('optionId') optionId: string, @CurrentUser() actor: JwtPayload) {
    return this.products.deleteOption(optionId, actor);
  }

  @Post(':id/options/reorder')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Reorder product options (ADMIN)' })
  reorderOptions(
    @Param('id') id: string,
    @Body() dto: ReorderDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.reorderOptions(id, dto.ids, actor);
  }

  // ── Onglet 6 — choix d'une option ────────────────────────────────────────
  @Post('options/:optionId/choices')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a choice for a product option (ADMIN)' })
  createChoice(
    @Param('optionId') optionId: string,
    @Body() dto: CreateOptionChoiceDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.createChoice(optionId, dto, actor);
  }

  @Patch('choices/:choiceId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a product option choice (ADMIN)' })
  updateChoice(
    @Param('choiceId') choiceId: string,
    @Body() dto: UpdateOptionChoiceDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.updateChoice(choiceId, dto, actor);
  }

  @Delete('choices/:choiceId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete a product option choice (ADMIN)' })
  deleteChoice(@Param('choiceId') choiceId: string, @CurrentUser() actor: JwtPayload) {
    return this.products.deleteChoice(choiceId, actor);
  }

  @Post('options/:optionId/choices/reorder')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Reorder the choices of a product option (ADMIN)' })
  reorderChoices(
    @Param('optionId') optionId: string,
    @Body() dto: ReorderDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.reorderChoices(optionId, dto.ids, actor);
  }

  // ── Onglet 7 — suppléments / add-ons (niveau produit) ────────────────────
  @Get(':id/addons')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List product add-ons (ADMIN)' })
  listAddons(@Param('id') id: string) {
    return this.products.listAddons(id);
  }

  @Post(':id/addons')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a product add-on (ADMIN)' })
  createAddon(
    @Param('id') id: string,
    @Body() dto: CreateAddonDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.createAddon(id, dto, actor);
  }

  @Patch('addons/:addonId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a product add-on (ADMIN)' })
  updateAddon(
    @Param('addonId') addonId: string,
    @Body() dto: UpdateAddonDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.updateAddon(addonId, dto, actor);
  }

  @Delete('addons/:addonId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete a product add-on (ADMIN)' })
  deleteAddon(@Param('addonId') addonId: string, @CurrentUser() actor: JwtPayload) {
    return this.products.deleteAddon(addonId, actor);
  }

  @Post(':id/addons/reorder')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Reorder product add-ons (ADMIN)' })
  reorderAddons(
    @Param('id') id: string,
    @Body() dto: ReorderDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.products.reorderAddons(id, dto.ids, actor);
  }

  // ── Onglet 3 — résumé provisioning + méthodes disponibles ────────────────
  @Get(':id/provisioning')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Get provisioning summary of a product (ADMIN)' })
  getProvisioning(@Param('id') id: string) {
    return this.products.getProvisioning(id);
  }
}