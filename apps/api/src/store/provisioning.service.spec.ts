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
  const transport = { createGitApp: jest.fn(), deployApp: jest.fn(), applyAppLimits: jest.fn(), setAppDomain: jest.fn(), applyNodePort: jest.fn(), resolveExposedPort: jest.fn().mockResolvedValue(null) };
  const panelFactory = { create: jest.fn(() => transport) };
  const prisma = {
    order: { findUnique: jest.fn(), update: jest.fn() },
    deployment: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
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

  // Produit backend Servé (non statique) : aucun isStatic ni publishDirectory →
  // est un serveur d'applications → la logique de port runtime s'y applique.
  function serverRuntimeOrder(opts?: { buildPack?: string; repoUrl?: string }) {
    return {
      id: 'ord1',
      status: 'PAID',
      domainValue: null,
      customer: { userId: 'u1' },
      product: {
        name: 'Trend',
        moduleParams: {
          repoUrl: opts?.repoUrl ?? 'https://github.com/exemple/un-backend-node.git',
          buildPack: opts?.buildPack ?? 'nixpacks',
        },
        pack: {
          deploymentModule: {
            kind: 'PER_CLIENT_PROJECT',
            perClientPrefix: 'client',
            sharedProjectUuid: 'proj-partage-module',
            server: coolifyServer,
          },
        },
        provisionModule: { name: 'coolify-store', actions: ['CREATE_APP'] },
      },
    };
  }

  // Serveur COOLIFY opérationnel → canal de preuve par statut de build (pas de HTTP).
  function coolifyProofServer() {
    return {
      findUnique: jest.fn().mockResolvedValue({
        id: 'srv-coolify', panelProvider: 'COOLIFY', apiBaseUrl: 'http://portal.exemple.com:8000/api/v1',
        apiTokenEnc: 'enc:coolify', strictTls: true, hostname: 'p.exemple.com', coolifyProjectUuid: 'p1', coolifyServerUuid: 's1',
      }),
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
    prisma.deployment.updateMany.mockResolvedValue({ count: 1 });
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

  // Fix GAP PORT (2026-09-15) — Approche B + contrat build-pack : le port d'un
  // backend Servé est RÉSOLU (source de vérité provider puis contrat build-pack),
  // jamais un chiffre canonique arbitraire ; un SPA n'y est jamais soumis.
  it('fix port — backend Node non statique ⇒ port résolu (provider OU contrat build-pack) avant deploy, pas pour un SPA', async () => {
    // (a) Produit SPA (isStatic+publishDirectory) → aucune logique de port.
    prisma.order.findUnique.mockResolvedValue(orderFor('PER_CLIENT_PROJECT'));
    await service.provisionOrder('ord1');
    expect(transport.applyNodePort).not.toHaveBeenCalled();
    expect(transport.resolveExposedPort).not.toHaveBeenCalled();

    // (b) Backend servé + provider EXPOSE un port (source = provider).
    jest.clearAllMocks();
    deployments.getOrCreateClientProject.mockResolvedValue({ id: 'cp1', projectUuid: 'proj-dedie-client' });
    (transport.resolveExposedPort as jest.Mock).mockResolvedValue(4000);
    prisma.order.findUnique.mockResolvedValue(serverRuntimeOrder());
    await service.provisionOrder('ord1');
    expect(transport.resolveExposedPort).toHaveBeenCalled();
    expect(transport.applyNodePort).toHaveBeenCalledWith(expect.anything(), 'app9', 4000);

    // (c) Backend servé + provider NULL ⇒ fallback contrat build-pack (nixpacks → 8080).
    jest.clearAllMocks();
    deployments.getOrCreateClientProject.mockResolvedValue({ id: 'cp1', projectUuid: 'proj-dedie-client' });
    (transport.resolveExposedPort as jest.Mock).mockResolvedValue(null);
    prisma.order.findUnique.mockResolvedValue(serverRuntimeOrder());
    await service.provisionOrder('ord1');
    expect(transport.applyNodePort).toHaveBeenCalledWith(expect.anything(), 'app9', 8080);

    // (d) Backend servé + provider NULL + AUCUN contrat ⇒ aucun port injecté,
    //     diagnostic explicite enregistré, jamais ACTIVE (order reste PROVISIONING).
    jest.clearAllMocks();
    deployments.getOrCreateClientProject.mockResolvedValue({ id: 'cp1', projectUuid: 'proj-dedie-client' });
    (transport.resolveExposedPort as jest.Mock).mockResolvedValue(null);
    prisma.order.findUnique.mockResolvedValue(serverRuntimeOrder({ buildPack: 'dockerfile' }));
    const out = await service.provisionOrder('ord1');
    expect(transport.applyNodePort).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'provision.node_port',
        details: expect.objectContaining({ ok: false, source: 'none' }),
      }),
    );
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

  // =========================================================================
  // RÉCONCILIATION DÉPLOIEMENT ↔ ORDER (2026-09-15) — la preuve de mise en
  // ligne (Order ACTIVE) doit se refléter sur LA row Deployment de la commande.
  // Testé unitairement via le mock Prisma `deployment.updateMany` (aucun réseau).
  // =========================================================================

  it('TEST1 — preuve réelle (Coolify ACTIVE) + Order ACTIVE ⇒ la row Deployment de la commande passe DEPLOYING→ACTIVE', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFor('PER_CLIENT_PROJECT'));
    deployments.getOrCreateClientProject.mockResolvedValue({ id: 'cp1', projectUuid: 'proj-dedie-client' });
    (prisma as Record<string, any>).server = coolifyProofServer();
    (transport as Record<string, any>).deploymentStatus = jest.fn().mockResolvedValue({ rawStatus: 'running:healthy', detail: 'running' });

    const out = await service.provisionOrder('ord1');

    expect(out.status).toBe('ACTIVE');
    // La reconciliation vise PRÉCISÉMENT LA row de cette commande, bornée à DEPLOYING.
    expect(prisma.deployment.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'ord1', status: 'DEPLOYING' },
      data: { status: 'ACTIVE' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'provision.deployment_active', resourceId: 'ord1', details: expect.objectContaining({ ok: true }) }),
    );
  });

  it('TEST2 — Deployment déjà ACTIVE ⇒ aucune réconciliation inutile (idempotent côté row)', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFor('PER_CLIENT_PROJECT'));
    deployments.getOrCreateClientProject.mockResolvedValue({ id: 'cp1', projectUuid: 'proj-dedie-client' });
    (prisma as Record<string, any>).server = coolifyProofServer();
    (transport as Record<string, any>).deploymentStatus = jest.fn().mockResolvedValue({ rawStatus: 'running:healthy', detail: 'running' });
    // La row est DÉJÀ ACTIVE : le `updateMany` borné à DEPLOYING ne matche rien.
    prisma.deployment.updateMany.mockResolvedValue({ count: 0 });

    const out = await service.provisionOrder('ord1');

    expect(out.status).toBe('ACTIVE');
    // Aucun audit « réconcilié » émis quand rien n'a changé (pas de double écriture).
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'provision.deployment_active', details: expect.objectContaining({ ok: true }) }),
    );
  });

  it('TEST3 — preuve ABSENTE (build Coolify FAILED) ⇒ jamais ACTIVE, reconcile non appelé, Order reste PROVISIONING', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFor('PER_CLIENT_PROJECT'));
    deployments.getOrCreateClientProject.mockResolvedValue({ id: 'cp1', projectUuid: 'proj-dedie-client' });
    (prisma as Record<string, any>).server = coolifyProofServer();
    // rawStatus mappé FAILED → cerré : awaitAppReady renvoie false immédiatement.
    (transport as Record<string, any>).deploymentStatus = jest.fn().mockResolvedValue({ rawStatus: 'crash', detail: 'crash' });

    const out = await service.provisionOrder('ord1');

    expect(out.status).toBe('PROVISIONING');
    // Pas de preuve de mise en ligne ⇒ la réconciliation Deployment→ACTIVE n'a PAS lieu.
    expect(prisma.deployment.updateMany).not.toHaveBeenCalled();
  });

  it('TEST4 — preuve INVALIDE (create_app échoue) ⇒ jamais ACTIVE, reconcile non appelé, Order reste PROVISIONING', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFor('PER_CLIENT_PROJECT'));
    // La création d'app échoue réellement : aucune preuve de mise en ligne.
    (transport.createGitApp as jest.Mock).mockRejectedValueOnce(new Error('Coolify 400'));

    const out = await service.provisionOrder('ord1');

    expect(out.status).toBe('PROVISIONING');
    expect(prisma.deployment.updateMany).not.toHaveBeenCalled();
  });

  it('TEST5 — Order déjà ACTIVE ⇒ pas de nouveau Deployment (ni création, ni reconcile)', async () => {
    const order = orderFor('PER_CLIENT_PROJECT');
    order.status = 'ACTIVE'; // déjà activée → provisionOrder renvoie l'état sans refaire le travail.
    prisma.order.findUnique.mockResolvedValue(order as never);

    const out = await service.provisionOrder('ord1');

    expect(out.status).toBe('ACTIVE');
    expect(prisma.deployment.create).not.toHaveBeenCalled();
    expect(prisma.deployment.updateMany).not.toHaveBeenCalled();
    expect(transport.createGitApp).not.toHaveBeenCalled();
  });

  it('TEST6 — double activation (relance force idempotente) ⇒ 1 seule row Deployment, état cohérent', async () => {
    (prisma as Record<string, any>).server = coolifyProofServer();
    (transport as Record<string, any>).deploymentStatus = jest.fn().mockResolvedValue({ rawStatus: 'running:healthy', detail: 'running' });
    deployments.getOrCreateClientProject.mockResolvedValue({ id: 'cp1', projectUuid: 'proj-dedie-client' });
    // 1ère activation : aucune row → création (+ reconcile). 2ème activation (relance
    // force) : row existante réutilisée (DÉJÀ ACTIVE) → reconcile borné DEPLOYING = 0.
    prisma.order.findUnique.mockResolvedValueOnce(orderFor('PER_CLIENT_PROJECT')).mockResolvedValueOnce(orderFor('PER_CLIENT_PROJECT'));
    prisma.deployment.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'd1', coolifyUuid: 'app9', status: 'ACTIVE' });
    prisma.deployment.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const first = await service.provisionOrder('ord1', { force: true });
    const second = await service.provisionOrder('ord1', { force: true });

    expect(first.status).toBe('ACTIVE');
    expect(second.status).toBe('ACTIVE');
    // Une seule row Deployment créée au total (pas de doublon).
    expect(prisma.deployment.create).toHaveBeenCalledTimes(1);
    // L'app Coolify n'est créée qu'UNE fois (1ère activation) ; la relance la RÉUTILISE.
    expect(transport.createGitApp).toHaveBeenCalledTimes(1);
  });

  it('TEST7 — Deployment FAILED n’est jamais basculé ACTIVE arbitrairement (reconcile borné à DEPLOYING)', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFor('PER_CLIENT_PROJECT'));
    deployments.getOrCreateClientProject.mockResolvedValue({ id: 'cp1', projectUuid: 'proj-dedie-client' });
    (prisma as Record<string, any>).server = coolifyProofServer();
    (transport as Record<string, any>).deploymentStatus = jest.fn().mockResolvedValue({ rawStatus: 'running:healthy', detail: 'running' });
    // Row existante FAILED : le filtre `status: DEPLOYING` l'exclut → jamais basculée.
    prisma.deployment.findFirst.mockResolvedValue({ id: 'd1', coolifyUuid: 'app9', status: 'FAILED' });
    // Une row FAILED ne matche pas `status: DEPLOYING` ⇒ `updateMany` ne change rien.
    prisma.deployment.updateMany.mockResolvedValue({ count: 0 });

    const out = await service.provisionOrder('ord1');

    // Order ACTIVE (preuve réelle obtenue) …
    expect(out.status).toBe('ACTIVE');
    // … mais la réconciliation est BORNÉE à DEPLOYING : la condition n'atteint pas FAILED,
    // donc aucune écriture ni audit « réconcilié ».
    expect(prisma.deployment.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'ord1', status: 'DEPLOYING' },
      data: { status: 'ACTIVE' },
    });
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'provision.deployment_active', details: expect.objectContaining({ ok: true }) }),
    );
  });
});

