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
import { ServersService } from './servers.service';
import { CreateServerDto } from './dto/create-server.dto';
import { UpdateServerDto } from './dto/update-server.dto';

// Phase 2 (ADR-017): Server is PLATFORM-GLOBAL infrastructure data. FULLY ADMIN-only:
// internal infrastructure (hostname, real status) must NOT be exposed to clients.
@ApiTags('servers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('servers')
export class ServersController {
  constructor(private readonly servers: ServersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a server (ADMIN)' })
  create(@Body() dto: CreateServerDto, @CurrentUser() actor: JwtPayload) {
    return this.servers.create(dto, actor);
  }

  @Get()
  @ApiOperation({ summary: 'List servers (ADMIN)' })
  findAll() {
    return this.servers.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a server (ADMIN)' })
  findOne(@Param('id') id: string) {
    return this.servers.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a server (ADMIN)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateServerDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.servers.update(id, dto, actor);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a server (ADMIN)' })
  remove(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.servers.remove(id, actor);
  }

  // Phase 8 (ADR-025): sonde de connectivité réelle. ADMIN-only (classe).
  @Post(':id/check')
  @ApiOperation({ summary: 'Probe a server connectivity (ADMIN)' })
  check(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.servers.check(id, actor);
  }
}