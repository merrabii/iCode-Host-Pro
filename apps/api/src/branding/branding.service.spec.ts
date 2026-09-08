import { BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs';
import { BrandLogoType } from '@prisma/client';
import { BrandingService, BRAND_DEFAULTS } from './branding.service';

describe('BrandingService (singleton white-label, Phase 14)', () => {
  const mockPrisma = {
    brandConfig: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const mockAudit = { record: jest.fn() };
  const actor = { sub: 'a1', email: 'admin@example.com' };

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'brand',
    name: BRAND_DEFAULTS.name,
    sub: BRAND_DEFAULTS.sub,
    tagline: BRAND_DEFAULTS.tagline,
    hostname: null as string | null,
    logoType: BrandLogoType.DEFAULT,
    logoText: null as string | null,
    logoUrl: null as string | null,
    logoShowText: false,
    primaryColor: BRAND_DEFAULTS.primaryColor,
    accentColor: null as string | null,
    updatedById: null as string | null,
    createdAt: new Date('2026-09-08T00:00:00Z'),
    updatedAt: new Date('2026-09-08T00:00:00Z'),
    ...over,
  });

  let service: BrandingService;
  beforeEach(() => {
    service = new BrandingService(mockPrisma as never, mockAudit as never);
    jest.clearAllMocks();
  });

  describe('getPublic', () => {
    it('renvoie la ligne singleton sans champs internes (id, timestamps, updatedById)', async () => {
      mockPrisma.brandConfig.findUnique.mockResolvedValue(row());
      mockPrisma.brandConfig.findUniqueOrThrow.mockResolvedValue(row());
      const view = await service.getPublic();
      expect(view).toEqual({
        name: BRAND_DEFAULTS.name,
        sub: BRAND_DEFAULTS.sub,
        tagline: 'CLOUD',
        hostname: null,
        logoType: BrandLogoType.DEFAULT,
        logoText: null,
        logoUrl: null,
        logoShowText: false,
        primaryColor: '#00b377',
        accentColor: null,
      });
      expect(view as Record<string, unknown>).not.toHaveProperty('updatedById');
      expect(view as Record<string, unknown>).not.toHaveProperty('createdAt');
      expect(view as Record<string, unknown>).not.toHaveProperty('id');
    });

    it('crée la ligne singleton si absente (idempotent — aucun seed requis)', async () => {
      // getPublic fait toujours findUnique → ensureSingleton → findUniqueOrThrow.
      mockPrisma.brandConfig.findUnique.mockResolvedValue(null);
      mockPrisma.brandConfig.create.mockResolvedValue(row());
      mockPrisma.brandConfig.findUniqueOrThrow.mockResolvedValue(row());
      const view = await service.getPublic();
      expect(mockPrisma.brandConfig.create).toHaveBeenCalledWith({ data: { ...BRAND_DEFAULTS } });
      expect(view.primaryColor).toBe('#00b377');
    });
  });

  describe('update', () => {
    it('applique uniquement les champs fournis, normalise l’hex minuscule et audite', async () => {
      mockPrisma.brandConfig.findUnique.mockResolvedValue(row());
      mockPrisma.brandConfig.update.mockResolvedValue(row({ name: 'Marque X', primaryColor: '#abcdef' }));
      const view = await service.update({ name: 'Marque X', primaryColor: '#AbCdEf' }, actor);
      expect(mockPrisma.brandConfig.update).toHaveBeenCalledWith({
        where: { id: 'brand' },
        data: { name: 'Marque X', primaryColor: '#abcdef', updatedById: 'a1' },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'branding.update', actorId: 'a1' }),
      );
      expect(view.primaryColor).toBe('#abcdef');
    });

    it('rejette un hex invalide', async () => {
      mockPrisma.brandConfig.findUnique.mockResolvedValue(row());
      await expect(service.update({ primaryColor: 'vert' }, actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockPrisma.brandConfig.update).not.toHaveBeenCalled();
    });

    it('null efface les champs nullables (tagline, accentColor)', async () => {
      mockPrisma.brandConfig.findUnique.mockResolvedValue(row());
      mockPrisma.brandConfig.update.mockImplementation(async ({ data }: { data: any }) =>
        row({
          tagline: data.tagline ?? null,
          accentColor: data.accentColor ?? null,
          name: data.name ?? BRAND_DEFAULTS.name,
          primaryColor: data.primaryColor ?? BRAND_DEFAULTS.primaryColor,
        }),
      );
      const view = await service.update({ tagline: null, accentColor: null }, actor);
      expect(mockPrisma.brandConfig.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ tagline: null, accentColor: null }) }),
      );
      expect(view.tagline).toBeNull();
    });

    it('applique logoShowText (image + texte) et l’expose', async () => {
      mockPrisma.brandConfig.findUnique.mockResolvedValue(row());
      mockPrisma.brandConfig.update.mockImplementation(async ({ data }: { data: any }) =>
        row({ logoType: data.logoType, logoShowText: data.logoShowText ?? false }),
      );
      const view = await service.update({ logoShowText: true }, actor);
      expect(mockPrisma.brandConfig.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ logoShowText: true }) }),
      );
      expect(view.logoShowText).toBe(true);
    });

    it('logoType TEXT sans texte → fallback au nom ; DEFAULT → logoText null', async () => {
      mockPrisma.brandConfig.findUnique.mockResolvedValue(row());
      mockPrisma.brandConfig.update.mockImplementation(async ({ data }: { data: any }) =>
        row({ logoType: data.logoType, logoText: data.logoText ?? null }),
      );
      await service.update({ logoType: BrandLogoType.TEXT }, actor);
      const firstUpd = mockPrisma.brandConfig.update.mock.calls[0][0];
      expect(firstUpd.data.logoText).toBe(BRAND_DEFAULTS.name);

      await service.update({ logoType: BrandLogoType.DEFAULT }, actor);
      const secondUpd = mockPrisma.brandConfig.update.mock.calls[1][0];
      expect(secondUpd.data.logoText).toBeNull();
    });
  });

  describe('reset', () => {
    it('restaure les défauts actuels et audite', async () => {
      mockPrisma.brandConfig.findUnique.mockResolvedValue(row());
      mockPrisma.brandConfig.update.mockResolvedValue(row());
      const view = await service.reset(actor);
      expect(mockPrisma.brandConfig.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: BRAND_DEFAULTS.name,
            logoType: BrandLogoType.DEFAULT,
            primaryColor: '#00b377',
            accentColor: null,
          }),
        }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'branding.reset' }));
      expect(view.primaryColor).toBe('#00b377');
    });

    it('supprime le fichier logo existant et passe logoUrl à null', async () => {
      const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      mockPrisma.brandConfig.findUnique.mockResolvedValue(row({ logoUrl: '/branding/logo-old.png' }));
      mockPrisma.brandConfig.update.mockResolvedValue(row());
      await service.reset(actor);
      expect(existsSpy).toHaveBeenCalled();
      expect(unlinkSpy).toHaveBeenCalledWith(expect.stringContaining('logo-old.png'));
      expect(mockPrisma.brandConfig.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ logoUrl: null }) }),
      );
    });
  });

  describe('setLogo', () => {
    it('refuse sans buffer', async () => {
      await expect(
        service.setLogo({ originalname: 'x', mimetype: 'image/png', size: 10 }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuse un fichier > 2 Mo', async () => {
      await expect(
        service.setLogo(
          { originalname: 'x', mimetype: 'image/png', size: 2 * 1024 * 1024 + 1, buffer: Buffer.alloc(1) },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuse les mime non autorisés (SVG = XSS)', async () => {
      await expect(
        service.setLogo(
          { originalname: 'x.svg', mimetype: 'image/svg+xml', size: 10, buffer: Buffer.from('<svg/>') },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('enregistre le buffer, passe logoType=IMAGE avec une URL aléatoire, supprime l’ancien et audite', async () => {
      const writeFileSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
      mockPrisma.brandConfig.findUnique.mockResolvedValue(row({ logoUrl: '/branding/logo-old.png' }));
      mockPrisma.brandConfig.update.mockResolvedValue(
        row({ logoType: BrandLogoType.IMAGE, logoUrl: '/branding/logo-0123456789abcdef.png' }),
      );

      const view = await service.setLogo(
        { originalname: 'l.png', mimetype: 'image/png', size: 100, buffer: Buffer.from('png') },
        actor,
      );

      expect(writeFileSpy).toHaveBeenCalledTimes(1);
      const updateArg = mockPrisma.brandConfig.update.mock.calls[0][0];
      expect(updateArg.data.logoType).toBe(BrandLogoType.IMAGE);
      expect(updateArg.data.logoUrl).toMatch(/^\/branding\/logo-[0-9a-f]{16}\.png$/);
      expect(existsSpy).toHaveBeenCalled();
      expect(unlinkSpy).toHaveBeenCalledWith(expect.stringContaining('logo-old.png'));
      expect(mockAudit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'branding.logo' }));
      expect(view.logoType).toBe(BrandLogoType.IMAGE);
    });
  });
});