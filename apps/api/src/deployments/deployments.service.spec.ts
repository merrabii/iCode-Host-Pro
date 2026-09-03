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
    deployment: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  };
  const mockAudit = { record: jest.fn() };
  const mockSettings = { isDeployEnabled: jest.fn() };
  const mockCrypto = { encrypt: jest.fn(), decrypt: jest.fn() };
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
    );
    jest.clearAllMocks();
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
    it('listMine ne renvoie que les déploiements du client, masqués', async () => {
      mockPrisma.deployment.findMany.mockResolvedValue([deploymentRow()]);
      const out = await service.listMine(actor);
      expect(mockPrisma.deployment.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        include: expect.anything(),
        orderBy: { createdAt: 'desc' },
      });
      expect(out).toHaveLength(1);
      expect(out[0]).not.toHaveProperty('coolifyUuid');
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
});
