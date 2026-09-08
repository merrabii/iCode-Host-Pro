import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { BRANDING_DIR } from './branding.service';

/**
 * Sert les assets de marque (logo importé) — GET /api/branding/:filename.
 * Anti path-traversal : seuls les noms 'logo-<hex>.<png|jpg|webp>' sont admis,
 * résolus et bornés au dossier branding. SendFile via Express (pas de dépendance
 * serve-static — évite le conflit de peer @nestjs/serve-static/Nest 11).
 */
@ApiTags('branding')
@Controller('branding')
export class BrandingAssetsController {
  @Get(':filename')
  serve(@Param('filename') filename: string, @Res() res: Response): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(filename)) {
      throw new BadRequestException('Nom de fichier invalide.');
    }
    const dir = BRANDING_DIR();
    const abs = path.resolve(dir, filename);
    if (abs !== dir + path.sep + filename && !abs.startsWith(dir + path.sep)) {
      throw new NotFoundException('Logo introuvable.');
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new NotFoundException('Logo introuvable.');
    }
    res.sendFile(abs);
  }
}