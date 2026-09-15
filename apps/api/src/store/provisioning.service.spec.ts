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
  const mockDeployments = { getOrCreateClientProject: jest.fn() };
  const mockCrypto = { decrypt: mockDecrypt, encrypt: jest.fn() };
  const mockMail = { sendPlain: jest.fn() };
  const mockCloudflare = { findActiveRootDomain: jest.fn(), allocateClientSubdomain: jest.fn() };
  const mockTransport = { applyAppLimits: jest.fn(), createGitApp: jest.fn(), deployApp: jest.fn(), setAppDomain: jest.fn() };
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
      mockDeployments as never,
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

describe('ProvisioningService — actionCreateApp (choix du projet A/B voie store)', () => {
  const mockDecrypt = jest.fn();
  let service: ProvisioningService;

  const coolifyServer = {
    id: 'srv-coolify',
    panelProvider: 'COOLIFY',
    apiBaseUrl: 'http://portal.exemple.com:8000/api/v1',
    apiTokenEnc: 'enc:coolify',
    strictTls: true,
    hostname: 'portal.exemple.com',
    coolifyProjectUuid: 'proj-partage-serveur',
    coolifyServerUuid: 'srv-1',
  };
  const transport = { createGitApp: jest.fn(), deployApp: jest.fn(), applyAppLimits: jest.fn(), setAppDomain: jest.fn() };
  const panelFactory = { create: jest.fn(() => transport) };
  const prisma = {
    order: { findUnique: jest.fn(), update: jest.fn() },
    deployment: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    provisioningLog: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    orderStatusHistory: { create: jest.fn() },
  };
  const audit = { record: jest.fn() };
  const deployments = { getOrCreateClientProject: jest.fn() };
  const mail = { sendPlain: jest.fn() };

  function orderFor(moduleKind: string | null) {
    return {
      id: 'ord1',
      status: 'PAID',
      domainValue: null,
      customer: { userId: 'u1' },
      product: {
        name: 'Trend',
        moduleParams: { repoUrl: 'https://github.com/merrabii/Code-Diali-Guide-de-Demarrage.git', buildPack: 'nixpacks', publishDirectory: '/dist', isStatic: true },
        pack: {
          deploymentModule:
            moduleKind === null
              ? null
              : {
                  kind: moduleKind,
                  perClientPrefix: 'client',
                  sharedProjectUuid: 'proj-partage-module',
                  server: coolifyServer,
                },
        },
        provisionModule: { name: 'coolify-store', actions: ['CREATE_APP'] },
      },
    };
  }

  beforeEach(() => {
    service = new ProvisioningService(
      prisma as never,
      audit as never,
      { decrypt: mockDecrypt } as never,
      mail as never,
      { findActiveRootDomain: jest.fn(), allocateClientSubdomain: jest.fn() } as never,
      panelFactory as never,
      deployments as never,
    );
    jest.clearAllMocks();
    mockDecrypt.mockReturnValue('tok');
    prisma.provisioningLog.create.mockResolvedValue({ id: 'log1' });
    prisma.provisioningLog.findMany.mockResolvedValue([]);
    prisma.deployment.findFirst.mockResolvedValue(null);
    prisma.deployment.create.mockResolvedValue({ id: 'd1' });
    prisma.deployment.update.mockResolvedValue({ id: 'd1' });
    transport.createGitApp.mockResolvedValue({ uuid: 'app9' });
    transport.deployApp.mockResolvedValue(undefined);
  });

  // Le happy-path d'une app créée SANS preuve de mise en ligne (statut Coolify / HTTP)
  // reste PROVISIONING — jamais de faux ACTIVE. Voir le test de preuve plus bas.
  it('module PER_CLIENT_PROJECT (B) ⇒ app créée dans le projet dédié du client, pas celui du serveur', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFor('PER_CLIENT_PROJECT'));
    deployments.getOrCreateClientProject.mockResolvedValue({ id: 'cp1', projectUuid: 'proj-dedie-client' });

    const out = await service.provisionOrder('ord1');

    expect(deployments.getOrCreateClientProject).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ id: 'srv-coolify' }),
      expect.objectContaining({ kind: 'PER_CLIENT_PROJECT', perClientPrefix: 'client' }),
    );
    expect(transport.createGitApp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectUuid: 'proj-dedie-client' }),
    );
    expect(transport.createGitApp.mock.calls[0][1].projectUuid).not.toBe('proj-partage-serveur');
    // Traçabilité : la row Deployment persiste le projet + le clientProject dédié.
    expect(prisma.deployment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        coolifyProjectUuid: 'proj-dedie-client',
        clientProjectId: 'cp1',
      }),
    });
    // App créée mais non prouvée en ligne → PROVISIONING (jamais de faux ACTIVE).
    expect(out.status).toBe('PROVISIONING');
  });

  it('module SHARED_PROJECT (A) ⇒ app créée dans le projet partagé du module', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFor('SHARED_PROJECT'));

    await service.provisionOrder('ord1');

    expect(deployments.getOrCreateClientProject).not.toHaveBeenCalled();
    expect(transport.createGitApp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectUuid: 'proj-partage-module' }),
    );
  });

  it('aucun module ⇒ tentative d’app ignorée (serveur porté par le module), jamais ACTIVE sans app', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFor(null));

    const out = await service.provisionOrder('ord1');

    expect(deployments.getOrCreateClientProject).not.toHaveBeenCalled();
    expect(transport.createGitApp).not.toHaveBeenCalled();
    // CREATE_APP attendue mais aucune app créée → PROVISIONING (jamais de faux ACTIVE).
    expect(out.status).toBe('PROVISIONING');
  });

  it('fix prod — NOUVELLE commande ⇒ row Deployment créée liée à SA commande (orderId), pas réutilisée par repo', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFor('PER_CLIENT_PROJECT'));
    deployments.getOrCreateClientProject.mockResolvedValue({ id: 'cp1', projectUuid: 'proj-dedie-client' });
    // Aucune row existante pour cette commande.
    prisma.deployment.findFirst.mockResolvedValue(null);

    const out = await service.provisionOrder('ord1');

    // L'app store est bien créée sur Coolify…
    expect(transport.createGitApp).toHaveBeenCalled();
    // …et tracée sur une row Deployment DÉDIÉE portant orderId = 'ord1'.
    expect(prisma.deployment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderId: 'ord1', coolifyUuid: 'app9', clientProjectId: 'cp1' }),
    });
    expect(prisma.deployment.update).not.toHaveBeenCalled();
    // App créée mais non prouvée en ligne → PROVISIONING.
    expect(out.status).toBe('PROVISIONING');
  });

  it('fix prod — relance de la MÊME commande ⇒ app Coolify existante réutilisée, jamais de 2ᵉ app', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFor('PER_CLIENT_PROJECT'));
    deployments.getOrCreateClientProject.mockResolvedValue({ id: 'cp1', projectUuid: 'proj-dedie-client' });
    // Une relance : la row de la commande existante est retrouvée par orderId et porte
    // déjà une app Coolify (app-OLD).
    prisma.deployment.findFirst.mockResolvedValue({
      id: 'd-exist',
      coolifyUuid: 'app-OLD',
      detail: 'Ancien déploiement',
      status: 'FAILED',
    });

    const out = await service.provisionOrder('ord1');

    // Idempotence (fix 2026-09-15) : on N'a PAS créé de nouvelle app sur Coolify —
    // l'app existante (app-OLD) est RE-déployée, et la row est mise à jour sur le même uuid.
    expect(transport.createGitApp).not.toHaveBeenCalled();
    expect(prisma.deployment.create).not.toHaveBeenCalled();
    expect(prisma.deployment.update).toHaveBeenCalledWith({
      where: { id: 'd-exist' },
      data: expect.objectContaining({ orderId: 'ord1', coolifyUuid: 'app-OLD' }),
    });
    expect(transport.deployApp).toHaveBeenCalledWith(expect.anything(), 'app-OLD');
    // App réutilisée mais non prouvée en ligne → PROVISIONING.
    expect(out.status).toBe('PROVISIONING');
  });

  // Nouvelle exigence 2026-09-15 — « ne jamais confirmer tant que ce n'est pas OK » :
  // ACTIVE (et email de livraison) uniquement quand la mise en ligne est PROUVÉE
  // (statut build Coolify ACTIVE). Sans preuve → PROVISIONING.
  it('preuve requise — app créée et statut Coolify ACTIVE ⇒ Order ACTIVE + email de livraison', async () => {
    const order = orderFor('PER_CLIENT_PROJECT') as Record<string, unknown>;
    order.customerEmail = 'cl@exemple.com';
    order.customerName = 'Client';
    order.domainValue = 'app.example.com'; // fqdn déjà alloué → chemin email exercé
    prisma.order.findUnique.mockResolvedValue(order as never);
    deployments.getOrCreateClientProject.mockResolvedValue({ id: 'cp1', projectUuid: 'proj-dedie-client' });
    // La row Deployment existe pour cette commande (uuid provenant de transport).
    prisma.deployment.create.mockResolvedValue({ id: 'd1', coolifyUuid: 'app9', serverId: 'srv-coolify' });
    // Serveur + statut Coolify prouvent la mise en ligne au premier poll.
    (prisma as Record<string, any>).server = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'srv-coolify', panelProvider: 'COOLIFY', apiBaseUrl: 'http://portal.exemple.com:8000/api/v1',
        apiTokenEnc: 'enc:coolify', strictTls: true, hostname: 'p.exemple.com', coolifyProjectUuid: 'p1', coolifyServerUuid: 's1',
      }),
    };
    (transport as Record<string, any>).deploymentStatus = jest.fn().mockResolvedValue({ rawStatus: 'running:healthy', detail: 'running' });

    const out = await service.provisionOrder('ord1');

    expect(out.status).toBe('ACTIVE');
    expect((prisma as Record<string, any>).orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderId: 'ord1', status: 'ACTIVE' }),
    });
    expect(mail.sendPlain).toHaveBeenCalledWith(expect.objectContaining({ to: 'cl@exemple.com' }));
  });

  // Preuve durable : CREATE_APP échoue → JAMAIS ACTIVE (même avec DNS alloué).
  it('preuve requise — create_app échoue ⇒ Order reste PROVISIONING (jamais ACTIVE via DNS seul)', async () => {
    const order = orderFor('PER_CLIENT_PROJECT');
    // La création d'app échoue réellement (transport rejette).
    (transport.createGitApp as jest.Mock).mockRejectedValueOnce(new Error('Coolify 400'));

    const out = await service.provisionOrder('ord1');

    expect(out.status).toBe('PROVISIONING');
    expect(transport.deployApp).not.toHaveBeenCalled();
  });
});