import { NotFoundException } from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';

// Bloc 2/3 — unit de syncAppLimits : ré-applique les limites RAM/CPU du pack
// courant aux apps DÉJÀ déployées de l'abonné (upgrade sans perte), format
// Coolify, best-effort par app, jamais un redéploiement. Prisma, transport et
// audit sont mockés (aucun réseau réel).
describe('ProvisioningService — syncAppLimits', () => {
  const mockDecrypt = jest.fn();
  let service: ProvisioningService;

  const mockPrisma = {
    subscription: { findUnique: jest.fn() },
    deployment: { findMany: jest.fn() },
    order: { findUnique: jest.fn(), update: jest.fn() },
    provisioningLog: { create: jest.fn(), update: jest.fn() },
    orderStatusHistory: { create: jest.fn() },
  };
  const mockAudit = { record: jest.fn() };
  const mockCrypto = { decrypt: mockDecrypt, encrypt: jest.fn() };
  const mockMail = { sendPlain: jest.fn() };
  const mockCloudflare = { findActiveRootDomain: jest.fn(), allocateClientSubdomain: jest.fn() };
  const mockTransport = { applyAppLimits: jest.fn() };
  const mockPanelFactory = { create: jest.fn(() => mockTransport) };

  const coolifyServer = {
    id: 'srv-coolify',
    panelProvider: 'COOLIFY',
    apiBaseUrl: 'http://portal.exemple.com:8000/api/v1',
    apiTokenEnc: 'enc:coolify',
    strictTls: true,
    hostname: 'portal.exemple.com',
    coolifyProjectUuid: 'proj-1',
    coolifyServerUuid: 'srv-1',
  };

  const freePack = () => ({
    name: 'Plan Gratuit',
    status: 'ACTIVE',
    ramMb: 256,
    cpuCores: 0.5,
    deploymentModule: { server: coolifyServer },
  });

  beforeEach(() => {
    service = new ProvisioningService(
      mockPrisma as never,
      mockAudit as never,
      mockCrypto as never,
      mockMail as never,
      mockCloudflare as never,
      mockPanelFactory as never,
    );
    jest.clearAllMocks();
    mockDecrypt.mockReturnValue('tok');
  });

  it('pack inactif ou sans limites ⇒ rien à appliquer, transport jamais appelé', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue({
      id: 'sub1',
      userId: 'u1',
      product: { pack: { name: 'P', status: 'DISABLED', ramMb: 0, cpuCores: 0, deploymentModule: null } },
    });

    const out = await service.syncAppLimits('sub1');

    expect(out).toEqual({ subscriptionId: 'sub1', checked: 0, applied: 0, failed: 0 });
    expect(mockTransport.applyAppLimits).not.toHaveBeenCalled();
  });

  it('pack ACTIVE avec limites ⇒ chaque app déployée (non-FAILED, uuid présent) replafonnée au format Coolify', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue({
      id: 'sub1',
      userId: 'u1',
      product: { pack: freePack() },
    });
    mockPrisma.deployment.findMany.mockResolvedValue([
      { id: 'd1', userId: 'u1', coolifyUuid: 'app-1' },
      { id: 'd2', userId: 'u1', coolifyUuid: 'app-2' },
      { id: 'd3', userId: 'u1', coolifyUuid: null }, // sans uuid → ignorée
    ]);
    mockTransport.applyAppLimits.mockResolvedValue(undefined);

    const out = await service.syncAppLimits('sub1');

    expect(out).toEqual({ subscriptionId: 'sub1', checked: 3, applied: 2, failed: 0 });
    expect(mockTransport.applyAppLimits).toHaveBeenCalledTimes(2);
    expect(mockTransport.applyAppLimits).toHaveBeenNthCalledWith(1, expect.anything(), 'app-1', {
      cpus: '0.5',
      memory: '256m',
    });
    expect(mockTransport.applyAppLimits).toHaveBeenNthCalledWith(2, expect.anything(), 'app-2', {
      cpus: '0.5',
      memory: '256m',
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'subscription.sync_app_limits',
        resourceId: 'd1',
        details: expect.objectContaining({ limits: { cpus: '0.5', memory: '256m' }, ok: true }),
      }),
    );
  });

  it('une app en échec ⇒ partition applied/failed, pas d’interruption des autres, jamais de throw', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue({
      id: 'sub1',
      userId: 'u1',
      product: { pack: freePack() },
    });
    mockPrisma.deployment.findMany.mockResolvedValue([
      { id: 'd1', userId: 'u1', coolifyUuid: 'app-1' },
      { id: 'd2', userId: 'u1', coolifyUuid: 'app-2' },
    ]);
    mockTransport.applyAppLimits
      .mockRejectedValueOnce(new Error('HTTP 400'))
      .mockResolvedValueOnce(undefined);

    const out = await service.syncAppLimits('sub1');

    expect(out).toEqual({ subscriptionId: 'sub1', checked: 2, applied: 1, failed: 1 });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'd1', details: expect.objectContaining({ ok: false }) }),
    );
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'd2', details: expect.objectContaining({ ok: true }) }),
    );
  });

  it('abonnement introuvable ⇒ NotFoundException', async () => {
    mockPrisma.subscription.findUnique.mockResolvedValue(null);
    await expect(service.syncAppLimits('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});