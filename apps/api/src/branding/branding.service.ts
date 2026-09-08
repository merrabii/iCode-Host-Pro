import {
  BadRequestException,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { BrandConfig, BrandLogoType } from '@prisma/client';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../users/users.service';
import { UpdateBrandingDto } from './dto/update-branding.dto';

/** Valeurs par défaut = marque actuelle gravée dans web/src/config/brand.ts
 *  + token --brand-primary (#00b377). Le reset restaure exactement ces valeurs. */
export const BRAND_DEFAULTS = {
  id: 'brand' as const,
  name: 'iCode Host Pro',
  sub: 'Self-hosted hosting control plane',
  tagline: 'CLOUD',
  hostname: null as string | null,
  logoType: BrandLogoType.DEFAULT,
  logoText: null as string | null,
  logoUrl: null as string | null,
  logoShowText: false,
  primaryColor: '#00b377',
  accentColor: null as string | null,
};

/** Vue publique d'une config (jamais d'ids internes ni de timestamps). */
export type BrandPublic = {
  name: string;
  sub: string;
  tagline: string | null;
  hostname: string | null;
  logoType: BrandLogoType;
  logoText: string | null;
  logoUrl: string | null;
  logoShowText: boolean;
  primaryColor: string;
  accentColor: string | null;
};

function toPublic(c: BrandConfig): BrandPublic {
  return {
    name: c.name,
    sub: c.sub,
    tagline: c.tagline,
    hostname: c.hostname,
    logoType: c.logoType,
    logoText: c.logoText,
    logoUrl: c.logoUrl,
    logoShowText: c.logoShowText,
    primaryColor: c.primaryColor.toLowerCase(),
    accentColor: c.accentColor?.toLowerCase() ?? null,
  };
}

/** Dossier où vivent les logos importés (servi à la DOI /api/branding/:file). */
export const BRANDING_DIR = () =>
  path.resolve(process.cwd(), 'public', 'branding');
const ALLOWED_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

@Injectable()
export class BrandingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Garantit la ligne singleton (créée aux défauts si absente) — robuste,
   *  aucun besoin d'un seed au premier lancement. */
  async onModuleInit(): Promise<void> {
    await this.ensureSingleton();
  }

  private async ensureSingleton(): Promise<void> {
    const existing = await this.prisma.brandConfig.findUnique({
      where: { id: 'brand' },
    });
    if (!existing) {
      await this.prisma.brandConfig.create({ data: { ...BRAND_DEFAULTS } });
    }
  }

  /** GET /api/brand (public, sans auth) — alimente le front. */
  async getPublic(): Promise<BrandPublic> {
    let c = await this.prisma.brandConfig.findUnique({ where: { id: 'brand' } });
    if (!c) await this.ensureSingleton();
    c = await this.prisma.brandConfig.findUniqueOrThrow({ where: { id: 'brand' } });
    return toPublic(c);
  }

  /** PATCH /api/admin/branding — applique uniquement les champs fournis. */
  async update(dto: UpdateBrandingDto, actor: Actor): Promise<BrandPublic> {
    await this.ensureSingleton();
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.sub !== undefined) data.sub = dto.sub;
    if (dto.tagline !== undefined) data.tagline = dto.tagline?.trim() || null;
    if (dto.hostname !== undefined) data.hostname = dto.hostname?.trim() || null;
    if (dto.logoType !== undefined) data.logoType = dto.logoType;
    if (dto.logoText !== undefined) data.logoText = dto.logoText?.trim() || null;
    if (dto.logoShowText !== undefined) data.logoShowText = dto.logoShowText;
    if (dto.primaryColor !== undefined) {
      const hex = (dto.primaryColor ?? '').toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(hex)) {
        throw new BadRequestException('primaryColor doit être un hex #RRGGBB.');
      }
      data.primaryColor = hex;
    }
    if (dto.accentColor !== undefined) {
      data.accentColor = dto.accentColor ? dto.accentColor.toLowerCase() : null;
    }

    // Cohérence logoType/logoText : si TEXT, il faut un texte ; sinon nettoyer.
    if (data.logoType === BrandLogoType.TEXT && !data.logoText) {
      data.logoText = BRAND_DEFAULTS.name;
    }
    if (data.logoType === BrandLogoType.DEFAULT) {
      data.logoText = null;
    }

    const updated = await this.prisma.brandConfig.update({
      where: { id: 'brand' },
      data: { ...data, updatedById: actor.sub },
    });
    const changed = Object.keys(data);
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'branding.update',
      resourceType: 'branding',
      resourceId: 'brand',
      details: { changed },
    });
    return toPublic(updated);
  }

  /** POST /api/admin/branding/reset — restaure les défauts actuels (logo commun). */
  async reset(actor: Actor): Promise<BrandPublic> {
    await this.ensureSingleton();
    // Supprime le fichier logo (best-effort) avant de passer logoUrl à null.
    const current = await this.prisma.brandConfig.findUnique({ where: { id: 'brand' } });
    const oldUrl = current?.logoUrl ?? null;
    if (oldUrl) {
      const dir = BRANDING_DIR();
      const oldAbs = path.join(dir, path.basename(oldUrl));
      if (fs.existsSync(oldAbs)) {
        try {
          fs.unlinkSync(oldAbs);
        } catch {
          /* best-effort — un ancien fichier orphelin est inoffensif */
        }
      }
    }

    const updated = await this.prisma.brandConfig.update({
      where: { id: 'brand' },
      data: {
        name: BRAND_DEFAULTS.name,
        sub: BRAND_DEFAULTS.sub,
        tagline: BRAND_DEFAULTS.tagline,
        hostname: null,
        logoType: BrandLogoType.DEFAULT,
        logoText: null,
        logoUrl: null,
        logoShowText: false,
        primaryColor: BRAND_DEFAULTS.primaryColor,
        accentColor: null,
        updatedById: actor.sub,
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'branding.reset',
      resourceType: 'branding',
      resourceId: 'brand',
      details: { restored: 'defaults' },
    });
    return toPublic(updated);
  }

  /**
   * POST /api/admin/branding/logo — enregistre le buffer reçu (mémoire multer)
   * dans public/branding/logo-<aléa>.<ext>, passe logoType=IMAGE + logoUrl.
   * Refus SVG (XSS) et fichiers > LOGO_MAX_BYTES. L'ancien fichier (s'il en
   * existait un) est supprimé best-effort.
   */
  async setLogo(
    file: { originalname: string; mimetype: string; size: number; buffer?: Buffer },
    actor: Actor,
  ): Promise<BrandPublic> {
    if (!file || !file.buffer) {
      throw new BadRequestException('Aucun fichier reçu (champ "file").');
    }
    if (file.size > LOGO_MAX_BYTES) {
      throw new BadRequestException('Logo trop volumineux (max 2 Mo).');
    }
    const ext = ALLOWED_MIME[file.mimetype];
    if (!ext) {
      throw new BadRequestException('Type non autorisé (PNG, JPEG ou WebP).');
    }

    const dir = BRANDING_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const old = await this.prisma.brandConfig.findUnique({ where: { id: 'brand' } });
    const oldUrl = old?.logoUrl ?? null;

    const filename = `logo-${randomBytes(8).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(dir, filename), file.buffer);

    // Remplace l'ancien fichier s'il était dans notre dossier branding.
    if (oldUrl) {
      const oldName = path.basename(oldUrl);
      const oldAbs = path.join(dir, oldName);
      if (fs.existsSync(oldAbs)) {
        try {
          fs.unlinkSync(oldAbs);
        } catch {
          /* best-effort — un ancien fichier orphelin est inoffensif */
        }
      }
    }

    const updated = await this.prisma.brandConfig.update({
      where: { id: 'brand' },
      data: { logoUrl: `/api/branding/${filename}`, logoType: BrandLogoType.IMAGE, updatedById: actor.sub },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'branding.logo',
      resourceType: 'branding',
      resourceId: 'brand',
      details: { filename, fromImage: oldUrl ? true : false },
    });
    return toPublic(updated);
  }

  /**
   * POST /api/admin/branding/logo/remove — supprime le logo image (fichier +
   * logoUrl) et repasse en logo DEFAULT (initiales). Le nom/sous-titre restent
   * inchangés ; l'identité peut rester vide (marque « image seule »).
   */
  async removeLogo(actor: Actor): Promise<BrandPublic> {
    await this.ensureSingleton();
    const current = await this.prisma.brandConfig.findUnique({ where: { id: 'brand' } });
    const oldUrl = current?.logoUrl ?? null;
    if (oldUrl) {
      const dir = BRANDING_DIR();
      const oldAbs = path.join(dir, path.basename(oldUrl));
      if (fs.existsSync(oldAbs)) {
        try {
          fs.unlinkSync(oldAbs);
        } catch {
          /* best-effort — un ancien fichier orphelin est inoffensif */
        }
      }
    }

    const updated = await this.prisma.brandConfig.update({
      where: { id: 'brand' },
      data: {
        logoUrl: null,
        logoType: BrandLogoType.DEFAULT,
        logoText: null,
        logoShowText: false,
        updatedById: actor.sub,
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: 'branding.logo-remove',
      resourceType: 'branding',
      resourceId: 'brand',
      details: { removedFile: oldUrl ? true : false },
    });
    return toPublic(updated);
  }
}