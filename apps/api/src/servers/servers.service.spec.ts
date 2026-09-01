import { NotFoundException } from '@nestjs/common';
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
  const actor = { sub: 'admin', email: 'admin@example.com' };

  beforeEach(() => {
    service = new ServersService(
      mockPrisma as never,
      mockAudit as never,
      mockProbeFactory as never,
    );
    jest.clearAllMocks();
  });

  it('creates a server with name and hostname, and journals it', async () => {
    mockPrisma.server.create.mockResolvedValue({ id: '1', name: 'vps-eu', hostname: 'vps1.ihp', status: 'UNKNOWN' });
    await expect(service.create({ name: 'vps-eu', hostname: 'vps1.ihp' }, actor)).resolves.toMatchObject(
      {
        hostname: 'vps1.ihp',
      },
    );
    expect(mockPrisma.server.create).toHaveBeenCalledWith({
      data: {
        name: 'vps-eu',
        hostname: 'vps1.ihp',
        status: undefined,
        ipAddress: undefined,
        port: undefined,
        provider: undefined,
        region: undefined,
        quotaMaxAccounts: undefined,
        strictTls: undefined,
        panelProvider: undefined,
      },
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'server.create', actorId: 'admin', resourceId: '1' }),
    );
  });

  it('creates a server with full infra details (ADR-024)', async () => {
    mockPrisma.server.create.mockResolvedValue({ id: '2' });
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

  it('deletes an existing server and journals the delete', async () => {
    mockPrisma.server.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.server.delete.mockResolvedValue({ id: '1' });
    await expect(service.remove('1', actor)).resolves.toEqual({ id: '1' });
    expect(mockPrisma.server.delete).toHaveBeenCalledWith({ where: { id: '1' } });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'server.delete', actorId: 'admin', resourceId: '1' }),
    );
  });

  describe('check (Phase 8, ADR-025)', () => {
    const base = {
      id: 'srv1',
      name: 'prod-01',
      hostname: 'node1.exemple.com',
      status: 'UNKNOWN',
      strictTls: true,
      port: null,
    };

    it('probes via the factory (hostname, default port 22) and persists a success', async () => {
      mockPrisma.server.findUnique.mockResolvedValue({ ...base });
      mockPrisma.server.update.mockResolvedValue({
        ...base,
        port: 22,
        lastCheckedAt: new Date('2026-09-01T10:00:00Z'),
        lastProbeOk: true,
        lastProbeDetail: 'TCP 22 : accessible (5 ms)',
      });
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
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'server.check',
          resourceId: 'srv1',
          details: expect.objectContaining({ ok: true, port: 22, statusLeft: 'UNKNOWN' }),
        }),
      );
    });

    it('respects an explicit port and a failed probe', async () => {
      mockPrisma.server.findUnique.mockResolvedValue({ ...base, port: 8443 });
      mockPrisma.server.update.mockResolvedValue({
        ...base,
        port: 8443,
        lastCheckedAt: new Date('2026-09-01T10:00:00Z'),
        lastProbeOk: false,
        lastProbeDetail: 'Connexion refusée',
      });
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
});