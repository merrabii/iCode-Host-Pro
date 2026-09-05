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
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/create-category.dto';

// Phase 12 (Catalog) — catégories de produits. Lecture authentifiée (ADMIN+USER),
// mutations ADMIN-only, audit. Même patron que ProductsController (ADR-017).
@ApiTags('categories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a product category (ADMIN)' })
  create(@Body() dto: CreateCategoryDto, @CurrentUser() actor: JwtPayload) {
    return this.categories.create(dto, actor);
  }

  @Get()
  @ApiOperation({ summary: 'List categories (any authenticated)' })
  findAll() {
    return this.categories.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one category (any authenticated)' })
  findOne(@Param('id') id: string) {
    return this.categories.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a category (ADMIN)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.categories.update(id, dto, actor);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete a category (ADMIN)' })
  remove(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.categories.remove(id, actor);
  }
}