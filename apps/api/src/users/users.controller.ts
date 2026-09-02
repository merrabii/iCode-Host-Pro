import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { MfaService } from '../auth/mfa/mfa.service';
import { JwtPayload } from '../auth/types';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Current user profile' })
  getMe(@CurrentUser() user: JwtPayload) {
    return this.users.getProfile(user.sub);
  }

  // Phase 3 (admin management): listing users and mutating role/active state are
  // ADMIN-only — account administration must not be exposed to regular clients.
  @Get()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List all user accounts (ADMIN)' })
  findAll() {
    return this.users.findAll();
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a user role / active state (ADMIN)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.users.update(id, dto, actor);
  }

  // Phase 10 (ADR-027): "Se connecter en tant que client" in one click. The
  // returned JWT is role-USER pinned + `imp` marker, has NO refresh cookie, and
  // the guard makes it read-only — see AuthService.impersonate.
  @Post(':id/impersonate')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Start an admin "as client" session (ADMIN)' })
  impersonate(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.auth.impersonate(id, { sub: actor.sub, email: actor.email }, 'admin');
  }

  // Phase 10 (ADR-027): recovery for a locked-out account (MFA stuck / lost
  // authenticator). Only the TOTP secret is cleared; the account is untouched.
  @Post(':id/mfa-reset')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Reset a user MFA enrollment (ADMIN recovery)' })
  mfaReset(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.mfa.adminReset(id, { sub: actor.sub, email: actor.email });
  }
}