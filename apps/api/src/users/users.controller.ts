import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { MfaService } from '../auth/mfa/mfa.service';
import { RATE, SaRateLimiter, rateKey } from '../auth/rate-limiter';
import { JwtPayload } from '../auth/types';
import { RequestClosureDto, ResolveClosureDto } from './dto/closure.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

type Iprq = Request & { ip?: string };

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly limiter: SaRateLimiter,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Current user profile (includes pendingEmail)' })
  getMe(@CurrentUser() user: JwtPayload) {
    return this.users.getProfile(user.sub);
  }

  // GO socle (lot A1): self-service profile edit. Declared BEFORE @Patch(':id')
  // so "me" never matches the id route; userId comes from the JWT only.
  // GO Q3: rate-limited (email-change requests trigger outbound verification
  // mails) — email is a PENDING flow, never an immediate write.
  @Patch('me')
  @ApiOperation({ summary: 'Update my own profile (name; email => verification pending)' })
  updateMe(@Body() dto: UpdateProfileDto, @CurrentUser() user: JwtPayload, @Req() req: Iprq) {
    const rl = this.limiter.consume(
      rateKey(req.ip, 'update-profile'),
      RATE.emailChange.limit,
      RATE.emailChange.windowMs,
    );
    if (!rl.allowed) {
      throw new UnauthorizedException(
        `Trop de tentatives. Réessayez dans ${Math.ceil(rl.retryAfterMs / 1000)} s.`,
      );
    }
    return this.users.updateProfile(user.sub, dto);
  }

  // ── GO Q3 : demande de clôture de compte (demander ≠ exécuter) ────────────
  @Get('me/closure-request')
  @ApiOperation({ summary: 'My pending account-closure request (null if none)' })
  getClosureRequest(@CurrentUser() user: JwtPayload) {
    return this.users.getClosureRequest(user.sub);
  }

  @Post('me/closure-request')
  @ApiOperation({ summary: 'Open (or reopen) my account-closure request' })
  requestClosure(@Body() dto: RequestClosureDto, @CurrentUser() user: JwtPayload) {
    return this.users.requestClosure(user.sub, dto.reason);
  }

  @Delete('me/closure-request')
  @ApiOperation({ summary: 'Cancel my pending account-closure request' })
  cancelClosureRequest(@CurrentUser() user: JwtPayload) {
    return this.users.cancelClosureRequest(user.sub);
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

  // ── GO Q3 : traitement admin des demandes de clôture (ADMIN, avant :id) ───
  @Get('closure-requests')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List account-closure requests (ADMIN)' })
  listClosureRequests() {
    return this.users.listClosureRequests();
  }

  @Patch('closure-requests/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Resolve an account-closure request (ADMIN) — no data deletion' })
  resolveClosureRequest(
    @Param('id') id: string,
    @Body() dto: ResolveClosureDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.users.resolveClosureRequest(id, dto, actor);
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

  // Phase 13 (ADR-031): create the client's dedicated Coolify project (Module B)
  // — idempotent (POST /projects on Coolify + @@unique on ClientProject).
  @Post(':id/project')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create client Coolify project for Module B (ADMIN)' })
  createClientProject(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.users.createClientProject(id, actor);
  }
}