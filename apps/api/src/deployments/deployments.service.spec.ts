import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DeploymentsService } from './deployments.service';

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
    deployment: { create: jest.fn(), count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    cloudflareSetting: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    domain: { findFirst: jest.fn(), findUnique: jest.fn() },
    clientSubdomain: { findFirst: jest.fn(), create: jest.fn() },
  };
  const mockAudit = { record: jest.fn() };
  const mockSettings = { isDeployEnabled: jest.fn() };
  const mockCrypto = { encrypt: jest.fn(), decrypt: jest.fn() };
  const mockCloudflare = { findActiveRootDomain: jest.fn(), allocateClientSubdomain: jest.fn() };
  const mockGithub = {
    decryptToken: jest.fn(),
    listRepos: jest.fn(),
    fetchUser: jest.fn(),
    repoExists: jest.fn(),
    // Phase 10bis.5 — mode URL collée (détection auto).
    detectRepo: jest.fn(),
    deriveRepoFullName: jest.fn(),
  };
  const mockTransport = {
    createGitApp: jest.fn(),
    createProject: jest.fn(),
    applyAppLimits: jest.fn(),
    deployApp: jest.fn(),
    deploymentStatus: jest.fn(),
  };
  const mockPanelFactory = { create: jest.fn(() => mockTransport) };

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
    serviceId: 'svc1',
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

  beforeEach(() => {
    service = new DeploymentsService(
      mockPrisma as never,
      mockAudit as never,
      mockSettings as never,
      mockCrypto as never,
      mockGithub as never,
      mockPanelFactory as never,
      mockCloudflare as never,
    );
    jest.clearAllMocks();
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
    mockPrisma.service.findFirst.mockResolvedValue(serviceRow());
    mockCrypto.decrypt.mockReturnValue('coolify-token');
  });

  describe('create()', () => {
    it('403 quand le flag deployEnabled est OFF', async () => {
      mockSettings.isDeployEnabled.mockResolvedValue(false);
      await expect(
        service.create({ serviceId: 'svc1', repoFullName: 'owner/repo' }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('400 quand aucun compte GitHub n’est lié', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', githubTokenEnc: null });
      await expect(
        service.create({ serviceId: 'svc1', repoFullName: 'owner/repo' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('400 quand le dépôt n’est pas possédé', async () => {
      mockGithub.repoExists.mockResolvedValue(false);
      await expect(
        service.create({ serviceId: 'svc1', repoFullName: 'autrui/repo' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404 quand le service n’appartient pas au client (ownership)', async () => {
      mockPrisma.service.findFirst.mockResolvedValue(null);
      await expect(
        service.create({ serviceId: 'svc-autrui', repoFullName: 'owner/repo' }, actor),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('400 quand le service n’est pas ACTIVE', async () => {
      mockPrisma.service.findFirst.mockResolvedValue(serviceRow({ status: 'REQUESTED' }));
      await expect(
        service.create({ serviceId: 'svc1', repoFullName: 'owner/repo' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400 quand le service n’est pas sur un serveur COOLIFY', async () => {
      mockPrisma.service.findFirst.mockResolvedValue(
        serviceRow({ server: { ...serverRow(), panelProvider: 'HESTIA' } }),
      );
      await expect(
        service.create({ serviceId: 'svc1', repoFullName: 'owner/repo' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400 quand le serveur Coolify n’est pas connecté (panelOk ≠ true)', async () => {
      mockPrisma.service.findFirst.mockResolvedValue(
        serviceRow({ server: { ...serverRow(), panelOk: false } }),
      );
      await expect(
        service.create({ serviceId: 'svc1', repoFullName: 'owner/repo' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('flux heureux : PENDING → createGitApp → deployApp → DEPLOYING, audit deploy.create, coolifyUuid jamais exposé', async () => {
      mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
      mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
      mockTransport.deployApp.mockResolvedValue(undefined);
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow());

      const out = await service.create({ serviceId: 'svc1', repoFullName: 'owner/repo' }, actor);

      expect(mockPrisma.deployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'u1',
          serviceId: 'svc1',
          serverId: 'srv-coolify',
          repoFullName: 'owner/repo',
          branch: 'main',
          buildPack: 'nixpacks',
          appName: 'Site vitrine',
          status: 'PENDING',
        }),
      });
      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'COOLIFY', token: 'coolify-token' }),
        {
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          serviceName: 'Site vitrine',
          buildPack: 'nixpacks',
          appName: 'Site vitrine',
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

      await service.create({ serviceId: 'svc1', repoFullName: 'owner/repo', branch: ' develop ' }, actor);
      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ branch: 'develop' }),
      );
    });

    it('Phase 12 — pack ACTIVE du produit : limites appliquées AVANT deployApp', async () => {
      // Service dont le produit est abonné à un pack ACTIVE (RAM 1 Go, 1 CPU).
      const packRow = {
        id: 'pack1',
        name: 'Starter 1 Go',
        status: 'ACTIVE',
        ramMb: 1024,
        cpuCores: 1,
        storageLimit: 20,
        bandwidth: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const serviceRowWithPack = serviceRow({
        subscription: { product: { id: 'prod1', pack: packRow } },
      });
      mockPrisma.service.findFirst.mockResolvedValue(serviceRowWithPack);
      mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
      mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
      mockTransport.applyAppLimits.mockResolvedValue(undefined);
      mockTransport.deployApp.mockResolvedValue(undefined);
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow());

      const out = await service.create({ serviceId: 'svc1', repoFullName: 'owner/repo' }, actor);

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

    it('Phase 12 — best-effort : limites refusées ⇒ ligne DEPLOYING + audit deploy.limits.warn', async () => {
      const packRow = {
        id: 'pack1',
        name: 'Starter 1 Go',
        status: 'ACTIVE',
        ramMb: 1024,
        cpuCores: 1,
        storageLimit: 20,
        bandwidth: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrisma.service.findFirst.mockResolvedValue(
        serviceRow({ subscription: { product: { id: 'prod1', pack: packRow } } }),
      );
      mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
      mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
      mockTransport.applyAppLimits.mockRejectedValue(new Error('Coolify API : application des limites refusée (HTTP 400)'));
      mockTransport.deployApp.mockResolvedValue(undefined);
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow());

      const out = await service.create({ serviceId: 'svc1', repoFullName: 'owner/repo' }, actor);

      expect(out.status).toBe('DEPLOYING');
      expect(mockTransport.deployApp).toHaveBeenCalled(); // jamais bloqué par l'échec des limites
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'deploy.limits.warn' }),
      );
      const created = mockTransport.createGitApp.mock.invocationCallOrder[0];
      const deployOrder = mockTransport.deployApp.mock.invocationCallOrder[0];
      expect(created).toBeLessThan(deployOrder);
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
        mockPrisma.service.findFirst.mockResolvedValue(serviceRow());
        mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
        mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
        mockTransport.deployApp.mockResolvedValue(undefined);
        mockPrisma.deployment.update.mockResolvedValue(deploymentRow());
        mockCloudflare.findActiveRootDomain.mockResolvedValue(root);
        mockCloudflare.allocateClientSubdomain.mockResolvedValue({ subdomain: 'monapp', fqdn: 'monapp.arumdigital.com' });

        await service.create({ serviceId: 'svc1', repoFullName: 'owner/repo', subdomain: 'monapp' }, actor);

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
        mockPrisma.service.findFirst.mockResolvedValue(serviceRow());
        mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
        mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
        mockTransport.deployApp.mockResolvedValue(undefined);
        mockPrisma.deployment.update.mockResolvedValue(deploymentRow());
        mockCloudflare.findActiveRootDomain.mockResolvedValue(null);

        await service.create({ serviceId: 'svc1', repoFullName: 'owner/repo' }, actor);

        expect(mockCloudflare.allocateClientSubdomain).not.toHaveBeenCalled();
      });

      it('échec d’allocation ⇒ best-effort : ligne DEPLOYING quand même + audit deploy.domain.warn', async () => {
        mockPrisma.service.findFirst.mockResolvedValue(serviceRow());
        mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
        mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
        mockTransport.deployApp.mockResolvedValue(undefined);
        mockPrisma.deployment.update.mockResolvedValue(deploymentRow());
        mockCloudflare.findActiveRootDomain.mockResolvedValue(root);
        mockCloudflare.allocateClientSubdomain.mockRejectedValue(new Error('Sous-domaine déjà pris : monapp.arumdigital.com'));

        const out = await service.create({ serviceId: 'svc1', repoFullName: 'owner/repo', subdomain: 'monapp' }, actor);

        expect(out.status).toBe('DEPLOYING');
        expect(mockTransport.deployApp).toHaveBeenCalled(); // jamais bloqué par le DNS
        expect(mockAudit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'deploy.domain.warn' }));
      });
    });

    it('Phase 12 — aucun pack ⇒ applyAppLimits jamais appelé', async () => {
      mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
      mockTransport.createGitApp.mockResolvedValue({ uuid: 'app-1' });
      mockTransport.deployApp.mockResolvedValue(undefined);
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow());
      await service.create({ serviceId: 'svc1', repoFullName: 'owner/repo' }, actor);
      expect(mockTransport.applyAppLimits).not.toHaveBeenCalled();
    });

    it('échec Coolify : ligne FAILED + audit deploy.failed + 502', async () => {
      mockPrisma.deployment.create.mockResolvedValue(deploymentRow({ status: 'PENDING', coolifyUuid: null }));
      mockTransport.createGitApp.mockRejectedValue(new Error('Coolify API : création refusée (HTTP 401)'));
      mockPrisma.deployment.update.mockResolvedValue(deploymentRow({ status: 'FAILED', detail: 'Coolify API : création refusée (HTTP 401)' }));

      await expect(
        service.create({ serviceId: 'svc1', repoFullName: 'owner/repo' }, actor),
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
        { serviceId: 'svc1', repoUrl: 'https://github.com/owner/repo.git' },
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
          appName: 'Site vitrine',
        }),
      });
      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'develop',
          buildPack: 'nixpacks',
          appName: 'Site vitrine',
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
          serviceId: 'svc1',
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
        service.create({ serviceId: 'svc1', repoUrl: 'ftp://x/y' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
    });

    it('400 quand les deux modes sont fournis (repoFullName ET repoUrl)', async () => {
      await expect(
        service.create(
          { serviceId: 'svc1', repoFullName: 'owner/repo', repoUrl: 'https://github.com/owner/repo.git' },
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

  describe('listMine() / findMine()', () => {
    it('listMine ne renvoie que les déploiements du client, masqués + quota du pack ACTIF', async () => {
      mockPrisma.deployment.findMany.mockResolvedValue([deploymentRow()]);
      // Pack ACTIF du compte (module lié, maxApps=2) → quota exposé au client.
      mockPrisma.subscription.findFirst.mockResolvedValue({
        product: { pack: { id: 'pack1', name: 'Starter', status: 'ACTIVE', ramMb: 1024, cpuCores: 1, storageLimit: 20, maxApps: 2, bandwidth: null } },
      });
      mockPrisma.deployment.count.mockResolvedValue(1);
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
      });
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
          serviceId: null,
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
          serviceId: null,
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

    it("quota d'apps : atteint (2/2) → 403 avec le compteur, rien n'est créé", async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        activeSubscription(packWithModule({ maxApps: 2 })),
      );
      mockPrisma.deployment.count.mockResolvedValue(2);

      await expect(service.create({ repoFullName: 'owner/repo' }, actor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockPrisma.deployment.count).toHaveBeenCalledWith({
        where: { userId: 'u1', status: { not: 'FAILED' } },
      });
      expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
      expect(mockTransport.createGitApp).not.toHaveBeenCalled();
    });

    it("quota d'apps : sous la limite (1/2) → déploiement autorisé", async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        activeSubscription(packWithModule({ maxApps: 2 })),
      );
      mockPrisma.deployment.count.mockResolvedValue(1);
      happyMocks();

      const out = await service.create({ repoFullName: 'owner/repo' }, actor);
      expect(out.status).toBe('DEPLOYING');
    });

    it("quota illimité (maxApps null) → count jamais appelé", async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(activeSubscription(packWithModule()));
      happyMocks();
      await service.create({ repoFullName: 'owner/repo' }, actor);
      expect(mockPrisma.deployment.count).not.toHaveBeenCalled();
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

    it('serviceId fourni : pack avec module → le projet du module est utilisé (comportement historique + module)', async () => {
      const serviceWithPack = serviceRow({
        subscription: {
          id: 'sub1',
          product: { id: 'prod1', pack: packWithModule({ deploymentModule: moduleRow() }) },
        },
      });
      mockPrisma.service.findFirst.mockResolvedValue(serviceWithPack);
      happyMocks();

      await service.create({ serviceId: 'svc1', repoFullName: 'owner/repo' }, actor);

      expect(mockPrisma.subscription.findFirst).not.toHaveBeenCalled();
      expect(mockTransport.createGitApp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ projectUuid: 'proj-shared' }),
      );
      expect(mockPrisma.deployment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ serviceId: 'svc1', moduleId: 'modA' }),
      });
    });
  });
});
