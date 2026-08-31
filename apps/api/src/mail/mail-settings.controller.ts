import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtPayload } from '../auth/types';
import { TestMailDto } from './dto/test-mail.dto';
import { UpdateMailSettingsDto } from './dto/update-mail-settings.dto';
import { MailSettingsService, MailSettingsView } from './mail-settings.service';

// Phase 6 (ADR-022): SMTP configuration management is ADMIN-only. The stored
// password is never returned (only `hasPassword`); the test endpoint surfaces
// the real SMTP error as a 400 so the admin can fix the config live.
@ApiTags('admin/mail')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/mail')
export class MailSettingsController {
  constructor(private readonly settings: MailSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Read the SMTP settings (masked) — ADMIN' })
  get(): Promise<MailSettingsView> {
    return this.settings.get();
  }

  @Put()
  @ApiOperation({ summary: 'Create/update the SMTP settings (PATCH semantics) — ADMIN' })
  update(
    @Body() dto: UpdateMailSettingsDto,
    @CurrentUser() actor: JwtPayload,
  ): Promise<MailSettingsView> {
    return this.settings.update(dto, {
      sub: actor.sub,
      email: actor.email,
    });
  }

  @Post('test')
  @ApiOperation({ summary: 'Send a test email through the saved config — ADMIN' })
  test(
    @Body() dto: TestMailDto,
    @CurrentUser() actor: JwtPayload,
  ): Promise<{ ok: true; message: string }> {
    return this.settings.test(dto.to, { sub: actor.sub, email: actor.email });
  }
}
