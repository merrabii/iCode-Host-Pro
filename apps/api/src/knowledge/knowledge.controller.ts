import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  KnowledgeAudience,
  KnowledgeStatus,
  Role,
} from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtPayload } from '../auth/types';
import { CreateKnowledgeArticleDto } from './dto/create-knowledge-article.dto';
import { UpdateKnowledgeArticleDto } from './dto/update-knowledge-article.dto';
import { KnowledgeService } from './knowledge.service';

/**
 * Phase 11 — base de connaissance.
 * - /api/knowledge/* : CRUD ADMIN-only (les DEUX audiences — interne admin et
 *   catalogue client publié par l'admin).
 * - /api/client/knowledge : lectures PUBLIQUES (articles CLIENT + PUBLISHED).
 */
@ApiTags('knowledge')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  @ApiOperation({ summary: 'List knowledge articles (admin, both audiences, filters)' })
  list(
    @CurrentUser() actor: JwtPayload,
    @Query('audience') audience?: KnowledgeAudience,
    @Query('status') status?: KnowledgeStatus,
    @Query('q') q?: string,
  ) {
    return this.knowledge.list(actor, { audience, status, q });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one knowledge article (admin)' })
  get(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.knowledge.get(actor, id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a knowledge article (admin)' })
  create(@Body() dto: CreateKnowledgeArticleDto, @CurrentUser() actor: JwtPayload) {
    return this.knowledge.create(actor, dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a knowledge article — PATCH semantics (admin)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateKnowledgeArticleDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.knowledge.update(actor, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a knowledge article (admin)' })
  remove(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.knowledge.remove(actor, id);
  }
}

/**
 * Client knowledge base — PUBLIC published articles (no auth, no secrets: only
 * audience CLIENT + status PUBLISHED, and the client listing strips the body).
 */
@ApiTags('client/knowledge')
@Controller('client/knowledge')
export class ClientKnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  @ApiOperation({ summary: 'Client catalogue — published articles (public)' })
  list(@Query('category') category?: string, @Query('q') q?: string) {
    return this.knowledge.listPublished({ category, q });
  }

  @Get('categories')
  @ApiOperation({ summary: 'Client article categories (public)' })
  categories() {
    return this.knowledge.listClientCategories();
  }

  @Get(':idOrSlug')
  @ApiOperation({ summary: 'Client article detail by id or slug (public)' })
  get(@Param('idOrSlug') idOrSlug: string) {
    return this.knowledge.getPublished(idOrSlug);
  }
}
