import { ConflictException } from '@nestjs/common';
import { Domain, SubdomainStatus } from '@prisma/client';
import { CloudflareService } from './cloudflare.service';
import { CloudflareTransport } from './cloudflare.transport';

// Phase 3 — unit du service Cloudflare : le jeton n'est JAMAIS renvoyé
// (vue hasApiToken), il est chiffré à l'écriture, la racine est ≤ 1, et
// l'allocation d'un sous-domaine vérifie la dispo puis crée un CNAME + la row.
describe('CloudflareService', () => {
  const mockPrisma = {
    cloudflareSetting: {
      findFirst: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    domain: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    clientSubdomain: { findFirst: jest.fn(), create: jest.fn() },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma)),
  };
  const mockAudit = { record: jest.fn() };
  const mockCrypto = {
    encrypt: jest.fn((p: string) => `enc:${p}`),
    decrypt: jest.fn((e: string) => e.replace(/^enc:/, '')),
  };
  const mockTransport = {
    listZones: jest.fn(),
    listRecords: jest.fn(),
    findRecordByName: jest.fn(),
    createRecord: jest.fn(),
    deleteRecord: jest.fn(),
  };
  const mockCfFactory = { create: jest.fn(() => mockTransport) };

  let service: CloudflareService;
  const actor = { sub: 'admin-1', email: 'admin@example.com' };

  const settingsRow = (over: Record<string, unknown> = {}) => ({
    id: 'cf1',
    apiTokenEnc: over.apiTokenEnc !== undefined ? over.apiTokenEnc : 'enc:tok',
    accountEmail: 'me@arumdigital.com',
    rootDomainId: null,
    rootDomain: null,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    ...over,
  });

  const rootDomain: Domain = {
    id: 'dom1',
    name: 'arumdigital.com',
    zoneId: 'z1',
    cnameTarget: null,
    status: 'ACTIVE' as const,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CloudflareService(
      mockPrisma as never,
      mockAudit as never,
      mockCrypto as never,
      mockCfFactory as never,
    );
  });

  describe('secret hygiene', () => {
    it('getSettings never leaks the token — only hasApiToken', async () => {
      mockPrisma.cloudflareSetting.findFirst.mockResolvedValue(settingsRow());
      const view = await service.getSettings();
      expect(view.hasApiToken).toBe(true);
      expect(JSON.stringify(view)).not.toContain('tok');
      expect(Object.keys(view)).not.toContain('apiTokenEnc'); // la clé n'est JAMAIS exposée
      expect(view.rootDomain).toBeNull();
    });

    it('updateSettings encrypts a provided token and clears on empty string', async () => {
      mockPrisma.cloudflareSetting.findFirst.mockResolvedValue(settingsRow());
      mockPrisma.cloudflareSetting.update.mockImplementation(async (args: { data: { apiTokenEnc?: string | null } }) =>
        settingsRow({ apiTokenEnc: args.data.apiTokenEnc ?? null, accountEmail: 'new@arumdigital.com' }),
      );
      const view = await service.updateSettings({ apiToken: 'tok-new', accountEmail: 'new@arumdigital.com' }, actor);
      expect(mockCrypto.encrypt).toHaveBeenCalledWith('tok-new');
      expect(view.hasApiToken).toBe(true);
      // Ne jamais renvoyer la clé
      expect(JSON.stringify(view)).not.toContain('tok-new');

      await service.updateSettings({ apiToken: '' }, actor);
      expect(mockPrisma.cloudflareSetting.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { apiTokenEnc: null } }),
      );
    });

    it('verify decrypts the token and reports zones without echoing the secret', async () => {
      mockPrisma.cloudflareSetting.findFirst.mockResolvedValue(settingsRow());
      mockTransport.listZones.mockResolvedValue([{ id: 'z1', name: 'arumdigital.com', status: 'active', paused: false }]);
      const out = await service.verify(actor);
      expect(out.ok).toBe(true);
      expect(out.zones).toHaveLength(1);
      expect(mockCrypto.decrypt).toHaveBeenCalledWith('enc:tok');
      expect(out.detail).toContain('1 zone');
    });
  });

  describe('domains & root', () => {
    it('registerDomain throws a Conflict when the zone is already imported', async () => {
      mockPrisma.domain.findUnique.mockResolvedValue({ id: 'dom1' });
      await expect(
        service.registerDomain({ zoneId: 'z1', name: 'arumdigital.com' }, actor),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('setRootDomain stores a single root and accepts null (deselect)', async () => {
      mockPrisma.cloudflareSetting.findFirst.mockResolvedValue(settingsRow({ rootDomainId: 'dom1' }));
      mockPrisma.domain.findUnique.mockResolvedValue(rootDomain);
      mockPrisma.cloudflareSetting.update.mockImplementation(async (args: { data: { rootDomainId?: string | null } }) =>
        settingsRow({
          rootDomainId: args.data.rootDomainId ?? null,
          rootDomain: args.data.rootDomainId ? rootDomain : null,
        }),
      );
      const view = await service.setRootDomain('dom1', actor);
      expect(mockPrisma.cloudflareSetting.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { rootDomainId: 'dom1' } }),
      );
      expect(view.rootDomain?.name).toBe('arumdigital.com');

      await service.setRootDomain(null, actor);
      expect(mockPrisma.cloudflareSetting.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { rootDomainId: null } }),
      );
    });
  });

  describe('allocateClientSubdomain (déploiement)', () => {
    const baseInput = {
      root: rootDomain,
      requested: 'monapp',
      seed: 'Site vitrine',
      fallbackHost: 'panel.arumdigital.com',
      deploymentId: 'dep1',
    };

    it('creates a free subdomain: CNAME proxied → row CREATED, retourne fqdn', async () => {
      // Dispo : aucun enregistrement ni usage local.
      mockTransport.findRecordByName.mockResolvedValue(null);
      mockPrisma.clientSubdomain.findFirst.mockResolvedValue(null);
      mockTransport.createRecord.mockResolvedValue('rec-42');
      mockPrisma.clientSubdomain.create.mockResolvedValue({ id: 'cs1' });

      const out = await service.allocateClientSubdomain(baseInput);
      expect(out).toEqual({ subdomain: 'monapp', fqdn: 'monapp.arumdigital.com' });
      expect(mockTransport.createRecord).toHaveBeenCalledWith(
        expect.anything(),
        'z1',
        expect.objectContaining({ type: 'CNAME', name: 'monapp.arumdigital.com', proxied: true, ttl: 1 }),
      );
      expect(mockPrisma.clientSubdomain.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: SubdomainStatus.CREATED, recordId: 'rec-42', deploymentId: 'dep1' }),
        }),
      );
    });

    it('auto-slug re-tries with a suffix when the base name is taken (no explicit request)', async () => {
      const takenFrom = { id: 'r-x', type: 'CNAME', name: 'site-vitrine.arumdigital.com', content: 'x' };
      mockTransport.findRecordByName
        .mockResolvedValueOnce(takenFrom) // base prise
        .mockResolvedValue(null); // suffixe libre
      mockPrisma.clientSubdomain.findFirst.mockResolvedValue(null);
      mockTransport.createRecord.mockResolvedValue('rec-99');
      mockPrisma.clientSubdomain.create.mockResolvedValue({ id: 'cs2' });

      const out = await service.allocateClientSubdomain({ ...baseInput, requested: undefined, seed: 'Site vitrine' });
      expect(out.subdomain).toMatch(/^site-vitrine-[a-z0-9]{3}$/);
      expect(out.fqdn).toBe(`${out.subdomain}.arumdigital.com`);
      expect(mockTransport.createRecord).toHaveBeenCalledTimes(1);
    });

    it('explicit requested & taken → throws, and NO record is created', async () => {
      mockTransport.findRecordByName.mockResolvedValue({ id: 'r-1', type: 'CNAME', name: 'monapp.arumdigital.com', content: 'x' });
      mockPrisma.clientSubdomain.findFirst.mockResolvedValue(null);
      await expect(service.allocateClientSubdomain(baseInput)).rejects.toThrow(/déjà pris/);
      expect(mockTransport.createRecord).not.toHaveBeenCalled();
      expect(mockPrisma.clientSubdomain.create).not.toHaveBeenCalled();
    });

    it('uses the root cnameTarget when set, else the fallback host', async () => {
      mockTransport.findRecordByName.mockResolvedValue(null);
      mockPrisma.clientSubdomain.findFirst.mockResolvedValue(null);
      mockTransport.createRecord.mockResolvedValue('r1');
      mockPrisma.clientSubdomain.create.mockResolvedValue({ id: 'cs3' });

      await service.allocateClientSubdomain(baseInput);
      await service.allocateClientSubdomain({ ...baseInput, root: { ...rootDomain, cnameTarget: 'app.exemple.com' } });
      const calls = mockTransport.createRecord.mock.calls.map((c) => c[2].content);
      expect(calls[0]).toBe('panel.arumdigital.com'); // fallback host
      expect(calls[1]).toBe('app.exemple.com'); // cnameTarget
    });

    it('record creation failure → row ERROR (never blocks) and rethrows', async () => {
      mockTransport.findRecordByName.mockResolvedValue(null);
      mockPrisma.clientSubdomain.findFirst.mockResolvedValue(null);
      mockTransport.createRecord.mockRejectedValue(new Error('Cloudflare API : rule violée'));
      mockPrisma.clientSubdomain.create.mockResolvedValue({ id: 'cs-x' });

      await expect(service.allocateClientSubdomain({ ...baseInput, requested: 'monapp2' })).rejects.toThrow(/Cloudflare API/);
      expect(mockPrisma.clientSubdomain.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: SubdomainStatus.ERROR }) }),
      );
    });
  });

  describe('findActiveRootDomain', () => {
    it('returns null when no root selected', async () => {
      mockPrisma.cloudflareSetting.findFirst.mockResolvedValue({ rootDomainId: null });
      mockPrisma.domain.findFirst.mockResolvedValue(null);
      expect(await service.findActiveRootDomain()).toBeNull();
    });

    it('returns the ACTIVE root domain when configured', async () => {
      mockPrisma.cloudflareSetting.findFirst.mockResolvedValue({ rootDomainId: 'dom1' });
      mockPrisma.domain.findFirst.mockResolvedValue(rootDomain);
      expect(await service.findActiveRootDomain()).toEqual(rootDomain);
    });
  });
});