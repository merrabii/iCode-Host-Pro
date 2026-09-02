import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ServersService } from './servers.service';
import { ProbeTransportFactory } from './probe-transport.factory';

describe('ServersService', () => {
  let service: ServersService;
  const mockPrisma = {
    server: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  const mockAudit = { record: jest.fn() };
  const mockProbeTransport = {
    probe: jest.fn(),
  };
  const mockProbeFactory = {
    create: jest.fn(() => mockProbeTransport),
  };
  const mockPanelTransport = {
    verify: jest.fn(),
  };
  const mockPanelFactory = {
    create: jest.fn(() => mockPanelTransport),
  };
  const mockCrypto = {
    encrypt: jest.fn(),
    decrypt: jest.fn(),
  };
  const mockHostResolver = {
    resolveIp: jest.fn(),
  };
  const mockHostResolverFactory = {
    create: jest.fn(() => mockHostResolver),
  };
  const actor = { sub: 'admin', email: 'admin@example.com' };
  // Un serveur complet tel que renvoyé par Prisma (au minimum pour view()).
  const rawServer = (over: Record<string, unknown> = {}) => ({
    id: '1',
    name: 'prod-01',
    hostname: 'node1.exemple.com',
    status: 'UNKNOWN',
    ipAddress: null,
    port: null,
    provider: null,
    region: null,
    quotaMaxAccounts: null,
    strictTls: true,
    panelProvider: 'NONE',
    apiBaseUrl: null,
    apiTokenEnc: null,
    apiUser: null,
    panelVerifiedAt: null,
    panelOk: null,
    panelDetail: null,
    lastCheckedAt: null,
    lastProbeOk: null,
    lastProbeDetail: null,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    service = new ServersService(
      mockPrisma as never,
      mockAudit as never,
      mockProbeFactory as never,
      mockPanelFactory as never,
      mockCrypto as never,
      mockHostResolverFactory as never,
    );
    jest.clearAllMocks();
    mockCrypto.encrypt.mockReturnValue('cipher:abc');
    mockCrypto.decrypt.mockReturnValue('token-secret');
    mockHostResolver.resolveIp.mockResolvedValue(null);
  });

  it('creates a server with name and hostname, and journals it', async () => {
    mockPrisma.server.create.mockResolvedValue(
      rawServer({ name: 'vps-eu', hostname: 'vps1.ihp' }),
    );
    await expect(service.create({ name: 'vps-eu', hostname: 'vps1.ihp' }, actor)).resolves.toMatchObject({
      hostname: 'vps1.ihp',
      hasApiToken: false,
    });
    expect(mockPrisma.server.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'vps-eu',
        hostname: 'vps1.ihp',
        apiBaseUrl: null,
        apiUser: null,
        apiTokenEnc: null,
      }),
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'server.create', actorId: 'admin', resourceId: '1' }),
    );
  });

  it('creates a server with full infra details (ADR-024)', async () => {
    mockPrisma.server.create.mockResolvedValue(rawServer({ id: '2' }));
    await service.create(
      {
        name: 'prod-01',
        hostname: 'node1.exemple.com',
        ipAddress: '198.51.100.7',
        port: 22,
        provider: 'Hetzner',
        region: 'fra1',
        quotaMaxAccounts: 20,
        strictTls: false,
        panelProvider: 'HESTIA',
      },
      actor,
    );
    expect(mockPrisma.server.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'prod-01',
        ipAddress: '198.51.100.7',
        port: 22,
        provider: 'Hetzner',
        region: 'fra1',
        quotaMaxAccounts: 20,
        strictTls: false,
        panelProvider: 'HESTIA',
      }),
    });
  });

  it('encrypts the API token at rest and never exposes it in the view (Phase 9)', async () => {
    mockPrisma.server.create.mockResolvedValue(rawServer({ apiTokenEnc: 'cipher:abc' }));
    const out = await service.create(
      { name: 'prod-01', hostname: 'node1.exemple.com', panelProvider: 'COOLIFY', apiToken: 'secret-raw' },
      actor,
    );
    expect(mockCrypto.encrypt).toHaveBeenCalledWith('secret-raw');
    expect(mockPrisma.server.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ apiTokenEnc: 'cipher:abc', panelProvider: 'COOLIFY' }),
    });
    expect(out.hasApiToken).toBe(true);
    expect(out).not.toHaveProperty('apiTokenEnc');
  });

  it('throws NotFoundException on findOne for an unknown id', async () => {
    mockPrisma.server.findUnique.mockResolvedValue(null);
    await expect(service.findOne('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException on update for an unknown id', async () => {
    mockPrisma.server.findUnique.mockResolvedValue(null);
    await expect(service.update('nope', { name: 'X' }, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockPrisma.server.update).not.toHaveBeenCalled();
  });

  it('clears the API token when apiToken is an empty string (update)', async () => {
    mockPrisma.server.findUnique.mockResolvedValue(rawServer({ apiTokenEnc: 'cipher:abc' }));
    mockPrisma.server.update.mockResolvedValue(rawServer({ apiTokenEnc: null }));
    const out = await service.update('1', { apiToken: '', apiBaseUrl: '', name: 'prod-01' }, actor);
    expect(mockPrisma.server.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: expect.objectContaining({ apiTokenEnc: null, apiBaseUrl: null, name: 'prod-01' }),
    });
    expect(out.hasApiToken).toBe(false);
  });

  it('replaces a non-empty apiToken, encrypted, on update', async () => {
    mockPrisma.server.findUnique.mockResolvedValue(rawServer());
    mockPrisma.server.update.mockResolvedValue(rawServer({ apiTokenEnc: 'cipher:new' }));
    mockCrypto.encrypt.mockReturnValueOnce('cipher:new');
    await service.update('1', { apiToken: 'new-secret', apiUser: 'api' }, actor);
    expect(mockCrypto.encrypt).toHaveBeenCalledWith('new-secret');
    expect(mockPrisma.server.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: expect.objectContaining({ apiTokenEnc: 'cipher:new', apiUser: 'api' }),
    });
  });

  it('deletes an existing server and journals the delete', async () => {
    mockPrisma.server.findUnique.mockResolvedValue(rawServer());
    mockPrisma.server.delete.mockResolvedValue(rawServer());
    await expect(service.remove('1', actor)).resolves.toMatchObject({ id: '1' });
    expect(mockPrisma.server.delete).toHaveBeenCalledWith({ where: { id: '1' } });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'server.delete', actorId: 'admin', resourceId: '1' }),
    );
  });

  describe('check (Phase 8, ADR-025)', () => {
    const base = {
      hostname: 'node1.exemple.com',
      status: 'UNKNOWN',
      strictTls: true,
      port: null,
    };

    it('probes via the factory (hostname, default port 22) and persists a success', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(rawServer(base));
      mockPrisma.server.update.mockResolvedValue(
        rawServer({ ...base, port: 22, lastCheckedAt: new Date('2026-09-01T10:00:00Z'), lastProbeOk: true, lastProbeDetail: 'TCP 22 : accessible (5 ms)' }),
      );
      mockProbeTransport.probe.mockResolvedValue({
        ok: true,
        detail: 'TCP 22 : accessible (5 ms)',
        latencyMs: 5,
      });

      const out = await service.check('srv1', actor);

      expect(mockProbeFactory.create).toHaveBeenCalledTimes(1);
      expect(mockProbeTransport.probe).toHaveBeenCalledWith({
        host: 'node1.exemple.com',
        port: 22,
        strictTls: true,
      });
      expect(mockPrisma.server.update).toHaveBeenCalledWith({
        where: { id: 'srv1' },
        data: {
          lastCheckedAt: expect.any(Date),
          lastProbeOk: true,
          lastProbeDetail: 'TCP 22 : accessible (5 ms)',
        },
      });
      expect(out.probe.ok).toBe(true);
      expect(out.server.lastProbeOk).toBe(true);
      expect(out.server.hasApiToken).toBe(false);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'server.check',
          resourceId: 'srv1',
          details: expect.objectContaining({ ok: true, port: 22, statusLeft: 'UNKNOWN' }),
        }),
      );
    });

    it('respects an explicit port and a failed probe', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(rawServer({ ...base, port: 8443 }));
      mockPrisma.server.update.mockResolvedValue(
        rawServer({ ...base, port: 8443, lastCheckedAt: new Date('2026-09-01T10:00:00Z'), lastProbeOk: false, lastProbeDetail: 'Connexion refusée' }),
      );
      mockProbeTransport.probe.mockResolvedValue({ ok: false, detail: 'Connexion refusée' });

      const out = await service.check('srv1', actor);

      expect(mockProbeTransport.probe).toHaveBeenCalledWith({
        host: 'node1.exemple.com',
        port: 8443,
        strictTls: true,
      });
      expect(out.probe.ok).toBe(false);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({ ok: false, port: 8443, detail: 'Connexion refusée' }),
        }),
      );
    });

    it('throws NotFoundException on check for an unknown id (no probe)', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(null);
      await expect(service.check('nope', actor)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockProbeTransport.probe).not.toHaveBeenCalled();
      expect(mockPrisma.server.update).not.toHaveBeenCalled();
    });
  });

  describe('verifyPanel (Phase 9, ADR-010)', () => {
    it('verifies a Hestia panel end-to-end and persists + journals the result', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(
        rawServer({
          panelProvider: 'HESTIA',
          apiBaseUrl: 'https://panel.exemple.com/api/',
          apiTokenEnc: 'cipher:abc',
          apiUser: 'api',
          status: 'ACTIVE',
        }),
      );
      mockPanelTransport.verify.mockResolvedValue({
        ok: true,
        detail: 'Hestia API : joignable + authentifié (98 ms)',
        latencyMs: 98,
      });
      mockPrisma.server.update.mockResolvedValue(
        rawServer({
          panelProvider: 'HESTIA',
          apiBaseUrl: 'https://panel.exemple.com/api/',
          apiTokenEnc: 'cipher:abc',
          apiUser: 'api',
          panelVerifiedAt: new Date('2026-09-01T10:00:00Z'),
          panelOk: true,
          panelDetail: 'Hestia API : joignable + authentifié (98 ms)',
        }),
      );

      const out = await service.verifyPanel('srv1', actor);

      expect(mockCrypto.decrypt).toHaveBeenCalledWith('cipher:abc');
      expect(mockPanelFactory.create).toHaveBeenCalledTimes(1);
      expect(mockPanelTransport.verify).toHaveBeenCalledWith({
        provider: 'HESTIA',
        baseUrl: 'https://panel.exemple.com/api/',
        token: 'token-secret',
        user: 'api',
        strictTls: true,
      });
      expect(mockPrisma.server.update).toHaveBeenCalledWith({
        where: { id: 'srv1' },
        data: {
          panelVerifiedAt: expect.any(Date),
          panelOk: true,
          panelDetail: 'Hestia API : joignable + authentifié (98 ms)',
        },
      });
      expect(out.result.ok).toBe(true);
      expect(out.server.panelOk).toBe(true);
      expect(out.server).not.toHaveProperty('apiTokenEnc');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'server.panel.verify',
          resourceId: 'srv1',
          details: expect.objectContaining({
            provider: 'HESTIA',
            ok: true,
            version: null,
          }),
        }),
      );
    });

    it('rejects a panel verify with no panel provider (NONE)', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(rawServer({ apiBaseUrl: 'https://x', apiTokenEnc: 'cipher:abc' }));
      await expect(service.verifyPanel('srv1', actor)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPanelTransport.verify).not.toHaveBeenCalled();
    });

    it('rejects a panel verify with no apiBaseUrl', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(rawServer({ panelProvider: 'COOLIFY', apiTokenEnc: 'cipher:abc' }));
      await expect(service.verifyPanel('srv1', actor)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPanelTransport.verify).not.toHaveBeenCalled();
    });

    it('rejects a panel verify with no configured token', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(rawServer({ panelProvider: 'COOLIFY', apiBaseUrl: 'https://x' }));
      await expect(service.verifyPanel('srv1', actor)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPanelTransport.verify).not.toHaveBeenCalled();
    });

    it('rejects a panel verify when the token cannot be decrypted', async () => {
      mockCrypto.decrypt.mockImplementation(() => {
        throw new Error('auth tag mismatch');
      });
      mockPrisma.server.findUnique.mockResolvedValue(
        rawServer({ panelProvider: 'COOLIFY', apiBaseUrl: 'https://x', apiTokenEnc: 'cipher:bad' }),
      );
      await expect(service.verifyPanel('srv1', actor)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPanelTransport.verify).not.toHaveBeenCalled();
    });

    it('throws NotFoundException on verify for an unknown id', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(null);
      await expect(service.verifyPanel('nope', actor)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPanelTransport.verify).not.toHaveBeenCalled();
    });

    it('applies auto-detected Hestia metrics only onto still-empty metric fields (Phase 9bis)', async () => {
      // ramMb déjà saisi manuellement => préservé ; cpuCores/diskGb vides => remplis.
      mockPrisma.server.findUnique.mockResolvedValue(
        rawServer({
          panelProvider: 'HESTIA',
          apiBaseUrl: 'https://panel.exemple.com/api/',
          apiTokenEnc: 'cipher:abc',
          ramMb: 8192,
        }),
      );
      mockPanelTransport.verify.mockResolvedValue({
        ok: true,
        detail: 'Hestia API : joignable + authentifié (50 ms)',
        latencyMs: 50,
        metrics: { ramMb: 4096, cpuCores: 8, diskGb: 200 },
      });
      mockPrisma.server.update.mockResolvedValue(rawServer({ panelOk: true }));

      await service.verifyPanel('srv1', actor);

      expect(mockPrisma.server.update).toHaveBeenCalledWith({
        where: { id: 'srv1' },
        data: expect.objectContaining({
          panelOk: true,
          // ramMb (8 192) déjà en base, non réécrit ; cpuCores/diskGb vides => remplis.
          cpuCores: 8,
          diskGb: 200,
          panelVerifiedAt: expect.any(Date),
        }),
      });
      expect(mockPrisma.server.update).not.toHaveBeenCalledWith({
        where: { id: 'srv1' },
        data: expect.objectContaining({ ramMb: 8192 }),
      });
    });
  });

  describe('auto-détection IP / port (Phase 9bis)', () => {
    it('resolves the IP from the hostname when none is provided, and keeps a null IP on resolution failure', async () => {
      mockHostResolver.resolveIp.mockResolvedValue('192.0.2.10');
      mockPrisma.server.create.mockResolvedValue(rawServer({ ipAddress: '192.0.2.10' }));
      await service.create({ name: 'vps', hostname: 'vps.ihp' }, actor);
      expect(mockHostResolver.resolveIp).toHaveBeenCalledWith('vps.ihp');
      expect(mockPrisma.server.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ipAddress: '192.0.2.10' }),
      });

      mockHostResolver.resolveIp.mockResolvedValue(null);
      await service.create({ name: 'vps2', hostname: 'ghost.ihp' }, actor);
      expect(mockPrisma.server.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ipAddress: null }),
      });
    });

    it('explicit IP is kept (no DNS call) and derives the port from apiBaseUrl when not provided', async () => {
      mockHostResolver.resolveIp.mockResolvedValue('192.0.2.99');
      mockPrisma.server.create.mockResolvedValue(
        rawServer({ ipAddress: '10.0.0.5', port: 8000, apiBaseUrl: 'http://portal.exemple.com:8000/api/v1' }),
      );
      await service.create(
        {
          name: 'portal',
          hostname: 'portal.exemple.com',
          ipAddress: '10.0.0.5',
          apiBaseUrl: 'http://portal.exemple.com:8000/api/v1',
        },
        actor,
      );
      expect(mockPrisma.server.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ipAddress: '10.0.0.5', port: 8000 }),
      });
    });

    it('derives the port on update only when no port is set yet (fills an empty one)', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(rawServer({ port: null }));
      mockPrisma.server.update.mockResolvedValue(rawServer({ port: 8000, apiBaseUrl: 'http://p:8000/api/v1' }));
      await service.update('1', { apiBaseUrl: 'http://p.exemple.com:8000/api/v1' }, actor);
      expect(mockPrisma.server.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: expect.objectContaining({ port: 8000 }),
      });
    });

    it('never overwrites a manually-set port with a derived one on update', async () => {
      mockPrisma.server.findUnique.mockResolvedValue(rawServer({ port: 2222 }));
      mockPrisma.server.update.mockResolvedValue(rawServer({ port: 2222, apiBaseUrl: 'http://p:9000/api/v1' }));
      await service.update('1', { apiBaseUrl: 'http://p.exemple.com:9000/api/v1' }, actor);
      expect(mockPrisma.server.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: expect.not.objectContaining({ port: 9000 }),
      });
    });

    it('persists manual metric fields on create and clears an empty bandwidthLimit on update', async () => {
      mockPrisma.server.create.mockResolvedValue(
        rawServer({ ramMb: 4096, cpuCores: 4, diskGb: 100, bandwidthLimit: '2 To / mois' }),
      );
      await service.create(
        {
          name: 'srv',
          hostname: 'srv.ihp',
          ramMb: 4096,
          cpuCores: 4,
          diskGb: 100,
          bandwidthLimit: '2 To / mois',
        },
        actor,
      );
      expect(mockPrisma.server.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ramMb: 4096, cpuCores: 4, diskGb: 100, bandwidthLimit: '2 To / mois' }),
      });

      mockPrisma.server.findUnique.mockResolvedValue(rawServer({ bandwidthLimit: '2 To / mois' }));
      mockPrisma.server.update.mockResolvedValue(rawServer({ bandwidthLimit: null }));
      await service.update('1', { bandwidthLimit: '' }, actor);
      expect(mockPrisma.server.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: expect.objectContaining({ bandwidthLimit: null }),
      });
    });
  });
});
