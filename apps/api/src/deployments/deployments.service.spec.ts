import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { DeploymentsService, mapCoolifyStatus } from './deployments.service';
import { DeploymentStatus } from '@prisma/client';

// Phase 10bis (N) — unit du service de déploiement : toutes les gardes
// (deployEnabled, GitHub lié, dépôt possédé, Service ACTIVE sur serveur Coolify
// connecté) + le flux heureux et la bascule live. Le transport et GitHubService
// sont mockés (aucun réseau réel), le reste suit le pattern servers.service.spec.
describe('DeploymentsService', () => {
  let service: DeploymentsService;
  const mockPrisma = {
    user: { findUnique: jest.fn() },
    service: { findFirst: jest.fn() },
    server: { findUnique: jest.fn() },
    subscription: { findFirst: jest.fn() },
    deploymentModule: { findFirst: jest.fn() },
    clientProject: { findUnique: jest.fn(), create: jest.fn() },
    deployment: {
      create: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      // Contrat de réponse remove() : relecture fraîche de la row (removed honnête).
      findUnique: jest.fn(),
      // 17B.4F-C2 — compensation pré-provider (suppression GARDEE PENDING).
      deleteMany: jest.fn(),
    },
    hostingService: { findMany: jest.fn() }, // 17B.4F-C2 — classification locale
    // 17B.4F-C2/C4 — allocation liée (remove sous garde ON) + relecture D9.
    hostingServiceAllocation: { findFirst: jest.fn(), findUnique: jest.fn() },
    // Repli garde C2/C3 × C4 : allocation retrouvée via la tentative de portée
    // DEPLOYMENT quand `markBound` n'a pas encore lié la row (échec de création).
    c4ProviderAttempt: { findFirst: jest.fn() },
    cloudflareSetting: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    domain: { findFirst: jest.fn(), findUnique: jest.fn() },
    clientSubdomain: { findFirst: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  };
  const mockAudit = { record: jest.fn() };
  const mockSettings = { isDeployEnabled: jest.fn() };
  const mockCrypto = { encrypt: jest.fn(), decrypt: jest.fn() };
  const mockCloudflare = {
    findActiveRootDomain: jest.fn(),
    allocateClientSubdomain: jest.fn(),
    deleteDnsRecord: jest.fn(),
  };
  const mockGithub = {
    decryptToken: jest.fn(),
    listRepos: jest.fn(),
    fetchUser: jest.fn(),
    repoExists: jest.fn(),
    // Phase 10bis.5 — mode URL collée (détection auto).
    detectRepo: jest.fn(),
    deriveRepoFullName: jest.fn(),
    // Phase 16 — build « file-based » (codediali.toml/netlify.toml/dépôt vide).
    readBuildConfig: jest.fn().mockResolvedValue(null),
    isRepoEmpty: jest.fn().mockResolvedValue(false),
  };
  const mockTransport = {
    createGitApp: jest.fn(),
    createProject: jest.fn(),
    applyAppLimits: jest.fn(),
    deployApp: jest.fn(),
    setAppEnvironment: jest.fn(),
    setAppDomain: jest.fn(),
    deploymentStatus: jest.fn(),
    deleteApplication: jest.fn(),
    // READ d'argument (résolution serverUuid) — déterministe par défaut :
    // aucune UUID → `serverUuid: undefined`, identique au repli historique.
    listServers: jest.fn(),
  };
  const mockPanelFactory = { create: jest.fn(() => mockTransport) };

  // 17B.4F-C2 — moteur de réservation C1 (jamais appelé quand la garde OFF).
  const mockHosting = {
    reserveSlot: jest.fn(),
    markProviderIntent: jest.fn(),
    releasePreProvider: jest.fn(),
    markBound: jest.fn(),
  };

  // 17B.4F-C4 — protocole de tentatives + libération sous preuves (no-op OFF).
  const mockC4 = {
    beginDispatchStandalone: jest.fn(),
    settleStandalone: jest.fn(),
    hasStop: jest.fn(),
    unresolvedCreative: jest.fn(),
  };
  const mockC4r = { releaseAfterCleanup: jest.fn() };

  // Transaction simulée pour remove() — les deux écritures locales y sont faites.
  // 17B.4F-C4 — étendue aux `persist` des settles (row projet + row DNS +
  // identifiants deployment) exécutées DANS LA MÊME tx que la consignation.
  const mockTx = {
    clientSubdomain: { deleteMany: jest.fn(), create: jest.fn() },
    deployment: { delete: jest.fn(), update: jest.fn() },
    clientProject: { findUnique: jest.fn(), create: jest.fn() },
  };

  const actor = { sub: 'u1', email: 'client@example.com' };

  // Serveur Coolify connecté (panelOk=true) affecté au service.
  const serverRow = () => ({
    id: 'srv-coolify',
    name: 'coolify-portal',
    hostname: 'portal.exemple.com',
    status: 'ACTIVE',
    ipAddress: null,
    port: 8000,
    provider: null,
    region: null,
    quotaMaxAccounts: null,
    strictTls: true,
    panelProvider: 'COOLIFY',
    apiBaseUrl: 'http://portal.exemple.com:8000/api/v1',
    apiTokenEnc: 'enc:coolify',
    apiUser: null,
    panelVerifiedAt: new Date('2026-09-01T10:00:00Z'),
    panelOk: true,
    panelDetail: 'OK',
    lastCheckedAt: null,
    lastProbeOk: null,
    lastProbeDetail: null,
    ramMb: null,
    cpuCores: null,
    diskGb: null,
    bandwidthLimit: null,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
  });

  // Service ACTIVE du client, affecté au serveur Coolify connecté.
  const serviceRow = (over: Record<string, unknown> = {}) => ({
    id: 'svc1',
    name: 'Site vitrine',
    subscriptionId: 'sub1',
    serverId: 'srv-coolify',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    server: serverRow(),
    ...over,
  });

  const deploymentRow = (over: Record<string, unknown> = {}) => ({
    id: 'dep1',
    userId: 'u1',
    serverId: 'srv-coolify',
    repoFullName: 'owner/repo',
    branch: 'main',
    coolifyUuid: 'app-1',
    status: 'DEPLOYING',
    detail: null,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    ...over,
  });

  // 17B.4F-C2 — ligne `HostingService` (cuid, PAS un UUID) rattachée à
  // l'abonnement actif `sub-act` et au pack/module de la cible.
  const hostingServiceRow = (over: Record<string, unknown> = {}) => ({
    id: 'hs1',
    userId: 'u1',
    orderId: null,
    subscriptionId: 'sub-act',
    productId: 'prod1',
    packId: 'pack1',
    deploymentModuleId: 'modA',
    status: 'ACTIVE',
    maxAppsSnapshot: null,
    ramMbSnapshot: 512,
    cpuCoresSnapshot: 1,
    storageLimitGbSnapshot: null,
    packNameSnapshot: 'Starter 1 Go',
    productNameSnapshot: null,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    ...over,
  });

  const allocationRow = (over: Record<string, unknown> = {}) => ({
    id: 'alloc1',
    hostingServiceId: 'hs1',
    status: 'RESERVED',
    idempotencyKey: 'direct:v1:u1:hs1:cid',
    requestFingerprint: 'fp:v1:0000',
    deploymentId: null,
    providerIntentAt: null,
    reservedAt: new Date('2026-09-26T10:00:00Z'),
    releasedAt: null,
    boundAt: null,
    createdAt: new Date('2026-09-26T10:00:00Z'),
    updatedAt: new Date('2026-09-26T10:00:00Z'),
    ...over,
  });

  // UUID v4 valide exigé par `normalizeClientRequestId` (parcours C2).
  const CID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

  // Bloc 4 — cible AUTO : la table Service a été supprimée, la cible est un
  // abonnement ACTIVE → pack ACTIVE → module Coolify connecté (serverRow).
  const autoModule = (over: Record<string, unknown> = {}) => ({
    id: 'modA',
    name: 'Module A',
    code: 'A',
    kind: 'SHARED_PROJECT',
    isActive: true,
    serverId: 'srv-coolify',
    sharedProjectUuid: 'proj-shared',
    sharedProjectName: 'Projet partagé',
    perClientPrefix: 'client',
    overrideRamMb: null,
    overrideCpuCores: null,
    overrideStorageLimit: null,
    server: serverRow(),
    ...over,
  });
  const autoTarget = (over: Record<string, unknown> = {}) => ({
    id: 'sub-act',
    userId: 'u1',
    productId: 'prod1',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
    product: {
      id: 'prod1',
      pack: {
        id: 'pack1',
        name: 'Starter 1 Go',
        status: 'ACTIVE',
        ramMb: 512,
        cpuCores: 1,
        storageLimit: 20,
        bandwidth: null,
        maxApps: null,
        deploymentModuleId: 'modA',
        createdAt: new Date(),
        updatedAt: new Date(),
        deploymentModule: autoModule(),
        ...over,
      },
    },
  });

  beforeEach(() => {
    service = new DeploymentsService(
      mockPrisma as never,
      mockAudit as never,
      mockSettings as never,
      mockCrypto as never,
      mockGithub as never,
      mockPanelFactory as never,
      mockCloudflare as never,
      mockHosting as never,
      mockC4 as never,
      { assertOperational: jest.fn().mockResolvedValue(undefined) } as never,
      mockC4r as never,
    );
    jest.clearAllMocks();
    // 17B.4F-C2 — garde OFF par défaut (contrat historique préservé). Les
    // tests du parcours C2 l'activent explicitement (valeur exacte 'true').
    delete process.env.HOSTING_C2_ENABLED;
    // 17B.4F-C4 — garde C4 OFF par défaut (les tests C4 l'activent explicitement).
    delete process.env.HOSTING_C4_ENABLED;
    // Relecture remove() : par défaut la row a disparu (nettoyage effectif) ;
    // aucun accès hosting (aucune allocation) hors tests ON.
    mockPrisma.deployment.findUnique.mockResolvedValue(null);
    mockPrisma.hostingServiceAllocation.findFirst.mockResolvedValue(null);
    mockPrisma.hostingServiceAllocation.findUnique.mockResolvedValue(null);
    mockPrisma.c4ProviderAttempt.findFirst.mockResolvedValue(null);
    mockC4.beginDispatchStandalone.mockResolvedValue({
      attemptId: 'att-c4-1',
      targetIntentHash: 'hash-c4-1',
    });
    // Contrairement au réel (TX dédiée), la settle simulée EXÉCUTE le `persist`
    // fourni sur mockTx : preuve déterministe des écritures atomiques (row
    // projet, row ClientSubdomain + identifiants deployment) sans base.
    mockC4.settleStandalone.mockImplementation(async (params: {
      persist?: (tx: unknown) => Promise<void>;
    }) => {
      if (typeof params?.persist === 'function') await params.persist(mockTx);
    });
    mockC4.hasStop.mockResolvedValue(false);
    mockC4.unresolvedCreative.mockResolvedValue(0);
    mockC4r.releaseAfterCleanup.mockResolvedValue({
      status: 'released',
      allocationId: 'alloc1',
    });
    // Aucun domaine racine configuré par défaut → flux inchangé (Phase 3 best-effort).
    mockCloudflare.findActiveRootDomain.mockResolvedValue(null);
    mockSettings.isDeployEnabled.mockResolvedValue(true);
    // Compte GitHub lié par défaut (token chiffré présent).
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', githubTokenEnc: 'enc:gh' });
    mockGithub.decryptToken.mockImplementation((enc: string | null) => {
      if (!enc) throw new BadRequestException('Aucun compte GitHub lié');
      return 'gh-token';
    });
    mockGithub.repoExists.mockResolvedValue(true);
    mockGithub.detectRepo.mockResolvedValue({
      valid: true,
      repoUrl: 'https://github.com/owner/repo.git',
      repoFullName: 'owner/repo',
      defaultBranch: 'main',
      language: 'TypeScript',
      suggestedBuildPack: 'nixpacks',
    });
    mockPrisma.subscription.findFirst.mockResolvedValue(autoTarget());
    mockCrypto.decrypt.mockReturnValue('coolify-token');
    // Comptage quota par défaut : aucun app existante (les tests qui comptent
    // surchargent ce mock).
    mockPrisma.deployment.findMany.mockResolvedValue([]);
    // B0.1 — transaction locale : callback exécuté sur le tx simulé.
    mockTx.clientSubdomain.deleteMany.mockResolvedValue({ count: 1 });
    mockTx.deployment.delete.mockResolvedValue({});
    mockTx.deployment.update.mockResolvedValue(deploymentRow());
    mockTx.clientSubdomain.create.mockResolvedValue({ id: 'cs-tx' });
    mockTx.clientProject.findUnique.mockResolvedValue(null);
    mockTx.clientProject.create.mockResolvedValue({ id: 'cp-1', projectUuid: 'proj-1' });
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn(mockTx),
    );
    mockTransport.deleteApplication.mockResolvedValue(undefined);
    mockTransport.setAppEnvironment.mockResolvedValue(undefined);
    mockTransport.applyAppLimits.mockResolvedValue(undefined);
    mockTransport.listServers.mockResolvedValue([]);
    // Projet dédié : aucun par défaut (les tests module B surchargent).
    mockPrisma.clientProject.findUnique.mockResolvedValue(null);
    mockCloudflare.deleteDnsRecord.mockResolvedValue({ id: 'rec-1' });
    // 17B.4F-C2 — défauts du moteur C1 (non utilisés tant que la garde OFF).
    mockHosting.reserveSlot.mockResolvedValue({
      allocation: allocationRow(),
      replayed: false,
    });
    mockHosting.markProviderIntent.mockResolvedValue({
      applied: true,
      providerIntentAt: new Date('2026-09-26T10:00:00Z'),
    });
    mockHosting.releasePreProvider.mockResolvedValue({ released: true });
    mockHosting.markBound.mockResolvedValue(
      allocationRow({ status: 'BOUND', deploymentId: 'dep1' }),
    );
    mockPrisma.hostingService.findMany.mockResolvedValue([]);
    mockPrisma.deployment.deleteMany.mockResolvedValue({ count: 1 });
  });

  describe('create()', () => {
    it('403 quand le flag deployEnabled est OFF', async () => {
      mockSettings.isDeployEnabled.mockResolvedValue(false);
      await expect(
        service.create({ repoFullName: 'owner/repo' }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('400 quand aucun compte GitHub n’est lié', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', githubTokenEnc: null });
      await expect(
        service.create({ repoFullName: 'owner/repo' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('400 quand le dépôt n’est pas possédé', async () => {
      mockGithub.repoExists.mockResolvedValue(false);
      await expect(
        service.create({ repoFullName: 'autrui/repo' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400 quand le serveur du module n’est pas sur un panneau COOLIFY', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        autoTarget({ deploymentModule: autoModule({ server: { ...serverRow(), panelProvider: 'HESTIA' } }) }),
      );
      await expect(
        service.create({ repoFullName: 'owner/repo' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400 quand le serveur Coolify du module n’est pas connecté (panelOk ≠ true)', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        autoTarget({ deploymentModule: autoModule({ server: { ...serverRow(), panelOk: false } }) }),
      );
      await expect(
        service.create({ repoFullName: 'owner/repo' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('flux heureux : PENDING → createGitApp → deployApp → DEPLOYING, audit deploy.create, coolifyUuid jamais exposé', async () => {
      mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
      mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
      mockTransport.deployApp.mockResolvedValue(undefined);
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow());
      // Phase 17 (3d) — quota par pack : comptage findMany (apps du pack du client).
      mockPrisma.deployment.findMany.mockResolvedValue([]);

      const out = await service.create({ repoFullName: 'owner/repo' }, actor);

      expect(mockPrisma.deployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'u1',
          serverId: 'srv-coolify',
          repoFullName: 'owner/repo',
          branch: 'main',
          buildPack: 'nixpacks',
          appName: 'repo',
          status: 'PENDING',
        }),
      });
      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'COOLIFY', token: 'coolify-token' }),
        {
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          serviceName: 'repo',
          buildPack: 'nixpacks',
          appName: 'repo',
          projectUuid: 'proj-shared',
        },
      );
      expect(mockTransport.deployApp).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'COOLIFY' }),
        'app-1',
      );
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dep1' },
          data: expect.objectContaining({ coolifyUuid: 'app-1', status: 'DEPLOYING' }),
          include: expect.anything(), // service + server pour la réponse de création
        }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.create', resourceId: 'dep1' }),
      );
      expect(out).not.toHaveProperty('coolifyUuid');
      expect(out.status).toBe('DEPLOYING');
      expect(out.branch).toBe('main');
    });

    it('branche explicite et trimmée', async () => {
      mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null, branch: 'develop' }));
      mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
      mockTransport.deployApp.mockResolvedValue(undefined);
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow({ branch: 'develop' }));
      // Phase 17 (3d) — quota par pack : comptage findMany (apps du pack du client).
      mockPrisma.deployment.findMany.mockResolvedValue([]);

      await service.create({ repoFullName: 'owner/repo', branch: ' develop ' }, actor);
      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ branch: 'develop' }),
      );
    });

    it('Phase 12 — pack ACTIVE du produit : limites appliquées AVANT deployApp', async () => {
      // Service dont le produit est abonné à un pack ACTIVE (RAM 1 Go, 1 CPU).
      mockPrisma.subscription.findFirst.mockResolvedValue(
        autoTarget({ name: 'Starter 1 Go', ramMb: 1024, cpuCores: 1 }),
      );
      mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
      mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
      mockTransport.applyAppLimits.mockResolvedValue(undefined);
      mockTransport.deployApp.mockResolvedValue(undefined);
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow());
      // Phase 17 (3d) — quota par pack : comptage findMany (apps du pack du client).
      mockPrisma.deployment.findMany.mockResolvedValue([]);

      const out = await service.create({ repoFullName: 'owner/repo' }, actor);

      // Ordre : createGitApp → applyAppLimits → deployApp.
      expect(mockTransport.createGitApp).toHaveBeenCalledTimes(1);
      expect(mockTransport.applyAppLimits).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'COOLIFY', token: 'coolify-token' }),
        'app-1',
        { cpus: '1', memory: '1g' },
      );
      expect(mockTransport.deployApp).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'COOLIFY' }),
        'app-1',
      );
      const createOrder = mockTransport.createGitApp.mock.invocationCallOrder[0];
      const limitsOrder = mockTransport.applyAppLimits.mock.invocationCallOrder[0];
      const deployOrder = mockTransport.deployApp.mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(limitsOrder);
      expect(limitsOrder).toBeLessThan(deployOrder);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.limits', details: expect.objectContaining({ memory: '1g', cpus: '1', packName: 'Starter 1 Go' }) }),
      );
      expect(out.status).toBe('DEPLOYING');
    });

    it('Bloc 3 — limites refusées ⇒ bottom-effort (Phase 17 décision #2) : app lancée quand même, limitsStatus=FAILED tracé', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        autoTarget({ name: 'Starter 1 Go', ramMb: 1024, cpuCores: 1 }),
      );
      mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
      mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
      mockTransport.applyAppLimits.mockRejectedValueOnce(new Error('Coolify API : application des limites refusée (HTTP 400)'));
      mockTransport.deployApp.mockResolvedValue(undefined);
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow({ status: 'DEPLOYING' }));
      mockPrisma.deployment.findMany.mockResolvedValue([]);

      // Best-effort : un échec d'application des limites N'EMPÊCHE PLUS le
      // déploiement de l'app cliente (décision #2). L'échec n'est plus silencieux :
      // on trace limitsStatus=FAILED + message (visible monitoring admin), et
      // l'app est lance quand même sur Coolify (sans plafond, à re-poser manuellement).
      const out = await service.create({ repoFullName: 'owner/repo' }, actor);

      expect(out.status).toBe('DEPLOYING');
      expect(mockTransport.deployApp).toHaveBeenCalled();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.limits.failed' }),
      );
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dep1' },
          data: expect.objectContaining({
            limitsStatus: 'FAILED',
            limitsLastError: expect.any(String),
            limitsRamMb: 1024,
            limitsCpu: 1,
          }),
        }),
      );
    });

    describe('Phase 3 — sous-domaine Cloudflare alloué au déploiement', () => {
      const root = {
        id: 'dom1',
        name: 'arumdigital.com',
        zoneId: 'z1',
        cnameTarget: null,
        status: 'ACTIVE' as const,
        createdAt: new Date('2026-09-01T10:00:00Z'),
        updatedAt: new Date('2026-09-01T10:00:00Z'),
      };

      it('racine configurée + sous-domaine saisi ⇒ allocate appelé, update écrit subdomain/fqdn/domainId et detail URL', async () => {
                mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
        mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
        mockTransport.deployApp.mockResolvedValue(undefined);
        mockPrisma.deployment.update.mockResolvedValue(deploymentRow());
        mockCloudflare.findActiveRootDomain.mockResolvedValue(root);
        mockCloudflare.allocateClientSubdomain.mockResolvedValue({ subdomain: 'monapp', fqdn: 'monapp.arumdigital.com' });

        await service.create({ repoFullName: 'owner/repo', subdomain: 'monapp' }, actor);

        expect(mockCloudflare.allocateClientSubdomain).toHaveBeenCalledWith(
          expect.objectContaining({ root, requested: 'monapp', fallbackHost: 'portal.exemple.com' }),
        );
        expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              subdomain: 'monapp',
              fqdn: 'monapp.arumdigital.com',
              domainId: 'dom1',
              detail: expect.stringContaining('https://monapp.arumdigital.com'),
            }),
          }),
        );
        expect(mockAudit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'deploy.domain' }));
        // Ordre : l'allocation DNS (après création de l'app) précède le run.
        const dnsOrder = mockCloudflare.allocateClientSubdomain.mock.invocationCallOrder[0];
        const deployOrder = mockTransport.deployApp.mock.invocationCallOrder[0];
        expect(dnsOrder).toBeLessThan(deployOrder);
      });

      it('racine NON configurée ⇒ aucun appel allocation, déploiement normal', async () => {
                mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
        mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
        mockTransport.deployApp.mockResolvedValue(undefined);
        mockPrisma.deployment.update.mockResolvedValue(deploymentRow());
        mockCloudflare.findActiveRootDomain.mockResolvedValue(null);

        await service.create({ repoFullName: 'owner/repo' }, actor);

        expect(mockCloudflare.allocateClientSubdomain).not.toHaveBeenCalled();
      });

      it('échec d’allocation ⇒ best-effort : ligne DEPLOYING quand même + audit deploy.domain.warn', async () => {
                mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
        mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
        mockTransport.deployApp.mockResolvedValue(undefined);
        mockPrisma.deployment.update.mockResolvedValue(deploymentRow());
        mockCloudflare.findActiveRootDomain.mockResolvedValue(root);
        mockCloudflare.allocateClientSubdomain.mockRejectedValue(new Error('Sous-domaine déjà pris : monapp.arumdigital.com'));

        const out = await service.create({ repoFullName: 'owner/repo', subdomain: 'monapp' }, actor);

        expect(out.status).toBe('DEPLOYING');
        expect(mockTransport.deployApp).toHaveBeenCalled(); // jamais bloqué par le DNS
        expect(mockAudit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'deploy.domain.warn' }));
      });
    });

    it('échec Coolify : ligne FAILED + audit deploy.failed + 502', async () => {
      mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
      mockTransport.createGitApp.mockRejectedValue(new Error('Coolify API : création refusée (HTTP 401)'));
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow({ status: 'FAILED', detail: 'Coolify API : création refusée (HTTP 401)' }));

      await expect(
        service.create({ repoFullName: 'owner/repo' }, actor),
      ).rejects.toBeInstanceOf(BadGatewayException);

      expect(mockPrisma.deployment.update).toHaveBeenCalledWith({
        where: { id: 'dep1' },
        data: expect.objectContaining({ status: 'FAILED' }),
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.failed' }),
      );
    });
  });

  describe('create() — mode URL collée (Phase 10bis.5)', () => {
    it('déploie par URL SANS compte GitHub lié : aucun appel decryptToken/repoExists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', githubTokenEnc: null });
      mockGithub.detectRepo.mockResolvedValue({
        valid: true,
        repoUrl: 'https://github.com/owner/repo.git',
        repoFullName: 'owner/repo',
        defaultBranch: 'develop',
        language: 'PHP',
        suggestedBuildPack: 'nixpacks',
      });
      mockPrisma.deployment.create.mockResolvedValue(
        deploymentRow({ status: 'PENDING', coolifyUuid: null, repoUrl: 'https://github.com/owner/repo.git' }),
      );
      mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-url-1' });
      mockTransport.deployApp.mockResolvedValue(undefined);
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow());

      const out = await service.create(
        { repoUrl: 'https://github.com/owner/repo.git' },
        actor,
      );

      expect(mockGithub.decryptToken).not.toHaveBeenCalled();
      expect(mockGithub.repoExists).not.toHaveBeenCalled();
      expect(mockGithub.detectRepo).toHaveBeenCalledWith('https://github.com/owner/repo.git');
      expect(mockPrisma.deployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          repoUrl: 'https://github.com/owner/repo.git',
          repoFullName: 'owner/repo',
          branch: 'develop', // branche détectée, pas « main »
          buildPack: 'nixpacks',
          appName: 'repo',
        }),
      });
      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'develop',
          buildPack: 'nixpacks',
          appName: 'repo',
        }),
      );
      expect(out).not.toHaveProperty('coolifyUuid');
      expect(out.status).toBe('DEPLOYING');
    });

    it('URL : buildPack et appName fournis par le client priment sur la détection', async () => {
      mockGithub.detectRepo.mockResolvedValue({
        valid: true,
        repoUrl: 'https://gitlab.com/foo/bar.git',
        repoFullName: 'foo/bar',
        defaultBranch: 'main',
        language: null,
        suggestedBuildPack: 'nixpacks',
      });
      mockPrisma.deployment.create.mockResolvedValue(
        deploymentRow({ status: 'PENDING', coolifyUuid: null }),
      );
      mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-2' });
      mockTransport.deployApp.mockResolvedValue(undefined);
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow());

      await service.create(
        {
          repoUrl: 'https://gitlab.com/foo/bar.git',
          buildPack: 'dockerfile',
          appName: 'mon-app',
        },
        actor,
      );

      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ buildPack: 'dockerfile', appName: 'mon-app' }),
      );
      expect(mockPrisma.deployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ buildPack: 'dockerfile', appName: 'mon-app' }),
      });
    });

    it('400 sur URL invalide (l’assainissement lève)', async () => {
      mockGithub.detectRepo.mockImplementation(() => {
        throw new BadRequestException('URL de dépôt invalide');
      });
      await expect(
        service.create({ repoUrl: 'ftp://x/y' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('400 quand les deux modes sont fournis (repoFullName ET repoUrl)', async () => {
      await expect(
        service.create(
          { repoFullName: 'owner/repo', repoUrl: 'https://github.com/owner/repo.git' },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });
  });

  describe('detect() (Phase 10bis.5)', () => {
    it('403 quand deployEnabled est OFF', async () => {
      mockSettings.isDeployEnabled.mockResolvedValue(false);
      await expect(service.detect(actor, 'https://github.com/o/r')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockGithub.detectRepo).not.toHaveBeenCalled();
    });

    it('retourne le résultat de la détection (best-effort, sans token)', async () => {
      mockGithub.detectRepo.mockResolvedValue({
        valid: true,
        repoUrl: 'https://github.com/o/r.git',
        repoFullName: 'o/r',
        defaultBranch: 'main',
        language: 'Go',
        suggestedBuildPack: 'nixpacks',
      });
      const out = await service.detect(actor, 'https://github.com/o/r.git');
      expect(mockGithub.detectRepo).toHaveBeenCalledWith('https://github.com/o/r.git');
      expect(out.suggestedBuildPack).toBe('nixpacks');
      expect(mockGithub.decryptToken).not.toHaveBeenCalled();
    });
  });

  describe("create() — détection SPA Vite (fix 503 « no available server »)", () => {
    const happyMocks = () => {
      mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
      mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
      mockTransport.deployApp.mockResolvedValue(undefined);
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow());
      // Phase 17 (3d) — la vérification de quota (par pack) passe par findMany.
      mockPrisma.deployment.findMany.mockResolvedValue([]);
    };

    it('SPA Vite détecté ⇒ buildPack garde nixpacks (la voie store build+got statique), publishDirectory "/dist", isStatic:true envoyé à Coolify', async () => {
      mockGithub.readBuildConfig.mockResolvedValue({ environment: {}, source: 'none', publishDirectory: '/dist', isStatic: true });
      happyMocks();

      await service.create({ repoFullName: 'owner/spa' }, actor);

      // Ne PAS forcer build_pack "static" (le pack static ne build pas → page
      // vide). On garde nixpacks (build → dist) + isStatic + /dist (servi statique).
      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          buildPack: 'nixpacks',
          publishDirectory: '/dist',
          isStatic: true,
        }),
      );
      expect(mockPrisma.deployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          buildPack: 'nixpacks',
          publishDirectory: '/dist',
        }),
      });
    });

    it('repo backend (sans vite) ⇒ aucun isStatic, buildPack nixpacks non statique', async () => {
      mockGithub.readBuildConfig.mockResolvedValue({ environment: {}, source: 'none' });
      happyMocks();

      await service.create({ repoFullName: 'owner/api' }, actor);

      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ buildPack: 'nixpacks' }),
      );
      const [, input] = mockTransport.createGitApp.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(input.publishDirectory).toBeUndefined();
      expect(input.isStatic).toBeUndefined();
      expect(mockPrisma.deployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ buildPack: 'nixpacks' }),
      });
    });

    it('SPA Vite : un buildPack/client explicite est honoré (pas écrasé), isStatic:/dist transmis quand même', async () => {
      mockGithub.readBuildConfig.mockResolvedValue({ environment: {}, source: 'none', publishDirectory: '/dist', isStatic: true });
      happyMocks();

      await service.create({ repoFullName: 'owner/spa', buildPack: 'nixpacks' }, actor);

      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ buildPack: 'nixpacks', publishDirectory: '/dist', isStatic: true }),
      );
    });
  });

  describe('listMine() / findMine()', () => {
    it('listMine ne renvoie que les déploiements du client, masqués + quota du pack ACTIF', async () => {
      // MÊME lecture pack-scoped que l'enforcement (B0.3/B0.4) : 1 ligne locale.
      mockPrisma.deployment.findMany.mockResolvedValue([deploymentRow()]);
      // Pack ACTIF du compte (module lié, maxApps=2) → quota exposé au client.
      mockPrisma.subscription.findFirst.mockResolvedValue({
        product: { pack: { id: 'pack1', name: 'Starter', status: 'ACTIVE', ramMb: 1024, cpuCores: 1, storageLimit: 20, maxApps: 2, bandwidth: null } },
      });
      const out = await service.listMine(actor);
      expect(mockPrisma.deployment.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        include: expect.anything(),
        orderBy: { createdAt: 'desc' },
      });
      expect(out.deployments).toHaveLength(1);
      expect(out.deployments[0]).not.toHaveProperty('coolifyUuid');
      expect(out.quota).toEqual({
        pack: expect.objectContaining({ name: 'Starter', maxApps: 2, ramMb: 1024, cpuCores: 1 }),
        used: 1,
        limit: 2,
        remaining: 1,
        quotaFull: false,
      });
      // B0.3 — un seul et même comptage : ni count() global, ni prédicat FAILED.
      expect(mockPrisma.deployment.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', packId: 'pack1' },
        select: { limitsRamMb: true, limitsCpu: true },
      });
      expect(mockPrisma.deployment.count).not.toHaveBeenCalled();
    });

    it('B0.3 : le comptage inclut les lignes FAILED (aucun prédicat status != FAILED)', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        product: { pack: { id: 'pack1', name: 'Starter', status: 'ACTIVE', ramMb: 512, cpuCores: 1, storageLimit: null, maxApps: 2, bandwidth: null } },
      });
      mockPrisma.deployment.findMany
        .mockResolvedValueOnce([]) // liste du dashboard (aucune app affichée)
        .mockResolvedValueOnce([
          { limitsRamMb: null, limitsCpu: null },
          { limitsRamMb: null, limitsCpu: null },
        ]);

      const out = await service.listMine(actor);

      expect(out.deployments).toHaveLength(0);
      expect(out.quota).toMatchObject({ used: 2, limit: 2, remaining: 0, quotaFull: true });
      expect(mockPrisma.deployment.count).not.toHaveBeenCalled();
    });

    it('B0.3 fail-closed : comptage indéterminable ⇒ quota null (jamais présenté comme certain)', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        product: { pack: { id: 'pack1', name: 'Starter', status: 'ACTIVE', ramMb: 512, cpuCores: 1, storageLimit: null, maxApps: 2, bandwidth: null } },
      });
      mockPrisma.deployment.findMany
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('db down'));

      const out = await service.listMine(actor);
      expect(out.quota).toBeNull();
    });

    it('listMine : aucun pack ACTIF ⇒ quota null (pas de compteur à afficher)', async () => {
      mockPrisma.deployment.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      const out = await service.listMine(actor);
      expect(out.deployments).toHaveLength(0);
      expect(out.quota).toBeNull();
      expect(mockPrisma.deployment.count).not.toHaveBeenCalled();
    });

    it('findMine : 404 pour un déploiement d’un autre client', async () => {
      mockPrisma.deployment.findFirst.mockResolvedValue(null);
      await expect(service.findMine('dep-autrui', actor)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('findMine rafraîchit live : rawStatus running → ACTIVE + audit deploy.status', async () => {
      mockPrisma.deployment.findFirst.mockResolvedValue(deploymentRow());
      mockPrisma.server.findUnique.mockResolvedValue(serverRow());
      mockTransport.deploymentStatus.mockResolvedValue({ rawStatus: 'running' });
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow({ status: 'ACTIVE', detail: undefined }));

      const out = await service.findMine('dep1', actor);

      expect(mockTransport.deploymentStatus).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'COOLIFY' }),
        'app-1',
      );
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith({
        where: { id: 'dep1' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
        include: expect.anything(),
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.status', details: expect.objectContaining({ from: 'DEPLOYING', to: 'ACTIVE' }) }),
      );
      expect(out.status).toBe('ACTIVE');
    });

    it('findMine : statut inconnu/illisible → état courant conservé (best-effort)', async () => {
      mockPrisma.deployment.findFirst.mockResolvedValue(deploymentRow());
      mockPrisma.server.findUnique.mockResolvedValue(serverRow());
      mockTransport.deploymentStatus.mockResolvedValue({ rawStatus: 'weird-state' });

      const out = await service.findMine('dep1', actor);

      expect(mockPrisma.deployment.update).not.toHaveBeenCalled();
      expect(out.status).toBe('DEPLOYING');
    });

    it('findMine : Coolify injoignable → état courant conservé (jamais rejeté)', async () => {
      mockPrisma.deployment.findFirst.mockResolvedValue(deploymentRow());
      mockPrisma.server.findUnique.mockResolvedValue(serverRow());
      mockTransport.deploymentStatus.mockRejectedValue(new Error('Connexion refusée'));

      const out = await service.findMine('dep1', actor);
      expect(out.status).toBe('DEPLOYING');
    });
  });

  describe('GitHub (M)', () => {
    it('listRepos : 403 quand deployEnabled est OFF', async () => {
      mockSettings.isDeployEnabled.mockResolvedValue(false);
      await expect(service.listRepos(actor)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listRepos renvoie les repos détectés quand GitHub est lié', async () => {
      mockGithub.listRepos.mockResolvedValue([
        { fullName: 'owner/repo', defaultBranch: 'main', private: false, language: 'TypeScript' },
      ]);
      const out = await service.listRepos(actor);
      expect(mockGithub.decryptToken).toHaveBeenCalledWith('enc:gh');
      expect(out).toHaveLength(1);
      expect(out[0].fullName).toBe('owner/repo');
    });

    it('linkStatus : absent → { linked:false }', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', githubTokenEnc: null });
      await expect(service.linkStatus(actor)).resolves.toEqual({ linked: false, login: null });
    });

    it('linkStatus : présent → { linked:true, login }', async () => {
      mockCrypto.decrypt.mockReturnValue('gh-token');
      mockGithub.fetchUser.mockResolvedValue({ login: 'octocat' });
      await expect(service.linkStatus(actor)).resolves.toEqual({ linked: true, login: 'octocat' });
    });
  });

  describe("create() — Phase 13 : cible par module A/B sans service + quota d'apps", () => {
    const moduleRow = (over: Record<string, unknown> = {}) => ({
      id: 'modA',
      name: 'Module A — projet partagé',
      code: 'A',
      kind: 'SHARED_PROJECT',
      description: null,
      isActive: true,
      serverId: 'srv-coolify',
      sharedProjectUuid: 'proj-shared',
      sharedProjectName: 'Projet partagé',
      perClientPrefix: 'client',
      overrideRamMb: null,
      overrideCpuCores: null,
      overrideStorageLimit: null,
      server: serverRow(), // serveur Coolify connecté du module
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });
    const moduleB = (over: Record<string, unknown> = {}) =>
      moduleRow({
        id: 'modB',
        code: 'B',
        kind: 'PER_CLIENT_PROJECT',
        sharedProjectUuid: null,
        sharedProjectName: null,
        ...over,
      });
    const packWithModule = (over: Record<string, unknown> = {}) => {
      const pack = over.deploymentModule === undefined ? { deploymentModule: moduleRow() } : {};
      return {
        id: 'pack1',
        name: 'Starter 1 Go',
        status: 'ACTIVE',
        ramMb: 512,
        cpuCores: 1,
        storageLimit: 20,
        bandwidth: null,
        maxApps: null,
        deploymentModuleId: 'modA',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...pack,
        ...over,
      };
    };
    const activeSubscription = (pack: unknown) => ({
      id: 'sub-act',
      userId: 'u1',
      productId: 'prod1',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
      product: { id: 'prod1', pack },
    });
    const happyMocks = () => {
      mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
      mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
      mockTransport.deployApp.mockResolvedValue(undefined);
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow());
      // Phase 17 (3d) — quota par pack vérifié via findMany (apps du pack du client).
      mockPrisma.deployment.findMany.mockResolvedValue([]);
    };

    it('mode auto (sans serviceId) : pack ACTIF → module A → app dans le projet partagé, serviceId null', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        activeSubscription(packWithModule({ deploymentModule: moduleRow() })),
      );
      happyMocks();

      const out = await service.create({ repoFullName: 'owner/repo' }, actor);

      expect(mockPrisma.subscription.findFirst).toHaveBeenCalledWith({
        where: { userId: 'u1', status: 'ACTIVE' },
        include: expect.anything(),
        orderBy: { createdAt: 'desc' },
      });
      expect(mockPrisma.deployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'u1',
                    serverId: 'srv-coolify',
          moduleId: 'modA',
          coolifyProjectUuid: 'proj-shared',
          clientProjectId: null,
        }),
      });
      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ projectUuid: 'proj-shared' }),
      );
      expect(out.status).toBe('DEPLOYING');
    });

    it('mode auto : aucun abonnement/pack ACTIF → 403, rien n’est créé', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      await expect(service.create({ repoFullName: 'owner/repo' }, actor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('mode auto : pack ACTIF sans module lié ni module par défaut → 400 lisible', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        activeSubscription(packWithModule({ deploymentModule: null })),
      );
      mockPrisma.deploymentModule.findFirst.mockResolvedValue(null);
      await expect(service.create({ repoFullName: 'owner/repo' }, actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('module A sans projet partagé configuré → 400', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        activeSubscription(packWithModule({ deploymentModule: moduleRow({ sharedProjectUuid: null }) })),
      );
      await expect(service.create({ repoFullName: 'owner/repo' }, actor)).rejects.toThrow(
        /projet Coolify configuré/,
      );
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('module B : projet client créé paresseusement à la première app, toutes les apps y vivent', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        activeSubscription(packWithModule({ deploymentModule: moduleB() })),
      );
      mockPrisma.clientProject.findUnique.mockResolvedValue(null); // pas encore créé
      mockTransport.createProject.mockResolvedValue({ uuid: 'proj-client', name: 'client-u1' });
      mockPrisma.clientProject.create.mockResolvedValue({
        id: 'cp1',
        userId: 'u1',
        serverId: 'srv-coolify',
        moduleId: 'modB',
        name: 'client-u1',
        projectUuid: 'proj-client',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      happyMocks();

      const out = await service.create({ repoFullName: 'owner/repo' }, actor);

      expect(mockTransport.createProject).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'COOLIFY', token: 'coolify-token' }),
        expect.objectContaining({ name: 'client-u1', serverUuid: '0' }),
      );
      expect(mockPrisma.clientProject.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'u1',
          serverId: 'srv-coolify',
          moduleId: 'modB',
          name: 'client-u1',
          projectUuid: 'proj-client',
        }),
      });
      expect(mockPrisma.deployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
                    moduleId: 'modB',
          coolifyProjectUuid: 'proj-client',
          clientProjectId: 'cp1',
        }),
      });
      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ projectUuid: 'proj-client' }),
      );
      expect(out.status).toBe('DEPLOYING');
    });

    it('module B : projet déjà existant → réutilisé, aucun POST /projects', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        activeSubscription(packWithModule({ deploymentModule: moduleB() })),
      );
      mockPrisma.clientProject.findUnique.mockResolvedValue({
        id: 'cp1',
        userId: 'u1',
        serverId: 'srv-coolify',
        moduleId: 'modB',
        name: 'client-u1',
        projectUuid: 'proj-client',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      happyMocks();

      await service.create({ repoFullName: 'owner/repo' }, actor);

      expect(mockTransport.createProject).not.toHaveBeenCalled();
      expect(mockPrisma.clientProject.create).not.toHaveBeenCalled();
      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ projectUuid: 'proj-client' }),
      );
    });

    it('module B : DEUX modules différents, MÊME client/serveur → un seul projet réutilisé', async () => {
      // Le client installe une 2ème app via un AUTRE module B (modB2, même serveur) :
      // il doit retomber sur SON projet existant, jamais en créer un nouveau.
      const existing = {
        id: 'cp1',
        userId: 'u1',
        serverId: 'srv-coolify',
        moduleId: 'modB2',
        name: 'client-u1',
        projectUuid: 'proj-client',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrisma.subscription.findFirst.mockResolvedValue(
        activeSubscription(
          packWithModule({ deploymentModule: moduleB({ id: 'modB2', code: 'B2' }) }),
        ),
      );
      mockPrisma.clientProject.findUnique.mockResolvedValue(existing);
      happyMocks();

      await service.create({ repoFullName: 'owner/repo2' }, actor);

      // Aucun nouveau projet créé ; la 2ème app va dans le projet du client.
      expect(mockTransport.createProject).not.toHaveBeenCalled();
      expect(mockPrisma.clientProject.create).not.toHaveBeenCalled();
      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ projectUuid: 'proj-client' }),
      );
      expect(mockPrisma.deployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ clientProjectId: 'cp1', coolifyProjectUuid: 'proj-client' }),
      });
    });

    it("quota d'apps du pack : atteint (2/2) → 403 avec le compteur, rien n'est créé", async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        activeSubscription(packWithModule({ maxApps: 2 })),
      );
      // 2 apps existantes dans CE pack (Phase 17 3d) — le quota est compté PAR PACK.
      mockPrisma.deployment.findMany.mockResolvedValue([
        { limitsRamMb: 512, limitsCpu: 1 },
        { limitsRamMb: 512, limitsCpu: 1 },
      ]);

      await expect(service.create({ repoFullName: 'owner/repo' }, actor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockPrisma.deployment.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', packId: 'pack1' },
        select: { limitsRamMb: true, limitsCpu: true },
      });
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
      // B0.5 — JAMAIS d'action externe avant la validation pack + quota.
      expect(mockGithub.repoExists).not.toHaveBeenCalled();
      expect(mockTransport.createProject).not.toHaveBeenCalled();
    });

    it("quota d'apps du pack : sous la limite (1/2) → déploiement autorisé", async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        activeSubscription(packWithModule({ maxApps: 2 })),
      );
      happyMocks();
      mockPrisma.deployment.findMany.mockResolvedValue([{ limitsRamMb: 512, limitsCpu: 1 }]);

      const out = await service.create({ repoFullName: 'owner/repo' }, actor);
      expect(out.status).toBe('DEPLOYING');
    });

    it("quota illimité (maxApps null) → comptage par pack appelé mais jamais bloquant", async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(activeSubscription(packWithModule()));
      happyMocks();
      const out = await service.create({ repoFullName: 'owner/repo' }, actor);
      expect(mockPrisma.deployment.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', packId: 'pack1' },
        select: { limitsRamMb: true, limitsCpu: true },
      });
      expect(out.status).toBe('DEPLOYING');
    });

    it('overrides du module (RAM/CPU) priment sur le pack dans applyAppLimits', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        activeSubscription(
          packWithModule({ deploymentModule: moduleRow({ overrideRamMb: 2048, overrideCpuCores: 2 }) }),
        ),
      );
      happyMocks();

      await service.create({ repoFullName: 'owner/repo' }, actor);

      expect(mockTransport.applyAppLimits).toHaveBeenCalledWith(
        expect.anything(),
        'app-1',
        { cpus: '2', memory: '2g' },
      );
    });

    it('mode auto : pack ACTIF avec module → le projet du module (A partagé) est utilisé', async () => {
      happyMocks();

      await service.create({ repoFullName: 'owner/repo' }, actor);

      expect(mockPrisma.subscription.findFirst).toHaveBeenCalled();
      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ projectUuid: 'proj-shared' }),
      );
      expect(mockPrisma.deployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ moduleId: 'modA' }),
      }      );
    });

    it('B0.5 : aucun pack actif ⇒ 403 AVANT tout appel GitHub, provider ou row', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      await expect(
        service.create({ repoUrl: 'https://github.com/owner/repo.git' }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockGithub.detectRepo).not.toHaveBeenCalled();
      expect(mockGithub.repoExists).not.toHaveBeenCalled();
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockTransport.createProject).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
    });

    it('B0.5 : pack actif mais module non résolvable ⇒ 400 AVANT toute action externe', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        activeSubscription(packWithModule({ deploymentModule: null })),
      );
      mockPrisma.deploymentModule.findFirst.mockResolvedValue(null);
      await expect(
        service.create({ repoFullName: 'owner/repo' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockGithub.repoExists).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('B0.3 fail-closed : comptage quota indéterminable ⇒ 403, aucune écriture ni action externe', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        activeSubscription(packWithModule({ maxApps: 2 })),
      );
      mockPrisma.deployment.findMany.mockRejectedValue(new Error('db down'));

      await expect(
        service.create({ repoFullName: 'owner/repo' }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockGithub.repoExists).not.toHaveBeenCalled();
      expect(mockTransport.createProject).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('remove() — B0.1/B0.2 suppression sûre', () => {
    const removeRow = (over: Record<string, unknown> = {}) => ({
      ...deploymentRow({ status: 'ACTIVE', appName: 'mon-app' }),
      server: serverRow(),
      clientSubdomain: {
        id: 'cs1',
        subdomain: 'monapp',
        domainId: 'dom1',
        fqdn: 'monapp.example.com',
        recordId: 'rec1',
        deploymentId: 'dep1',
        domain: { id: 'dom1', name: 'example.com', zoneId: 'zone1' },
      },
      ...over,
    });

    it('ownership client : 404 pour une app d’un autre client (aucun appel provider/DNS)', async () => {
      mockPrisma.deployment.findFirst.mockResolvedValue(null);
      await expect(service.remove('dep-autrui', actor)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockTransport.deleteApplication).not.toHaveBeenCalled();
      expect(mockCloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('heureux : provider + DNS confirmés puis rows locales supprimées, partial=false', async () => {
      mockPrisma.deployment.findFirst.mockResolvedValue(removeRow());
      const out = await service.remove('dep1', actor);
      expect(mockTransport.deleteApplication).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'COOLIFY', token: 'coolify-token' }),
        'app-1',
      );
      expect(mockCloudflare.deleteDnsRecord).toHaveBeenCalledWith('dom1', 'rec1', actor);
      expect(mockTx.clientSubdomain.deleteMany).toHaveBeenCalledWith({
        where: { deploymentId: 'dep1' },
      });
      expect(mockTx.deployment.delete).toHaveBeenCalledWith({ where: { id: 'dep1' } });
      expect(out).toEqual({ removed: true, appName: 'mon-app', partial: false, freedQuota: false });
    });

    it('B0.1 : échec provider non-absent ⇒ 502 et AUCUNE suppression locale (fail-closed)', async () => {
      mockPrisma.deployment.findFirst.mockResolvedValue(removeRow());
      mockTransport.deleteApplication.mockRejectedValue(
        new Error('HTTP 500 JWT_SECRET=abc123'),
      );

      await expect(service.remove('dep1', actor)).rejects.toBeInstanceOf(BadGatewayException);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockTx.deployment.delete).not.toHaveBeenCalled();
      expect(mockTx.clientSubdomain.deleteMany).not.toHaveBeenCalled();
      expect(mockCloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      // B0.8 — aucun message d'exception brut dans l'audit.
      const dump = JSON.stringify(mockAudit.record.mock.calls);
      expect(dump).toContain('"outcome":"failed"');
      expect(dump).not.toContain('JWT_SECRET=abc123');
    });

    it('B0.1 : ressource provider déjà absente (404) confirmée ⇒ suppression locale poursuivie', async () => {
      mockPrisma.deployment.findFirst.mockResolvedValue(removeRow());
      mockTransport.deleteApplication.mockRejectedValue(new Error('HTTP 404 not found'));

      const out = await service.remove('dep1', actor);

      expect(out).toEqual({ removed: true, appName: 'mon-app', partial: false, freedQuota: false });
      expect(mockTx.deployment.delete).toHaveBeenCalledWith({ where: { id: 'dep1' } });
      expect(mockCloudflare.deleteDnsRecord).toHaveBeenCalled();
    });

    it('B0.2 : row ClientSubdomain étrangère ⇒ JAMAIS d’appel DNS, row conservée, app supprimée', async () => {
      mockPrisma.deployment.findFirst.mockResolvedValue(
        removeRow({
          clientSubdomain: {
            id: 'csX',
            subdomain: 'autrui',
            domainId: 'dom1',
            fqdn: 'autrui.example.com',
            recordId: 'rec1',
            deploymentId: 'autre-app',
            domain: { id: 'dom1', name: 'example.com', zoneId: 'zone1' },
          },
        }),
      );

      const out = await service.remove('dep1', actor);

      expect(mockCloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(mockTx.clientSubdomain.deleteMany).not.toHaveBeenCalled();
      expect(mockTx.deployment.delete).toHaveBeenCalledWith({ where: { id: 'dep1' } });
      expect(out).toEqual({ removed: true, appName: 'mon-app', partial: false, freedQuota: false });
    });

    it('B0.2 : échec DNS non-absent ⇒ row CS conservée + partial=true, app supprimée', async () => {
      mockPrisma.deployment.findFirst.mockResolvedValue(removeRow());
      mockCloudflare.deleteDnsRecord.mockRejectedValue(new Error('HTTP 500 CF_TOKEN=xyz789'));

      const out = await service.remove('dep1', actor);

      expect(out).toEqual({ removed: true, appName: 'mon-app', partial: true, freedQuota: false });
      expect(mockTx.clientSubdomain.deleteMany).not.toHaveBeenCalled();
      expect(mockTx.deployment.delete).toHaveBeenCalledWith({ where: { id: 'dep1' } });
      expect(JSON.stringify(mockAudit.record.mock.calls)).not.toContain('CF_TOKEN=xyz789');
    });

    it('B0.2 : record DNS déjà absent (404) confirmé ⇒ row CS supprimée, partial=false', async () => {
      mockPrisma.deployment.findFirst.mockResolvedValue(removeRow());
      mockCloudflare.deleteDnsRecord.mockRejectedValue(new Error('record does not exist (404)'));

      const out = await service.remove('dep1', actor);

      expect(out).toEqual({ removed: true, appName: 'mon-app', partial: false, freedQuota: false });
      expect(mockTx.clientSubdomain.deleteMany).toHaveBeenCalledWith({
        where: { deploymentId: 'dep1' },
      });
      expect(mockTx.deployment.delete).toHaveBeenCalledWith({ where: { id: 'dep1' } });
    });
  });

  // ── 17B.4F-C2 — garde HOSTING_C2_ENABLED (OFF par défaut) + parcours sous
  // garde : classification locale, réservation/rejeu, ordre intention provider,
  // compensation pré-provider, liaison allocation → déploiement. ─────────────
  describe('17B.4F-C2 — garde + parcours sous garde', () => {
    const enableC2 = () => {
      process.env.HOSTING_C2_ENABLED = 'true';
    };
    afterEach(() => {
      delete process.env.HOSTING_C2_ENABLED;
    });

    // Fixtures de flow heureux (row PENDING → app → DEPLOYING).
    const happyProvider = () => {
      mockPrisma.deployment.create.mockResolvedValue(
        deploymentRow({ status: 'PENDING', coolifyUuid: null }),
      );
      mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
      mockTransport.deployApp.mockResolvedValue(undefined);
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow());
    };

    const dto = (over: Record<string, unknown> = {}) => ({
      repoFullName: 'owner/repo',
      ...over,
    });

    it('OFF (défaut) : contrat historique — POST sans clientRequestId accepté, ZÉRO accès au moteur hosting', async () => {
      happyProvider();
      const out = await service.create(dto(), actor);
      expect(out.id).toBe('dep1');
      expect(mockPrisma.hostingService.findMany).not.toHaveBeenCalled();
      expect(mockHosting.reserveSlot).not.toHaveBeenCalled();
      expect(mockHosting.markProviderIntent).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.create).toHaveBeenCalledTimes(1);
    });

    it('OFF : GET hosting-services inerte {enabled:false,services:[]} sans accès BDD', async () => {
      const res = await service.listHostingServices(actor);
      expect(res).toEqual({ enabled: false, services: [] });
      expect(mockPrisma.hostingService.findMany).not.toHaveBeenCalled();
    });

    it('ON + legacy PROUVÉ (0 ligne HostingService) : parcours historique, audit c2=legacy_no_service, aucun slot', async () => {
      enableC2();
      happyProvider();
      const out = await service.create(dto(), actor); // pas de clientRequestId : legacy exempt
      expect(out.id).toBe('dep1');
      expect(mockPrisma.hostingService.findMany).toHaveBeenCalledTimes(1);
      expect(mockHosting.reserveSlot).not.toHaveBeenCalled();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deploy.create',
          details: expect.objectContaining({ c2: 'legacy_no_service' }),
        }),
      );
    });

    it('ON : clientRequestId absent → 400, aucune réservation', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      await expect(service.create(dto(), actor)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockHosting.reserveSlot).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('ON : clientRequestId non-UUID → 400 (validation stricte v4), aucune réservation', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      await expect(
        service.create(dto({ clientRequestId: 'pas-un-uuid' }), actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockHosting.reserveSlot).not.toHaveBeenCalled();
    });

    it('ON : hostingServiceId étranger/introuvable → 404, JAMAIS de repli legacy', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow({ id: 'hs-other' })]);
      await expect(
        service.create(dto({ clientRequestId: CID, hostingServiceId: 'hs-foreign' }), actor),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockHosting.reserveSlot).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('ON : service suspendu → 409, aucun repli legacy (aucune row, aucun slot)', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([
        hostingServiceRow({ status: 'SUSPENDED' }),
      ]);
      await expect(
        service.create(dto({ clientRequestId: CID }), actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockHosting.reserveSlot).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('ON : service ACTIF mais pack/module incompatibles → 409 (provenance), aucun repli', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([
        hostingServiceRow({ packId: 'other-pack' }),
      ]);
      await expect(
        service.create(dto({ clientRequestId: CID }), actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockHosting.reserveSlot).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('ON : services existants mais NON rattachés à l’abonnement actif → 409, aucun repli', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([
        hostingServiceRow({ subscriptionId: null, orderId: null }),
      ]);
      await expect(
        service.create(dto({ clientRequestId: CID }), actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockHosting.reserveSlot).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('ON heureux : réservation → intention AVANT création app → markBound(uuid) → audit c2 lié', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();

      const out = await service.create(dto({ clientRequestId: CID, branch: 'main' }), actor);

      expect(out.id).toBe('dep1');
      expect(mockHosting.reserveSlot).toHaveBeenCalledWith({
        hostingServiceId: 'hs1',
        actorUserId: 'u1',
        clientRequestId: CID,
        payload: expect.objectContaining({
          business: expect.objectContaining({ repoFullName: 'owner/repo', branch: 'main' }),
          environment: {},
        }),
      });
      expect(mockHosting.markProviderIntent).toHaveBeenCalledWith({
        allocationId: 'alloc1',
        actorUserId: 'u1',
      });
      expect(mockHosting.markBound).toHaveBeenCalledWith({
        allocationId: 'alloc1',
        actorUserId: 'u1',
        deploymentId: 'dep1',
        proof: { providerProven: true },
      });
      // Ordre : intention provider AVANT la création d'app, liaison APRÈS.
      expect(mockHosting.markProviderIntent.mock.invocationCallOrder[0]).toBeLessThan(
        mockTransport.createGitApp.mock.invocationCallOrder[0]!,
      );
      expect(mockHosting.markBound.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockTransport.createGitApp.mock.invocationCallOrder[0]!,
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deploy.create',
          details: expect.objectContaining({
            c2: { hostingServiceId: 'hs1', allocationId: 'alloc1', clientRequestId: CID },
          }),
        }),
      );
    });

    it('ON : empreinte sur valeurs REÇUES brutes (absente ≠ « main ») — réservation AVANT lecture GitHub', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();

      await service.create(dto({ clientRequestId: CID }), actor); // branche ABSENTE

      const first = mockHosting.reserveSlot.mock.calls[0]![0] as {
        payload: { business: Record<string, unknown>; environment: Record<string, string> };
      };
      expect(first.payload.business.branch).toBeNull(); // absente ⇒ null, jamais 'main'
      expect(mockHosting.reserveSlot.mock.invocationCallOrder[0]).toBeLessThan(
        mockGithub.readBuildConfig.mock.invocationCallOrder[0]!,
      );
      expect(mockHosting.reserveSlot.mock.invocationCallOrder[0]).toBeLessThan(
        mockGithub.repoExists.mock.invocationCallOrder[0]!,
      );
    });

    it('ON : empreinte « main » explicite distincte + environnement REÇU préservé tel quel', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();

      await service.create(
        dto({
          clientRequestId: CID,
          branch: 'main',
          environment: { 'A Key': ' spaced value ' },
        }),
        actor,
      );

      const call = mockHosting.reserveSlot.mock.calls[0]![0] as {
        payload: { business: Record<string, unknown>; environment: Record<string, string> };
      };
      expect(call.payload.business.branch).toBe('main');
      expect(call.payload.environment).toEqual({ 'A Key': ' spaced value ' });
    });

    it('ON rejeu BOUND : renvoie l’opération existante — SANS B0, SANS appel provider', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockHosting.reserveSlot.mockResolvedValue({
        allocation: allocationRow({ status: 'BOUND', deploymentId: 'dep1' }),
        replayed: true,
      });
      mockPrisma.deployment.findFirst.mockResolvedValue(deploymentRow());

      const out = await service.create(dto({ clientRequestId: CID }), actor);

      expect(out.id).toBe('dep1');
      expect(mockPrisma.deployment.findMany).not.toHaveBeenCalled(); // B0 sauté
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
      expect(mockHosting.markProviderIntent).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('ON rejeu BOUND : opération renvoyée MÊME si le quota B0 serait plein', async () => {
      enableC2();
      mockPrisma.subscription.findFirst.mockResolvedValue(autoTarget({ maxApps: 1 }));
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockHosting.reserveSlot.mockResolvedValue({
        allocation: allocationRow({ status: 'BOUND', deploymentId: 'dep1' }),
        replayed: true,
      });
      mockPrisma.deployment.findFirst.mockResolvedValue(deploymentRow());
      mockPrisma.deployment.findMany.mockResolvedValue([{}]); // quota plein si appelé

      const out = await service.create(dto({ clientRequestId: CID }), actor);

      expect(out.id).toBe('dep1');
      expect(mockPrisma.deployment.findMany).not.toHaveBeenCalled();
    });

    it('ON rejeu RESERVED en cours → 409, JAMAIS de takeover ni de 2ᵉ exécution', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockHosting.reserveSlot.mockResolvedValue({
        allocation: allocationRow({ providerIntentAt: null }),
        replayed: true,
      });
      await expect(
        service.create(dto({ clientRequestId: CID }), actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
      expect(mockHosting.markProviderIntent).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('ON rejeu RESERVED avec intention déjà posée (incertitude) → 409 explicite', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockHosting.reserveSlot.mockResolvedValue({
        allocation: allocationRow({ providerIntentAt: new Date('2026-09-26T10:00:00Z') }),
        replayed: true,
      });
      await expect(
        service.create(dto({ clientRequestId: CID }), actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
    });

    it('ON : empreinte différente sur même clientRequestId → 409 du moteur, aucune row', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockHosting.reserveSlot.mockRejectedValue(
        new ConflictException('Rejeu refusé : empreinte de réservation différente.'),
      );
      await expect(
        service.create(dto({ clientRequestId: CID }), actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
    });

    it('ON : B0 plein APRÈS réservation → libération pré-provider, AUCUNE row créée', async () => {
      enableC2();
      mockPrisma.subscription.findFirst.mockResolvedValue(autoTarget({ maxApps: 1 }));
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockPrisma.deployment.findMany.mockResolvedValue([{}]); // 1/1 → quota plein
      await expect(
        service.create(dto({ clientRequestId: CID }), actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockHosting.releasePreProvider).toHaveBeenCalledWith({
        allocationId: 'alloc1',
        actorUserId: 'u1',
      });
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deploy.c2.rollback',
          resourceId: 'alloc1',
          details: expect.objectContaining({ trigger: 'quota', rowCleared: true, released: true }),
        }),
      );
    });

    it('ON : refus GitHub APRÈS réservation → libération pré-provider, AUCUNE row', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockGithub.repoExists.mockResolvedValue(false);
      await expect(
        service.create(dto({ clientRequestId: CID }), actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockHosting.releasePreProvider).toHaveBeenCalledWith({
        allocationId: 'alloc1',
        actorUserId: 'u1',
      });
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('ON : intention provider REFUSÉE après création row → suppression GARDEE de la row + libération + erreur propagée', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockPrisma.deployment.create.mockResolvedValue(
        deploymentRow({ status: 'PENDING', coolifyUuid: null }),
      );
      mockHosting.markProviderIntent.mockResolvedValue({
        applied: false,
        reason: 'invalid_state',
      });
      mockPrisma.deployment.deleteMany.mockResolvedValue({ count: 1 });

      await expect(
        service.create(dto({ clientRequestId: CID }), actor),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(mockPrisma.deployment.deleteMany).toHaveBeenCalledWith({
        where: { id: 'dep1', status: DeploymentStatus.PENDING, coolifyUuid: null },
      });
      expect(mockHosting.releasePreProvider).toHaveBeenCalledWith({
        allocationId: 'alloc1',
        actorUserId: 'u1',
      });
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
    });

    it("ON : écriture de l'intention ÉCHOUÉE (erreur DB) → compensation locale, AUCUNE mutation distante", async () => {
      // `applied=false` est couvert ci-dessus ; ici c'est l'ÉCRITURE elle-même
      // qui échoue : l'intention n'est JAMAIS réputée committée, la compensation
      // pré-provider s'exécute (row PENDING nettoyée, slot libéré) et AUCUN
      // appel provider (projet ni app) n'a lieu — l'erreur d'origine propagée.
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockPrisma.deployment.create.mockResolvedValue(
        deploymentRow({ status: 'PENDING', coolifyUuid: null }),
      );
      mockHosting.markProviderIntent.mockRejectedValue(new Error('écriture intention impossible'));
      mockPrisma.deployment.deleteMany.mockResolvedValue({ count: 1 });

      await expect(service.create(dto({ clientRequestId: CID }), actor)).rejects.toThrow(
        'écriture intention impossible',
      );

      expect(mockPrisma.deployment.deleteMany).toHaveBeenCalledWith({
        where: { id: 'dep1', status: DeploymentStatus.PENDING, coolifyUuid: null },
      });
      expect(mockHosting.releasePreProvider).toHaveBeenCalledWith({
        allocationId: 'alloc1',
        actorUserId: 'u1',
      });
      expect(mockTransport.createProject).not.toHaveBeenCalled(); // 1ʳᵉ mutation distante couverte
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
      expect(mockHosting.markBound).not.toHaveBeenCalled();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deploy.c2.rollback',
          details: expect.objectContaining({ trigger: 'pre_intent', rowCleared: true }),
        }),
      );
    });

    it('ON : échec createGitApp APRÈS intention → JAMAIS de libération, ligne FAILED, 502', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockPrisma.deployment.create.mockResolvedValue(
        deploymentRow({ status: 'PENDING', coolifyUuid: null }),
      );
      mockHosting.markProviderIntent.mockResolvedValue({
        applied: true,
        providerIntentAt: new Date(),
      });
      mockTransport.createGitApp.mockRejectedValue(new Error('panel indisponible'));
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow({ status: 'FAILED' }));

      await expect(
        service.create(dto({ clientRequestId: CID }), actor),
      ).rejects.toBeInstanceOf(BadGatewayException);

      expect(mockHosting.markProviderIntent).toHaveBeenCalledTimes(1);
      expect(mockHosting.releasePreProvider).not.toHaveBeenCalled(); // jamais après intention
      expect(mockHosting.markBound).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dep1' },
          data: expect.objectContaining({ status: DeploymentStatus.FAILED }),
        }),
      );
    });

    it('ON module B : intention provider AVANT createProject (1ʳʳ mutation distante couverte)', async () => {
      enableC2();
      mockPrisma.subscription.findFirst.mockResolvedValue(
        autoTarget({
          deploymentModule: autoModule({ kind: 'PER_CLIENT_PROJECT', sharedProjectUuid: null }),
        }),
      );
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockPrisma.deployment.create.mockResolvedValue(
        deploymentRow({ status: 'PENDING', coolifyUuid: null }),
      );
      mockHosting.markProviderIntent.mockResolvedValue({
        applied: true,
        providerIntentAt: new Date(),
      });
      mockPrisma.clientProject.findUnique.mockResolvedValue(null);
      mockTransport.createProject.mockRejectedValue(new Error('création projet échouée'));
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow({ status: 'FAILED' }));

      await expect(
        service.create(dto({ clientRequestId: CID }), actor),
      ).rejects.toBeInstanceOf(BadGatewayException);

      expect(mockHosting.markProviderIntent.mock.invocationCallOrder[0]).toBeLessThan(
        mockTransport.createProject.mock.invocationCallOrder[0]!,
      );
      expect(mockHosting.releasePreProvider).not.toHaveBeenCalled(); // intention posée
    });

    it('ON : GET hosting-services actif — service du jeton + compatibilité pack/module', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);

      const res = await service.listHostingServices(actor);

      expect(res.enabled).toBe(true);
      // §5 revue C2 — liste STRICTEMENT limitée au porteur du jeton.
      expect(mockPrisma.hostingService.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: actor.sub } }),
      );
      expect(res.services).toEqual([
        {
          id: 'hs1',
          status: 'ACTIVE',
          packNameSnapshot: 'Starter 1 Go',
          maxAppsSnapshot: null,
          compatible: true,
        },
      ]);
    });

    it('ON : GET hosting-services — service hors pack courant signalé compatible:false', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([
        hostingServiceRow({ packId: 'other-pack', status: 'ACTIVE' }),
      ]);

      const res = await service.listHostingServices(actor);

      expect(res.services[0]).toMatchObject({ id: 'hs1', compatible: false });
    });

    it('ON : ACTIF + même pack mais RATTACHEMENT absent → compatible:false, POST 409 sans repli', async () => {
      enableC2();
      mockPrisma.hostingService.findMany.mockResolvedValue([
        hostingServiceRow({ subscriptionId: null, orderId: null }),
      ]);

      const res = await service.listHostingServices(actor);
      expect(res.services[0]).toMatchObject({ id: 'hs1', status: 'ACTIVE', compatible: false });

      await expect(
        service.create(dto({ clientRequestId: CID }), actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockHosting.reserveSlot).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    // ── 17B.4F — Correctifs ciblés recette C2 × C4 ─────────────────────────
    // (couverture C2 par le protocole C4 : tentative CREATE durable, issue
    //  UNKNOWN sur échec réseau, barrière post-appel, contrat `removed`.)

    const enableC2C4 = () => {
      enableC2();
      process.env.HOSTING_C4_ENABLED = 'true';
    };

    it('C2+C4 : tentative CREATE durable émise AVANT createGitApp, consignée SUCCESS, liaison APRÈS', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();

      const out = await service.create(dto({ clientRequestId: CID, branch: 'main' }), actor);

      expect(out.id).toBe('dep1');
      // 3 dispatches couverts : CREATE (createGitApp) + 2 CONFIGURE (limites, run).
      expect(mockC4.beginDispatchStandalone).toHaveBeenCalledTimes(3);
      expect(mockC4.beginDispatchStandalone.mock.calls.map((c) => (c[0] as { nature: string }).nature)).toEqual([
        'CREATE',
        'CONFIGURE',
        'CONFIGURE',
      ]);
      expect(mockC4.beginDispatchStandalone.mock.calls[0]![0]).toEqual(
        expect.objectContaining({
          nature: 'CREATE',
          scope: { type: 'DEPLOYMENT', id: 'dep1' },
          allocationId: 'alloc1',
          holder: 'u1',
          targetIntent: expect.objectContaining({
            type: 'application',
            branch: 'main',
            buildPack: expect.any(String),
          }),
        }),
      );
      // Ordre dur : tentative DISPATCHED committée AVANT le 1ᵉʳ appel couvert.
      expect(mockC4.beginDispatchStandalone.mock.invocationCallOrder[0]).toBeLessThan(
        mockTransport.createGitApp.mock.invocationCallOrder[0]!,
      );
      expect(mockC4.settleStandalone).toHaveBeenCalledTimes(3);
      expect(mockC4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptId: 'att-c4-1',
          outcome: 'SUCCESS',
          returnedIdentifiers: { uuid: 'app-1' },
          persist: expect.any(Function),
        }),
      );
      // Liaison allocation → déploiement UNIQUEMENT après consignation.
      expect(mockC4.settleStandalone.mock.invocationCallOrder[0]).toBeLessThan(
        mockHosting.markBound.mock.invocationCallOrder[0]!,
      );
      expect(mockHosting.markBound).toHaveBeenCalledTimes(1);
      expect(mockHosting.releasePreProvider).not.toHaveBeenCalled();
    });

    it('C2+C4 : échec réseau pendant createGitApp → consignation UNKNOWN durable, row FAILED, 502, AUCUNE libération', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockPrisma.deployment.create.mockResolvedValue(
        deploymentRow({ status: 'PENDING', coolifyUuid: null }),
      );
      mockHosting.markProviderIntent.mockResolvedValue({
        applied: true,
        providerIntentAt: new Date(),
      });
      mockTransport.createGitApp.mockRejectedValue(new Error('panel indisponible'));
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow({ status: 'FAILED' }));

      await expect(
        service.create(dto({ clientRequestId: CID }), actor),
      ).rejects.toBeInstanceOf(BadGatewayException);

      // Incertitude conservée : UNNE settle UNKNOWN, jamais de SUCCESS.
      expect(mockC4.beginDispatchStandalone).toHaveBeenCalledTimes(1);
      expect(mockC4.settleStandalone).toHaveBeenCalledTimes(1);
      expect(mockC4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: 'att-c4-1', outcome: 'UNKNOWN' }),
      );
      // Contrat : JAMAIS de libération après intention, JAMAIS de liaison.
      expect(mockHosting.releasePreProvider).not.toHaveBeenCalled();
      expect(mockHosting.markBound).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dep1' },
          data: expect.objectContaining({ status: DeploymentStatus.FAILED }),
        }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.failed' }),
      );
    });

    it('C2+C4 : arrêt couvrant au dispatch → refus du begin GELÉ (aucune transition métier), AUCUN appel réseau, slot non libéré', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockPrisma.deployment.create.mockResolvedValue(
        deploymentRow({ status: 'PENDING', coolifyUuid: null }),
      );
      mockHosting.markProviderIntent.mockResolvedValue({
        applied: true,
        providerIntentAt: new Date(),
      });
      // L'arrêt apparaît EXACTEMENT à la frontière du dispatch : le begin est
      // refusé par le protocole, la barrière relue est vraie → GEL.
      let armed = false;
      mockC4.beginDispatchStandalone.mockImplementation(async () => {
        armed = true;
        throw new ConflictException('Arrêt demandé sur cette ressource — dispatch refusé.');
      });
      mockC4.hasStop.mockImplementation(async () => armed);
      // Row PENDING inchangée : le gel n'écrit QUE le détail.
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow({ status: 'PENDING' }));

      const out = await service.create(dto({ clientRequestId: CID }), actor);

      // GEL : réponse retournée, AUCUNE transition métier (jamais FAILED),
      // aucun audit deploy.failed, incertitude non fabriquée (0 settle).
      expect(out.id).toBe('dep1');
      expect(mockC4.settleStandalone).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dep1' },
          data: expect.objectContaining({ detail: expect.stringContaining('figée') }),
        }),
      );
      expect(mockPrisma.deployment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.FAILED }),
        }),
      );
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.failed' }),
      );

      // Barrière ANTI-réseau : le dispatch refusé n'appelle JAMAIS le provider.
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
      expect(mockHosting.releasePreProvider).not.toHaveBeenCalled(); // intention déjà posée
      expect(mockHosting.markBound).not.toHaveBeenCalled();
    });

    it('C2+C4 : arrêt (ou garde OFF) pendant createGitApp → barrière : settle SUCCESS, identifiants conservés, AUCUNE liaison ni activation', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      // L'arrêt apparaît PENDANT l'appel réseau (la barrière PRÉ-dispatch était
      // encore verte au moment du begin).
      let stopArmed = false;
      mockC4.hasStop.mockImplementation(async () => stopArmed);
      mockTransport.createGitApp.mockImplementation(async () => {
        stopArmed = true;
        return { uuid: 'app-1' };
      });

      const out = await service.create(dto({ clientRequestId: CID }), actor);

      // La création est confirmée (SUCCESS consigné) puis TOUT est figé.
      expect(mockC4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'SUCCESS',
          returnedIdentifiers: { uuid: 'app-1' },
        }),
      );
      expect(mockHosting.markBound).not.toHaveBeenCalled(); // pas de liaison
      expect(mockTransport.deployApp).not.toHaveBeenCalled(); // pas d'activation
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dep1' },
          data: expect.objectContaining({ detail: expect.stringContaining('figée') }),
        }),
      );
      expect(out.id).toBe('dep1');
    });

    it('C2+C4 : suppression à release bloquée → `removed:false` honnête (row conservée, quota non libéré)', async () => {
      process.env.HOSTING_C4_ENABLED = 'true';
      mockPrisma.deployment.findFirst.mockResolvedValue({
        ...deploymentRow({ status: 'ACTIVE', appName: 'mon-app' }),
        server: serverRow(),
        clientSubdomain: {
          id: 'cs1',
          subdomain: 'monapp',
          domainId: 'dom1',
          fqdn: 'monapp.example.com',
          recordId: 'rec1',
          deploymentId: 'dep1',
          domain: { id: 'dom1', name: 'example.com', zoneId: 'zone1' },
        },
      });
      mockPrisma.hostingServiceAllocation.findFirst.mockResolvedValue({
        id: 'alloc1',
        status: 'BOUND',
      });
      mockC4.unresolvedCreative.mockResolvedValue(0);
      mockC4r.releaseAfterCleanup.mockResolvedValue({
        status: 'blocked',
        allocationId: 'alloc1',
        blockedReason: 'dns_not_conclusive',
      });
      // Row TOUJOURS présente après tentative de release bloquée.
      mockPrisma.deployment.findUnique.mockResolvedValue({ id: 'dep1' });

      const out = await service.remove('dep1', actor);

      expect(out).toEqual({
        removed: false, // D9 honnête : la row existe encore
        appName: 'mon-app',
        partial: true,
        freedQuota: false,
        c4: { release: expect.objectContaining({ status: 'blocked' }) },
      });
      expect(mockTx.deployment.delete).not.toHaveBeenCalled(); // AUCUNE écriture locale
      expect(mockTx.clientSubdomain.deleteMany).not.toHaveBeenCalled();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deploy.delete',
          details: expect.objectContaining({ removed: false, partial: true }),
        }),
      );
    });

    it('C2+C4 : row NON liée (échec avant markBound) → repli garde via tentative DEPLOYMENT → 409, aucune mutation', async () => {
      process.env.HOSTING_C4_ENABLED = 'true';
      mockPrisma.deployment.findFirst.mockResolvedValue({
        ...deploymentRow({ status: 'FAILED', appName: 'mon-app' }),
        server: serverRow(),
        clientSubdomain: null,
      });
      // Échec de création : `markBound` n'a JAMAIS lié la row (deploymentId null).
      mockPrisma.hostingServiceAllocation.findFirst.mockResolvedValue(null);
      mockPrisma.c4ProviderAttempt.findFirst.mockResolvedValue({ allocationId: 'alloc1' });
      mockC4.unresolvedCreative.mockResolvedValue(1);

      await expect(service.remove('dep1', actor)).rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.c4ProviderAttempt.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ scopeType: 'DEPLOYMENT', scopeId: 'dep1' }),
        }),
      );
      expect(mockC4.unresolvedCreative).toHaveBeenCalledWith('alloc1');
      expect(mockAudit.record).not.toHaveBeenCalled();
      expect(mockTx.deployment.delete).not.toHaveBeenCalled();
    });

    // ── 17B.4F-C4 — couverture C2→C4 (projet dédié + ops de configuration) ──
    // Tests déterministes : transports simulés, barrières contrôlées par
    // drapeau (aucune temporisation), compteurs d'appels explicites.

    it('C2+C4 module B : tentative CREATE AVANT createProject, SUCCESS + identifiants persistés DANS la settle', async () => {
      enableC2C4();
      mockPrisma.subscription.findFirst.mockResolvedValue(
        autoTarget({
          deploymentModule: autoModule({ kind: 'PER_CLIENT_PROJECT', sharedProjectUuid: null }),
        }),
      );
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      mockPrisma.clientProject.findUnique.mockResolvedValue(null); // 1ʳᵉ app du client
      mockTransport.createProject.mockResolvedValue({ uuid: 'proj-1', name: 'client-u1' });

      const out = await service.create(dto({ clientRequestId: CID }), actor);

      expect(out.id).toBe('dep1');
      // 4 dispatches : CREATE projet + CREATE app + 2 CONFIGURE (limites, run).
      expect(mockC4.beginDispatchStandalone).toHaveBeenCalledTimes(4);
      expect(mockC4.beginDispatchStandalone.mock.calls[0]![0]).toEqual(
        expect.objectContaining({
          nature: 'CREATE',
          scope: { type: 'DEPLOYMENT', id: 'dep1' },
          targetIntent: expect.objectContaining({ type: 'project', name: 'client-u1' }),
        }),
      );
      // Ordres durs : intention → tentative projet → réseau projet → réseau app.
      expect(mockHosting.markProviderIntent.mock.invocationCallOrder[0]).toBeLessThan(
        mockTransport.createProject.mock.invocationCallOrder[0]!,
      );
      expect(mockC4.beginDispatchStandalone.mock.invocationCallOrder[0]).toBeLessThan(
        mockTransport.createProject.mock.invocationCallOrder[0]!,
      );
      expect(mockTransport.createProject.mock.invocationCallOrder[0]).toBeLessThan(
        mockTransport.createGitApp.mock.invocationCallOrder[0]!,
      );
      // Consignation SUCCESS + persist ATOMIQUE (row projet + deployment).
      expect(mockC4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'SUCCESS',
          returnedIdentifiers: { projectUuid: 'proj-1' },
          persist: expect.any(Function),
        }),
      );
      expect(mockTx.clientProject.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'u1',
          serverId: 'srv-coolify',
          projectUuid: 'proj-1',
        }),
      });
      expect(mockTx.deployment.update).toHaveBeenCalledWith({
        where: { id: 'dep1' },
        data: expect.objectContaining({ coolifyProjectUuid: 'proj-1', clientProjectId: 'cp-1' }),
      });
      // Chemin historique (getOrCreateClientProject) JAMAIS emprunté sous ON.
      expect(mockPrisma.clientProject.create).not.toHaveBeenCalled();
      // Flow nominal : liaison, run, DEPLOYING.
      expect(mockHosting.markBound).toHaveBeenCalledTimes(1);
      expect(mockTransport.deployApp).toHaveBeenCalledTimes(1);
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.DEPLOYING }),
        }),
      );
      expect(mockHosting.releasePreProvider).not.toHaveBeenCalled();
    });

    it('C2+C4 module B : cible unique du projet — serverUuid = coolifyServerUuid dans la tentative ET l’appel (jamais coolifyProjectUuid)', async () => {
      enableC2C4();
      // Les DEUX uuids du serveur sont VOLONTAIREMENT différents pour prouver
      // que la cible n'est jamais confondue.
      const server = {
        ...serverRow(),
        coolifyServerUuid: 'uuid-serveur-A',
        coolifyProjectUuid: 'uuid-projet-B',
      };
      mockPrisma.subscription.findFirst.mockResolvedValue(
        autoTarget({
          deploymentModule: autoModule({
            kind: 'PER_CLIENT_PROJECT',
            sharedProjectUuid: null,
            server,
          }),
        }),
      );
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow({ server })]);
      happyProvider();
      mockPrisma.clientProject.findUnique.mockResolvedValue(null);
      mockTransport.createProject.mockResolvedValue({ uuid: 'proj-1', name: 'client-u1' });

      const out = await service.create(dto({ clientRequestId: CID }), actor);
      expect(out.id).toBe('dep1');

      // Appel provider : cible = UUID du SERVEUR (A), jamais le projet (B).
      const callArgs = mockTransport.createProject.mock.calls[0]![1] as { serverUuid?: string };
      expect(callArgs.serverUuid).toBe('uuid-serveur-A');
      expect(callArgs.serverUuid).not.toBe('uuid-projet-B');
      // Tentative : la MÊME valeur exacte que celle de l'appel.
      const intent = (mockC4.beginDispatchStandalone.mock.calls[0]![0] as {
        targetIntent: { serverUuid?: string };
      }).targetIntent;
      expect(intent.serverUuid).toBe('uuid-serveur-A');
      expect(intent.serverUuid).toBe(callArgs.serverUuid);
    });

    it('C2+C4 module B : échec réseau createProject → settle UNKNOWN durable, 502, AUCUN createGitApp ni libération', async () => {
      enableC2C4();
      mockPrisma.subscription.findFirst.mockResolvedValue(
        autoTarget({
          deploymentModule: autoModule({ kind: 'PER_CLIENT_PROJECT', sharedProjectUuid: null }),
        }),
      );
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      mockPrisma.deployment.create.mockResolvedValue(
        deploymentRow({ status: 'PENDING', coolifyUuid: null }),
      );
      mockHosting.markProviderIntent.mockResolvedValue({
        applied: true,
        providerIntentAt: new Date(),
      });
      mockPrisma.clientProject.findUnique.mockResolvedValue(null);
      mockTransport.createProject.mockRejectedValue(new Error('création projet échouée (timeout)'));
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow({ status: 'FAILED' }));

      await expect(service.create(dto({ clientRequestId: CID }), actor)).rejects.toBeInstanceOf(
        BadGatewayException,
      );

      // Tentative CREATE projet consignée UNKNOWN : créateur non résolu durable.
      expect(mockC4.beginDispatchStandalone).toHaveBeenCalledTimes(1);
      expect(mockC4.beginDispatchStandalone.mock.calls[0]![0]).toEqual(
        expect.objectContaining({
          nature: 'CREATE',
          targetIntent: expect.objectContaining({ type: 'project' }),
        }),
      );
      expect(mockC4.settleStandalone).toHaveBeenCalledTimes(1);
      expect(mockC4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: 'att-c4-1', outcome: 'UNKNOWN' }),
      );
      // HALT : AUCUN appel suivant (createGitApp), AUCUN rejeu, AUCUNE liaison.
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
      expect(mockHosting.markBound).not.toHaveBeenCalled();
      expect(mockHosting.releasePreProvider).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.FAILED }),
        }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.failed' }),
      );
    });

    it('C2+C4 module B : garde OFF tombée pendant createProject → SUCCESS persisté puis GEL, AUCUN appel suivant', async () => {
      enableC2C4();
      mockPrisma.subscription.findFirst.mockResolvedValue(
        autoTarget({
          deploymentModule: autoModule({ kind: 'PER_CLIENT_PROJECT', sharedProjectUuid: null }),
        }),
      );
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      mockPrisma.clientProject.findUnique.mockResolvedValue(null);
      mockTransport.createProject.mockImplementation(async () => {
        delete process.env.HOSTING_C4_ENABLED; // garde passée OFF PENDANT l'appel
        return { uuid: 'proj-1', name: 'client-u1' };
      });

      const out = await service.create(dto({ clientRequestId: CID }), actor);

      expect(out.id).toBe('dep1');
      // Identifiant reçu CONSERVÉ : consignation SUCCESS + persist exécuté
      // dans LA MÊME tx de settle (mockTx), avant toute barrière.
      expect(mockC4.settleStandalone).toHaveBeenCalledTimes(1);
      expect(mockC4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'SUCCESS',
          returnedIdentifiers: { projectUuid: 'proj-1' },
          persist: expect.any(Function),
        }),
      );
      expect(mockTx.clientProject.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ projectUuid: 'proj-1' }),
      });
      expect(mockTx.deployment.update).toHaveBeenCalledWith({
        where: { id: 'dep1' },
        data: expect.objectContaining({ coolifyProjectUuid: 'proj-1', clientProjectId: 'cp-1' }),
      });
      // GEL : zéro appel réseau suivant, zéro liaison, zéro transition de statut.
      expect(mockC4.beginDispatchStandalone).toHaveBeenCalledTimes(1); // seul le projet
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
      expect(mockTransport.deployApp).not.toHaveBeenCalled();
      expect(mockHosting.markBound).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dep1' },
          data: expect.objectContaining({ detail: expect.stringContaining('figée') }),
        }),
      );
      expect(mockPrisma.deployment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.DEPLOYING }),
        }),
      );
      expect(mockHosting.releasePreProvider).not.toHaveBeenCalled();
    });

    it('C2+C4 : arrêt posé entre deux ops config → 0 dispatch suivant, aucun statut DEPLOYING', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      let stopArmed = false;
      mockC4.hasStop.mockImplementation(async () => stopArmed);
      mockTransport.applyAppLimits.mockImplementation(async () => {
        stopArmed = true; // arrêt posé PENDANT l'opération limites
        return undefined;
      });

      const out = await service.create(
        dto({ clientRequestId: CID, environment: { FOO: 'bar' } }),
        actor,
      );

      expect(out.id).toBe('dep1');
      // 3 dispatches : CREATE app + CONFIGURE env + CONFIGURE limites (PAS de run).
      expect(mockC4.beginDispatchStandalone).toHaveBeenCalledTimes(3);
      expect(
        mockC4.beginDispatchStandalone.mock.calls.slice(1).map((c) => ({
          nature: (c[0] as { nature: string }).nature,
          op: (c[0] as { targetIntent: { op?: string } }).targetIntent.op,
        })),
      ).toEqual([
        { nature: 'CONFIGURE', op: 'set_app_environment' },
        { nature: 'CONFIGURE', op: 'apply_app_limits' },
      ]);
      // Aucun dispatch ET aucun appel après l'arrêt (run sauté, gel posé).
      expect(mockTransport.deployApp).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.DEPLOYING }),
        }),
      );
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ detail: expect.stringContaining('figée') }),
        }),
      );
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.create' }),
      );
      // La liaison (antérieure à l'arrêt) est conservée — pas de retrait rétroactif.
      expect(mockHosting.markBound).toHaveBeenCalledTimes(1);
    });

    it("C2+C4 : arrêt pendant l'allocation DNS → recordId/fqdn/racine conservés DANS la settle (row CS atomique), gel", async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      mockCloudflare.findActiveRootDomain.mockResolvedValue({
        id: 'dom1',
        name: 'example.com',
        zoneId: 'zone1',
        cnameTarget: null,
        status: 'ACTIVE',
      });
      let stopArmed = false;
      mockC4.hasStop.mockImplementation(async () => stopArmed);
      mockCloudflare.allocateClientSubdomain.mockImplementation(async () => {
        stopArmed = true; // arrêt posé PENDANT l'appel réseau DNS
        return {
          subdomain: 'monapp',
          fqdn: 'monapp.example.com',
          recordId: 'rec-9',
          domainId: 'dom1',
        };
      });

      const out = await service.create(dto({ clientRequestId: CID }), actor);

      expect(out.id).toBe('dep1');
      // Mode différé exigé sous ON : AUCUNE row écrite par CloudflareService ;
      // la barrière READ→CREATE est DÉLÉGUÉE au helper (callback vivant).
      expect(mockCloudflare.allocateClientSubdomain).toHaveBeenCalledWith(
        expect.objectContaining({ deploymentId: 'dep1' }),
        { deferRow: true, barrier: expect.any(Function) },
      );
      // Identifiants de tentative (dont recordId) consignés + persist ATOMIQUE
      // dans LE MÊME appel de settle : row ClientSubdomain + champs deployment.
      expect(mockC4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'SUCCESS',
          returnedIdentifiers: {
            subdomain: 'monapp',
            fqdn: 'monapp.example.com',
            domainId: 'dom1',
            recordId: 'rec-9',
          },
          persist: expect.any(Function),
        }),
      );
      expect(mockTx.clientSubdomain.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          subdomain: 'monapp',
          fqdn: 'monapp.example.com',
          domainId: 'dom1',
          recordId: 'rec-9',
          deploymentId: 'dep1',
          status: 'CREATED',
        }),
      });
      expect(mockTx.deployment.update).toHaveBeenCalledWith({
        where: { id: 'dep1' },
        data: expect.objectContaining({
          subdomain: 'monapp',
          fqdn: 'monapp.example.com',
          domainId: 'dom1',
        }),
      });
      // GEL : aucune poursuite (domaine app + run), aucun statut DEPLOYING,
      // pas d'audit deploy.domain (la consignation en tient lieu sous ON).
      expect(mockTransport.setAppDomain).not.toHaveBeenCalled();
      expect(mockTransport.deployApp).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.domain' }),
      );
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.create' }),
      );
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ detail: expect.stringContaining('figée') }),
        }),
      );
      expect(mockPrisma.deployment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.DEPLOYING }),
        }),
      );
    });

    it('C2+C4 : refus de beginDispatch (arrêt) sur op config → GEL, états inchangés, 0 appel réseau suivant', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      // L'arrêt apparaît à la frontière du dispatch CONFIGURE : begin refusé,
      // barrière relue VRAIE → GEL (jamais de FAILED par le catch général).
      let armed = false;
      mockC4.beginDispatchStandalone.mockImplementation((params: { nature: string }) => {
        if (params.nature === 'CREATE') {
          return Promise.resolve({ attemptId: 'att-c4-1', targetIntentHash: 'hash-c4-1' });
        }
        armed = true;
        return Promise.reject(
          new ConflictException('Arrêt demandé sur cette ressource — dispatch refusé.'),
        );
      });
      mockC4.hasStop.mockImplementation(async () => armed);

      const out = await service.create(dto({ clientRequestId: CID, environment: { FOO: 'bar' } }), actor);

      // États inchangés : réponse retournée, statut NON transformé, aucun
      // audit de transition métier, aucune libération.
      expect(out.id).toBe('dep1');
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dep1' },
          data: expect.objectContaining({ detail: expect.stringContaining('figée') }),
        }),
      );
      expect(mockPrisma.deployment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.FAILED }),
        }),
      );
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.failed' }),
      );

      // Aucun appel réseau après le refus + aucun absorbé par un catch best-effort.
      expect(mockTransport.setAppEnvironment).not.toHaveBeenCalled();
      expect(mockTransport.applyAppLimits).not.toHaveBeenCalled();
      expect(mockTransport.deployApp).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.env.warn' }),
      );
      expect(mockC4.beginDispatchStandalone).toHaveBeenCalledTimes(2); // CREATE + CONFIGURE refusé
      expect(mockC4.settleStandalone).toHaveBeenCalledTimes(1); // SUCCESS de createGitApp seulement
      expect(mockHosting.releasePreProvider).not.toHaveBeenCalled();
    });

    it('C2+C4 : refus de beginDispatch SANS arrêt (créateur non résolu) → toujours propagé (502 + FAILED, jamais absorbé)', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      mockC4.beginDispatchStandalone.mockImplementation((params: { nature: string }) =>
        params.nature === 'CREATE'
          ? Promise.resolve({ attemptId: 'att-c4-1', targetIntentHash: 'hash-c4-1' })
          : Promise.reject(
              new ConflictException(
                'Créateur non résolu sur cette allocation — dispatch refusé (incertitude conservée).',
              ),
            ),
      );
      // hasStop reste FALSE : conflit réel, pas un arrêt → échec classique.
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow({ status: 'FAILED' }));

      const err = await service
        .create(dto({ clientRequestId: CID, environment: { FOO: 'bar' } }), actor)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(BadGatewayException);
      expect((err as Error).message).toContain('Créateur non résolu');
      expect(mockTransport.setAppEnvironment).not.toHaveBeenCalled();
      expect(mockTransport.deployApp).not.toHaveBeenCalled();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.failed' }),
      );
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.FAILED }),
        }),
      );
      expect(mockHosting.releasePreProvider).not.toHaveBeenCalled();
    });

    it('C2+C4 : appel échoue APRÈS bascule OFF → incertitude UNKNOWN consignée, AUCUNE transition métier', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      // La garde C4 passe OFF PENDANT l'appel limites, puis l'appel échoue.
      mockTransport.applyAppLimits.mockImplementation(async () => {
        delete process.env.HOSTING_C4_ENABLED;
        throw new Error('panel timeout après bascule OFF');
      });

      const out = await service.create(dto({ clientRequestId: CID }), actor);

      // Consignation : UNKNOWN durable sur la tentative CONFIGURE (incertitude
      // conservée), même si la suite est gelée.
      expect(mockC4.settleStandalone).toHaveBeenCalledTimes(2); // CREATE SUCCESS + CONFIGURE UNKNOWN
      expect(mockC4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: 'att-c4-1', outcome: 'UNKNOWN' }),
      );
      // AUCUNE transition métier : pas de FAILED, pas d'audit deploy.failed,
      // pas de poursuite (DNS/run), pas de libération.
      expect(out.id).toBe('dep1');
      expect(mockPrisma.deployment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.FAILED }),
        }),
      );
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.failed' }),
      );
      expect(mockTransport.deployApp).not.toHaveBeenCalled();
      expect(mockCloudflare.allocateClientSubdomain).not.toHaveBeenCalled();
      expect(mockHosting.releasePreProvider).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ detail: expect.stringContaining('figée') }),
        }),
      );
    });

    it('C2+C4 : arrêt pendant la LECTURE listServers → aucune création suivante (0 tentative, 0 appel réseau), gel', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      let armed = false;
      mockC4.hasStop.mockImplementation(async () => armed);
      // La lecture réseau pose l'ARRÊT pendant qu'elle s'exécute.
      mockTransport.listServers.mockImplementation(async () => {
        armed = true;
        return [{ uuid: 'srv-panel-1', ip: 'portal.exemple.com' }];
      });

      const out = await service.create(dto({ clientRequestId: CID }), actor);

      // Barrière READ → CREATE : aucun dispatch CREATE émis, aucune création.
      expect(mockC4.beginDispatchStandalone).not.toHaveBeenCalled();
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
      expect(mockTransport.deployApp).not.toHaveBeenCalled();
      expect(mockHosting.markBound).not.toHaveBeenCalled();
      expect(mockC4.settleStandalone).not.toHaveBeenCalled();
      expect(mockHosting.releasePreProvider).not.toHaveBeenCalled();
      // Gel : vue retournée, statut inchangé, aucun deploy.failed.
      expect(out.id).toBe('dep1');
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dep1' },
          data: expect.objectContaining({ detail: expect.stringContaining('figée') }),
        }),
      );
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.failed' }),
      );
    });

    it('C2+C4 : échec réseau ambiguë sur op config → settle UNKNOWN durable + HALT, aucun dispatch suivant, aucune libération', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      mockTransport.applyAppLimits.mockRejectedValue(new Error('panel timeout (5xx ambigu)'));

      const err = await service.create(dto({ clientRequestId: CID }), actor).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BadGatewayException);
      expect((err as Error).message).toContain('panel timeout');

      // Tentative CONFIGURE consignée UNKNOWN (jamais FAILED_RETRYABLE) :
      // sans preuve d'échec définitif, l'incertitude est conservée.
      expect(mockC4.beginDispatchStandalone).toHaveBeenCalledTimes(2); // CREATE + CONFIGURE
      expect(mockC4.settleStandalone).toHaveBeenCalledTimes(2);
      expect(mockC4.settleStandalone).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: 'att-c4-1', outcome: 'UNKNOWN' }),
      );
      expect(mockC4.settleStandalone).not.toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'FAILED_RETRYABLE' }),
      );
      // HALT : AUCUN dispatch suivant (DNS/run), aucun best-effort silencieux.
      expect(mockTransport.deployApp).not.toHaveBeenCalled();
      expect(mockCloudflare.allocateClientSubdomain).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.limits' }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.failed' }),
      );
      // Post-intention : JAMAIS de libération (un retour tardif pourrait
      // contredire un nettoyage) — le créateur non résolu bloque aussi remove.
      expect(mockHosting.releasePreProvider).not.toHaveBeenCalled();
      expect(mockHosting.markBound).toHaveBeenCalledTimes(1); // liaison antérieure à l'échec
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.FAILED }),
        }),
      );
    });

    it('C2+C4 : parcours nominal complet couvert puis suppression nettoyée — preuve unique + quota libéré', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      mockCloudflare.findActiveRootDomain.mockResolvedValue({
        id: 'dom1',
        name: 'example.com',
        zoneId: 'zone1',
        cnameTarget: null,
        status: 'ACTIVE',
      });
      mockCloudflare.allocateClientSubdomain.mockResolvedValue({
        subdomain: 'monapp',
        fqdn: 'monapp.example.com',
        recordId: 'rec-9',
        domainId: 'dom1',
      });

      const out = await service.create(dto({ clientRequestId: CID }), actor);

      expect(out.id).toBe('dep1');
      // 5 dispatches couverts (app, limites, DNS, domaine app, run), tous SUCCESS.
      expect(mockC4.beginDispatchStandalone).toHaveBeenCalledTimes(5);
      expect(mockC4.settleStandalone).toHaveBeenCalledTimes(5);
      expect(
        mockC4.settleStandalone.mock.calls.every(
          (c) => (c[0] as { outcome: string }).outcome === 'SUCCESS',
        ),
      ).toBe(true);
      expect(mockTransport.createGitApp).toHaveBeenCalledTimes(1);
      expect(mockTransport.setAppDomain).toHaveBeenCalledWith(
        expect.anything(),
        'app-1',
        'monapp.example.com',
      );
      expect(mockTransport.deployApp).toHaveBeenCalledTimes(1);
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.DEPLOYING }),
        }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.create' }),
      );
      expect(mockHosting.markBound).toHaveBeenCalledTimes(1);

      // ── Suppression : garde verte (0 créateur non résolu) → preuve unique ──
      mockPrisma.deployment.findFirst.mockResolvedValue({
        ...deploymentRow({ status: 'ACTIVE', appName: 'mon-app' }),
        server: serverRow(),
        clientSubdomain: {
          id: 'cs1',
          subdomain: 'monapp',
          domainId: 'dom1',
          fqdn: 'monapp.example.com',
          recordId: 'rec-9',
          deploymentId: 'dep1',
          domain: { id: 'dom1', name: 'example.com', zoneId: 'zone1' },
        },
      });
      mockPrisma.hostingServiceAllocation.findFirst.mockResolvedValue({
        id: 'alloc1',
        status: 'BOUND',
      });
      mockPrisma.hostingServiceAllocation.findUnique.mockResolvedValue({ status: 'RELEASED' });

      const removed = await service.remove('dep1', actor);

      expect(removed).toEqual({
        removed: true,
        appName: 'mon-app',
        partial: false,
        freedQuota: true,
        c4: { release: expect.objectContaining({ status: 'released' }) },
      });
      // UNE SEULE preuve de libération ; liaison localisée via l'allocation
      // (jamais le repli sur tentative) ; le nettoyage local est DÉLÉGUÉ à la
      // T-release (paramètre cleanup committé dans SA transaction, simulée ici).
      expect(mockC4r.releaseAfterCleanup).toHaveBeenCalledTimes(1);
      expect(mockC4r.releaseAfterCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          allocationId: 'alloc1',
          app: 'deleted',
          dns: 'deleted',
          cleanup: expect.objectContaining({
            deploymentId: 'dep1',
            removeClientSubdomain: true,
            actorUserId: 'u1',
          }),
        }),
      );
      expect(mockPrisma.c4ProviderAttempt.findFirst).not.toHaveBeenCalled();
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'deploy.delete',
          details: expect.objectContaining({ removed: true, partial: false, freedQuota: true }),
        }),
      );
      expect(mockC4.unresolvedCreative).toHaveBeenCalledWith('alloc1');
    });

    it('C2 ON + C4 OFF : appel direct best-effort, ZÉRO tentative/barrière, contrat historique préservé', async () => {
      enableC2(); // C4 OFF par défaut
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();

      const out = await service.create(
        dto({ clientRequestId: CID, environment: { FOO: 'bar' } }),
        actor,
      );

      expect(out.id).toBe('dep1');
      expect(mockC4.beginDispatchStandalone).not.toHaveBeenCalled();
      expect(mockC4.settleStandalone).not.toHaveBeenCalled();
      expect(mockC4.hasStop).not.toHaveBeenCalled();
      expect(mockTransport.setAppEnvironment).toHaveBeenCalledWith(
        expect.anything(),
        'app-1',
        { FOO: 'bar' },
      );
      expect(mockTransport.applyAppLimits).toHaveBeenCalledTimes(1);
      expect(mockTransport.deployApp).toHaveBeenCalledTimes(1);
      expect(mockHosting.markBound).toHaveBeenCalledTimes(1); // C2 inchangé
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.DEPLOYING }),
        }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.create' }),
      );
    });

    it('C2+C4 : réponse createGitApp OK + arrêt, PUIS échec du persist (TX annulée) → GEL honnête, tentative DISPATCHED, 0 transition', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      let stopArmed = false;
      mockC4.hasStop.mockImplementation(async () => stopArmed);
      mockTransport.createGitApp.mockImplementation(async () => {
        stopArmed = true; // arrêt posé pendant la réponse provider (réussie)
        return { uuid: 'app-1' };
      });
      // Échec injecté DANS le persist de la settle SUCCESS → rollback conjoint.
      mockTx.deployment.update.mockRejectedValueOnce(new Error('TX settle annulée (persist)'));

      const out = await service.create(dto({ clientRequestId: CID }), actor);

      // GEL honnête : détail = consignation ANNULÉE (jamais « identifiants
      // conservés » quand la TX a été annulée).
      expect(out.id).toBe('dep1');
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dep1' },
          data: { detail: expect.stringContaining('identifiants NON enregistrés') },
        }),
      );
      // Statut métier inchangé : AUCUNE écriture FAILED, AUCUN deploy.failed.
      expect(mockPrisma.deployment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.FAILED }),
        }),
      );
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.failed' }),
      );
      // Rollback : l'identifiant provider n'est JAMAIS écrit hors TX annulée.
      expect(mockPrisma.deployment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ coolifyUuid: expect.anything() }),
        }),
      );
      // Aucun appel suivant (aucune liaison, config, domaine ni run).
      expect(mockHosting.markBound).not.toHaveBeenCalled();
      expect(mockTransport.setAppEnvironment).not.toHaveBeenCalled();
      expect(mockTransport.applyAppLimits).not.toHaveBeenCalled();
      expect(mockTransport.setAppDomain).not.toHaveBeenCalled();
      expect(mockTransport.deployApp).not.toHaveBeenCalled();
      expect(mockCloudflare.allocateClientSubdomain).not.toHaveBeenCalled();
      // Tentative BLOQUANTE conservée : UNE settle (échec), jamais re-settlée
      // ni effacée (pas de REFUSED).
      expect(mockC4.settleStandalone).toHaveBeenCalledTimes(1);
      expect(mockC4.settleStandalone).not.toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'REFUSED' }),
      );
      // Échec de consignation SIGNALÉ explicitement (log ERROR, après stop).
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Consignation SUCCESS échouée après stop/OFF (createGitApp)'),
      );
      logSpy.mockRestore();
    });

    it('C2+C4 : réponse DNS OK + arrêt, PUIS échec du persist (TX annulée) → GEL sans transition, CONFIGURE DISPATCHED', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      mockCloudflare.findActiveRootDomain.mockResolvedValue({
        id: 'dom1',
        name: 'example.com',
        zoneId: 'zone1',
        cnameTarget: null,
        status: 'ACTIVE',
      });
      let stopArmed = false;
      mockC4.hasStop.mockImplementation(async () => stopArmed);
      mockCloudflare.allocateClientSubdomain.mockImplementation(async () => {
        stopArmed = true; // arrêt posé pendant l'appel DNS (réponse réussie)
        return {
          subdomain: 'monapp',
          fqdn: 'monapp.example.com',
          recordId: 'rec-9',
          domainId: 'dom1',
        };
      });
      // Échec injecté DANS le persist (création row ClientSubdomain) → rollback.
      mockTx.clientSubdomain.create.mockRejectedValueOnce(
        new Error('TX settle annulée (persist DNS)'),
      );

      const out = await service.create(dto({ clientRequestId: CID }), actor);

      expect(out.id).toBe('dep1');
      // Détail honnête : les identifiants DNS reçus ne sont JAMAIS annoncés
      // persistés quand la TX est annulée.
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { detail: expect.stringContaining('identifiants NON enregistrés') },
        }),
      );
      expect(mockPrisma.deployment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.FAILED }),
        }),
      );
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.failed' }),
      );
      // Aucun appel suivant (domaine app, run) ni audit dérivé.
      expect(mockTransport.setAppDomain).not.toHaveBeenCalled();
      expect(mockTransport.deployApp).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.domain' }),
      );
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.create' }),
      );
      // Identifiants DNS jamais écrits hors TX annulée.
      expect(mockPrisma.deployment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ fqdn: 'monapp.example.com' }),
        }),
      );
      // 3 settles : CREATE app SUCCESS + limites SUCCESS + allocate_dns
      // (SUCCESS dont le persist a échoué = tentative laissée DISPATCHED).
      expect(mockC4.settleStandalone).toHaveBeenCalledTimes(3);
      expect(mockC4.settleStandalone).not.toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'REFUSED' }),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Consignation SUCCESS échouée après stop/OFF (allocate_dns)'),
      );
      logSpy.mockRestore();
    });

    it('C2+C4 module B : réponse createProject OK + arrêt, PUIS échec du persist (divergence TX) → GEL honnête, 0 création suivante', async () => {
      enableC2C4();
      mockPrisma.subscription.findFirst.mockResolvedValue(
        autoTarget({
          deploymentModule: autoModule({ kind: 'PER_CLIENT_PROJECT', sharedProjectUuid: null }),
        }),
      );
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      mockPrisma.clientProject.findUnique.mockResolvedValue(null);
      let stopArmed = false;
      mockC4.hasStop.mockImplementation(async () => stopArmed);
      mockTransport.createProject.mockImplementation(async () => {
        stopArmed = true; // arrêt posé pendant la réponse provider (réussie)
        return { uuid: 'proj-1', name: 'client-u1' };
      });
      // Échec injecté DANS le persist : projet concurrent DIVERGENT →
      // ConflictException réelle du code = rollback CONJOINT de la settle.
      mockTx.clientProject.findUnique.mockResolvedValue({
        id: 'cp-x',
        projectUuid: 'proj-AUTRE',
        userId: 'u1',
        serverId: 'srv-coolify',
      });

      const out = await service.create(dto({ clientRequestId: CID }), actor);

      expect(out.id).toBe('dep1');
      // GEL honnête : consignation ANNULÉE, aucun identifiant prétendu.
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { detail: expect.stringContaining('identifiants NON enregistrés') },
        }),
      );
      expect(mockPrisma.deployment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.FAILED }),
        }),
      );
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.failed' }),
      );
      // Rollback : AUCUNE écriture projet/identifiants hors TX annulée.
      expect(mockTx.clientProject.create).not.toHaveBeenCalled();
      expect(mockPrisma.clientProject.create).not.toHaveBeenCalled();
      expect(mockPrisma.deployment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ coolifyProjectUuid: expect.anything() }),
        }),
      );
      // Gel AVANT toute création suivante : 0 tentative app, 0 réseau app.
      expect(mockC4.beginDispatchStandalone).toHaveBeenCalledTimes(1); // CREATE projet
      expect(mockTransport.listServers).not.toHaveBeenCalled();
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
      expect(mockHosting.markBound).not.toHaveBeenCalled();
      expect(mockTransport.deployApp).not.toHaveBeenCalled();
      // Tentative projet laissée DISPATCHED (bloquante), jamais re-settlée.
      expect(mockC4.settleStandalone).toHaveBeenCalledTimes(1);
      expect(mockC4.settleStandalone).not.toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'REFUSED' }),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Consignation SUCCESS échouée après stop/OFF (createProject)'),
      );
      logSpy.mockRestore();
    });

    it('C2+C4 : échec persist SANS arrêt/OFF → toujours propagé (502 + FAILED + deploy.failed), tentative DISPATCHED', async () => {
      enableC2C4();
      mockPrisma.hostingService.findMany.mockResolvedValue([hostingServiceRow()]);
      happyProvider();
      const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      // hasStop reste FALSE : pas d'arrêt → contrat ON inchangé (HALT).
      mockTx.deployment.update.mockRejectedValueOnce(new Error('TX settle annulée (persist)'));

      const err = await service.create(dto({ clientRequestId: CID }), actor).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BadGatewayException);
      expect((err as Error).message).toContain('TX settle annulée');
      expect(mockPrisma.deployment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: DeploymentStatus.FAILED }),
        }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.failed' }),
      );
      // Tentative toujours DISPATCHED (bloquante pour le retry 409) : UNE
      // settle tentée, jamais re-settlée ; pas de gel, pas de log « après stop ».
      expect(mockC4.settleStandalone).toHaveBeenCalledTimes(1);
      expect(mockC4.settleStandalone).not.toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'REFUSED' }),
      );
      expect(mockHosting.markBound).not.toHaveBeenCalled();
      expect(mockTransport.deployApp).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });
});

