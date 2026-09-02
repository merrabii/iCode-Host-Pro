import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtPayload } from '../auth/types';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { EscalateTicketDto } from './dto/escalate-ticket.dto';
import { TicketMessageDto } from './dto/ticket-message.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';
import { TicketsService } from './tickets.service';

/**
 * Phase 10 (ADR-027): minimal tickets. Creation and "my tickets" are for any
 * authenticated account; per-ticket access is owner-or-support (checked in the
 * service via roleRank); escalation + status changes are support L1+.
 * Read-only guard: an impersonation session can read tickets but never post.
 */
@ApiTags('tickets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Post()
  @Roles(Role.USER)
  @ApiOperation({ summary: 'Open a support ticket' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateTicketDto) {
    return this.tickets.create(user, dto);
  }

  @Get()
  @Roles(Role.USER)
  @ApiOperation({ summary: 'List my tickets' })
  listMine(@CurrentUser() user: JwtPayload) {
    return this.tickets.listMine(user);
  }

  @Get(':id')
  @Roles(Role.USER)
  @ApiOperation({ summary: 'Read a ticket (owner or support >= L1)' })
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.tickets.findOne(id, user);
  }

  @Post(':id/messages')
  @Roles(Role.USER)
  @ApiOperation({ summary: 'Add a message (owner or support >= L1)' })
  addMessage(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: TicketMessageDto,
  ) {
    return this.tickets.addMessage(id, user, dto);
  }

  @Post(':id/escalate')
  @Roles(Role.SUPPORT_L1)
  @ApiOperation({ summary: 'Escalate to SUPPORT_L2 / SUPPORT_L3 (support L1+)' })
  escalate(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: EscalateTicketDto,
  ) {
    return this.tickets.escalate(id, user, dto);
  }

  @Patch(':id/status')
  @Roles(Role.SUPPORT_L1)
  @ApiOperation({ summary: 'Update ticket status (support L1+)' })
  updateStatus(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateTicketStatusDto,
  ) {
    return this.tickets.updateStatus(id, user, dto);
  }
}

/**
 * Support console queue — the whole ticket file (L1+), distinct from the
 * client-scoped `GET /api/tickets` which only returns the caller's own.
 */
@ApiTags('support/tickets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('support/tickets')
export class SupportTicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  @Roles(Role.SUPPORT_L1)
  @ApiOperation({ summary: 'Support console: list the whole ticket queue (L1+)' })
  listQueue(@CurrentUser() user: JwtPayload) {
    return this.tickets.listAll(user);
  }
}
