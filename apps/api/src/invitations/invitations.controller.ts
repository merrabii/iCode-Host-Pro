import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtPayload } from '../auth/types';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { Actor, InvitationsService } from './invitations.service';

// Phase 5 (ADR-020): issuing, listing and revoking invitations is ADMIN-only —
// inviting is a privileged platform action. Acceptance is public but token-gated
// and lives under /auth (accept-invite).
@ApiTags('invitations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @ApiOperation({ summary: 'Issue an invitation for a new account (ADMIN)' })
  create(@Body() dto: CreateInvitationDto, @CurrentUser() actor: JwtPayload) {
    return this.invitations.create(dto, actor as Actor);
  }

  @Get()
  @ApiOperation({ summary: 'List invitations with status (ADMIN)' })
  list() {
    return this.invitations.list();
  }

  @Post(':id/revoke')
  @ApiOperation({ summary: 'Revoke a usable invitation (ADMIN)' })
  revoke(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.invitations.revoke(id, actor as Actor);
  }
}