// Phase 17A — tests déterministes du mapping brut Coolify → statut plateforme.
// Chaque case listée par la sous-phase est couverte : jamais de faux ACTIVE
// (notamment `exited` seul ou avec santé), `running`* → ACTIVE, transitions
// start/déploiement → DEPLOYING, terminaisons anormales → FAILED, et inconnu
// → null (l'appelant conserve l'état courant).
describe('mapCoolifyStatus (Phase 17A — mapping déterministe)', () => {
  it.each([
    ['running', DeploymentStatus.ACTIVE],
    ['running:healthy', DeploymentStatus.ACTIVE],
    ['running:unknown', DeploymentStatus.ACTIVE],
    ['running:unhealthy', DeploymentStatus.ACTIVE],
    ['finished', DeploymentStatus.ACTIVE],
    ['success', DeploymentStatus.ACTIVE],
    ['successful', DeploymentStatus.ACTIVE],
    ['deployed', DeploymentStatus.ACTIVE],
    // Phase 17A : un conteneur arrêté ne sert JAMAIS l'app (ni ACTIVE, ni
    // FAILED prématuré pendant une transition `exited` → `running`).
    ['exited', null],
    ['exited:unhealthy', null],
    ['exited:healthy', null],
    ['exited:unknown', null],
    ['EXITED:UNHEALTHY', null],
    ['queued', DeploymentStatus.DEPLOYING],
    ['in_progress', DeploymentStatus.DEPLOYING],
    ['starting', DeploymentStatus.DEPLOYING],
    ['building', DeploymentStatus.DEPLOYING],
    ['deploying', DeploymentStatus.DEPLOYING],
    ['processing', DeploymentStatus.DEPLOYING],
    ['pending', DeploymentStatus.DEPLOYING],
    ['building:healthy', DeploymentStatus.DEPLOYING],
    ['failed', DeploymentStatus.FAILED],
    ['error', DeploymentStatus.FAILED],
    ['cancelled', DeploymentStatus.FAILED],
    ['canceled', DeploymentStatus.FAILED],
    ['crash', DeploymentStatus.FAILED],
    ['running:crash', DeploymentStatus.FAILED],
    ['unknown', null],
    ['', null],
    ['   running  ', DeploymentStatus.ACTIVE],
  ])('%p → %p', (raw, expected) => {
    expect(mapCoolifyStatus(raw)).toBe(expected);
  });
});