// =========================================================================
// Phase 4 — actionConfigureDns (fenêtre de panne + gel effectiveDomainId).
// Invariant : la racine effective est RÉSOLUE puis FIGÉE (order.update
// effectiveDomainId) AVANT toute allocation DNS, pour qu'un retry après un
// crash (DNS créé → persist absent) re-résolve la MÊME racine, jamais une
// autre. Aucun fallback arbitraire ; DNS et Coolify utilisent le même fqdn (#16).
// Les commandes testées n'ont QUE l'action CONFIGURE_DNS (branche 3,
// appUuid=null → pas de transport, pas de CREATE_APP). Mocks Prisma/Cloudflare
// dédiés (aucun réseau).
// =========================================================================
describe('ProvisioningService — actionConfigureDns (Phase 4, gel racine)', () => {
  const mockDecrypt = jest.fn();
  let service: ProvisioningService;

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

  const prisma = {
    order: { findUnique: jest.fn(), update: jest.fn() },
    deployment: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    provisioningLog: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    orderStatusHistory: { create: jest.fn() },
    clientSubdomain: { findFirst: jest.fn() },
  };
  const audit = { record: jest.fn() };
  const cloudflare = {
    resolveEffectiveRoot: jest.fn(),
    allocateClientSubdomain: jest.fn(),
    findActiveRootDomain: jest.fn(),
  };
  const transport = { createGitApp: jest.fn(), deployApp: jest.fn(), setAppDomain: jest.fn() };
  const panelFactory = { create: jest.fn(() => transport) };
  const deployments = { getOrCreateClientProject: jest.fn() };
  const mail = { sendPlain: jest.fn() };

  const root = {
    id: 'pf1',
    name: 'codediali.com',
    zoneId: 'z1',
    cnameTarget: null,
    status: 'ACTIVE' as const,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
  };

  // Une seule shape d'order renvoyée par LES DEUX findUnique (provisionOrder initial
  // + findUnique interne d'actionConfigureDns) : porte à la fois provisionModule,
  // customer et freeSubdomainRule/pack/racines.
  function orderFor(over: Record<string, unknown> = {}): Record<string, any> {
    return {
      id: 'ord1',
      status: 'PAID',
      domainValue: null,
      domainStatus: null,
      customerName: 'Client',
      customerEmail: 'cl@exemple.com',
      requestedSubdomain: 'monapp',
      requestedDomainId: null,
      effectiveDomainId: null,
      customer: { userId: 'u1' },
      product: {
        name: 'Site',
        moduleParams: {},
        freeSubdomainRule: { allowedDomainIds: null, minLength: 3, maxLength: 40, rejectPattern: null },
        pack: { deploymentModule: { kind: 'SHARED_PROJECT', sharedProjectUuid: 'proj-shared', server: coolifyServer } },
        provisionModule: { name: 'coolify-store', actions: ['CONFIGURE_DNS'] },
      },
      ...over,
    };
  }

  beforeEach(() => {
    service = new ProvisioningService(
      prisma as never,
      audit as never,
      { decrypt: mockDecrypt } as never,
      mail as never,
      cloudflare as never,
      panelFactory as never,
      deployments as never,
    );
    jest.clearAllMocks();
    mockDecrypt.mockReturnValue('tok');
    prisma.provisioningLog.create.mockResolvedValue({ id: 'log1' });
    prisma.provisioningLog.findMany.mockResolvedValue([]);
    prisma.deployment.findFirst.mockResolvedValue(null);
    prisma.order.update.mockResolvedValue({});
    prisma.clientSubdomain.findFirst.mockResolvedValue(null);
    cloudflare.allocateClientSubdomain.mockResolvedValue({ subdomain: 'monapp', fqdn: 'monapp.codediali.com' });
    cloudflare.resolveEffectiveRoot.mockResolvedValue({ root, source: 'default' });
  });

  it('gèle effectiveDomainId AVANT l’allocation DNS (#8/#16)', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFor());
    await service.provisionOrder('ord1');

    // Le gel de la racine est le 1er order.update(effectiveDomainId='pf1') ; son
    // ordre GLOBAL (invocationCallOrder) précède celui de l'allocation DNS.
    const gelIdx = prisma.order.update.mock.calls.findIndex(
      (c) => (c[0] as { data?: { effectiveDomainId?: string } } | undefined)?.data?.effectiveDomainId === 'pf1',
    );
    const gelOrder = prisma.order.update.mock.invocationCallOrder[gelIdx];
    const allocOrder = cloudflare.allocateClientSubdomain.mock.invocationCallOrder[0];
    expect(gelIdx).toBeGreaterThanOrEqual(0);
    expect(gelOrder).toBeLessThan(allocOrder);

    // Allocation SOUS CETTE racine, avec le sous-domaine demandé.
    expect(cloudflare.allocateClientSubdomain).toHaveBeenCalledWith(
      expect.objectContaining({ root: expect.objectContaining({ id: 'pf1' }), requested: 'monapp' }),
    );
  });

  it('retry → effectiveDomainId déjà figé GAGNE : résolu tel quel, pas de re-pick', async () => {
    const order = orderFor({ effectiveDomainId: 'pf1', requestedDomainId: 'req1' });
    prisma.order.findUnique.mockResolvedValue(order);

    const out = await service.provisionOrder('ord1');

    // Le résolveur reçoit bien effectiveDomainId + requestedDomainId : il décide.
    expect(cloudflare.resolveEffectiveRoot).toHaveBeenCalledWith(
      expect.objectContaining({ effectiveDomainId: 'pf1', requestedDomainId: 'req1' }),
    );
    // Allocation sous la racine figée, pas sous une autre.
    expect(cloudflare.allocateClientSubdomain).toHaveBeenCalledWith(
      expect.objectContaining({ root: expect.objectContaining({ id: 'pf1' }) }),
    );
    expect(out.fqdn).toBe('monapp.codediali.com');
  });

  it('fenêtre de panne (crash DNS→persist) → allocation partielle RÉUTILISÉE sous la même racine, jamais de 2ᵉ record', async () => {
    // Au retry, la racine est figée (pf1) et l'enregistrement DNS existe déjà pour
    // le sous-domaine demandé (le crash a laissé le record sans persistence Order).
    prisma.order.findUnique.mockResolvedValue(orderFor({ effectiveDomainId: 'pf1' }));
    prisma.clientSubdomain.findFirst.mockResolvedValue({ id: 'cs1', subdomain: 'monapp', fqdn: 'monapp.codediali.com' });

    await service.provisionOrder('ord1');

    // Re-cherche du fqdn DÉJÀ alloué sous la racine figée…
    expect(prisma.clientSubdomain.findFirst).toHaveBeenCalledWith({ where: { fqdn: 'monapp.codediali.com' } });
    // …réutilisé → AUCUNE nouvelle allocation, même racine (#16).
    expect(cloudflare.allocateClientSubdomain).not.toHaveBeenCalled();
    // La commande est finalisée avec le fqdn récupéré.
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ord1' },
        data: expect.objectContaining({ domainValue: 'monapp.codediali.com' }),
      }),
    );
  });

  it('allocation NEUVE sur domain DISABLED → rejet explicite, jamais de re-pick (#13)', async () => {
    // Échec du résolveur = step FAILED ⇒ jamais ACTIVE sans fqdn (branche 3).
    cloudflare.resolveEffectiveRoot.mockRejectedValue(
      new Error('Le domaine « codediali.com » de cette commande est désactivé : aucune nouvelle allocation n’est possible.'),
    );
    prisma.order.findUnique.mockResolvedValue(orderFor({ effectiveDomainId: 'pf1' }));
    // Le step configure_dns est FAILED dans les logs → la branche 3 reste PROVISIONING.
    prisma.provisioningLog.findMany
      .mockResolvedValueOnce([{ id: 'log1', step: 'configure_dns', status: 'FAILED', message: 'domaine désactivé' }])
      .mockResolvedValueOnce([{ id: 'log1', step: 'configure_dns', status: 'FAILED', message: 'domaine désactivé' }]);

    const out = await service.provisionOrder('ord1');

    expect(out.status).toBe('PROVISIONING');
    expect(cloudflare.allocateClientSubdomain).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ effectiveDomainId: 'pf1' }) }),
    );
  });
});