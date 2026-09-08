import {
  BadRequestException,
  Body,
  Controller,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/types';
import { BrandingService, LOGO_MAX_BYTES } from './branding.service';
import { UpdateBrandingDto } from './dto/update-branding.dto';

/**
 * Mutation du branding — ADMIN only (RolesGuard + rank). Upload logo multipart
 * en mémoire (multer via platform-express) : type png/jpeg/webp ≤ 2 Mo, refus
 * SVG (XSS). Erreurs d'upload interceptées → 400 lisible.
 */
@ApiTags('admin/branding')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/branding')
export class AdminBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Patch()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update branding (name, logo config, colors) — ADMIN' })
  update(@Body() dto: UpdateBrandingDto, @CurrentUser() actor: JwtPayload) {
    return this.branding.update(dto, actor);
  }

  @Post('reset')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Reset branding to defaults — ADMIN' })
  reset(@CurrentUser() actor: JwtPayload) {
    return this.branding.reset(actor);
  }

  @Post('logo')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: LOGO_MAX_BYTES },
      fileFilter: (_req, file, cb) => {
        const ok = /^(image\/png|image\/jpeg|image\/webp)$/.test(file.mimetype);
        cb(ok ? null : new BadRequestException('Type non autorisé (PNG, JPEG, WebP).'), ok);
      },
    }),
  )
  @ApiOperation({ summary: 'Upload brand logo (image, ≤ 2 Mo) — ADMIN' })
  uploadLogo(@UploadedFile() file: unknown, @CurrentUser() actor: JwtPayload) {
    return this.branding.setLogo(file as { originalname: string; mimetype: string; size: number; buffer?: Buffer }, actor);
  }
}