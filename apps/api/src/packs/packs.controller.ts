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
import { PacksService } from './packs.service';
import { CreatePackDto, UpdatePackDto } from './dto/create-pack.dto';

// Phase 12 (Catalog) — packs d'hébergement. Lecture authentifiée, mutations
// ADMIN-only, audit. Même patron que ProductsController (ADR-017).
@ApiTags('packs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('packs')
export class PacksController {
  constructor(private readonly packs: PacksService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a hosting pack (ADMIN)' })
  create(@Body() dto: CreatePackDto, @CurrentUser() actor: JwtPayload) {
    return this.packs.create(dto, actor);
  }

  @Get()
  @ApiOperation({ summary: 'List hosting packs (any authenticated)' })
  findAll() {
    return this.packs.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one hosting pack (any authenticated)' })
  findOne(@Param('id') id: string) {
    return this.packs.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a hosting pack (ADMIN)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePackDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.packs.update(id, dto, actor);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete a hosting pack (ADMIN)' })
  remove(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.packs.remove(id, actor);
  }
}