import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { DeploymentModuleKind, Role, SubscriptionStatus } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { CryptoService } from './../src/crypto/crypto.service';
import { GlobalPrefix } from './../src/config/constants';
import {
  PanelTransportFactory,
  PanelTransport,
} from './../src/servers/panel-transport.factory';
import { HostResolverFactory } from './../src/servers/host-resolver.factory';
import { GithubService } from './../src/deployments/github.service';

// Phase 10bis (M+N) + Phases 13/16 : déploiement GitHub → Coolify côté client.
// Le panel (PanelTransportFactory) et GitHub (GithubService) sont stubés — AUCUN
// réseau réel. La cible est résolue depuis le pack ACTIF du client (ADR-035,
// table `Service` supprimée) : abonnement ACTIVE → produit → pack →
// module de déploiement A/B → serveur COOLIFY connecté. La chaîne pack/module/
// serveur est seedée via les routes admin, les abonnements ACTIVE par la
// reproduction déterministe en base du checkout. CryptoService réel (ENCRYPTION_KEY)
// couvre le cycle githubTokenEnc/apiTokenEnc chiffrés.
describe('Deployments GitHub → Coolify (e2e, Phase 10bis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: CryptoService;
  const stamp = Date.now();
  const adminEmail = `depadmin_${stamp}@example.com`;
  const clientA = `depa_${stamp}@example.com`;
  const clientB = `depb_${stamp}@example.com`;
  const clientC = `depc_${stamp}@example.com`; // AUCUN abonnement (cible absente)
  const clientD = `depd_${stamp}@example.com`; // abonnement sur un module serveur non-Coolify
  const password = 'password123';
  let adminToken = '';
  let aToken = '';
  let bToken = '';
  let cToken = '';
  let dToken = '';
  let clientAId = '';
  let productId = ''; // produit du pack « correct » (serveur COOLIFY connecté)
  let serverId = '';
  let moduleId = '';
  let packId = '';
  let breakageProductId = ''; // produit du pack « cassé » (serveur non-Coolify)
  let breakageServerId = '';
  let breakageModuleId = '';
  let breakagePackId = '';
  let impToken = '';

  // Coutures : transport panneau factice (verify + ops de déploiement) + GitHub.
  const fakeVerify = jest.fn().mockResolvedValue({ ok: true, detail: 'FAKE PANEL OK' });
  const fakeCreateGitApp = jest.fn().mockResolvedValue({ uuid: 'coolify-app-1' });
  const fakeCreateProject = jest.fn().mockResolvedValue({ uuid: 'coolify-proj-1', name: 'client-x' });
  const fakeListProjects = jest
    .fn()
    .mockResolvedValue([{ uuid: 'coolify-proj-1', name: 'Projet partagé' }]);
  const fakeDeployApp = jest.fn().mockResolvedValue(undefined);
  const fakeDeploymentStatus = jest.fn().mockResolvedValue({ rawStatus: 'in_progress' });
  const fakeFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({
      verify: fakeVerify as unknown as PanelTransport['verify'],
      createGitApp: fakeCreateGitApp,
      createProject: fakeCreateProject,
      listProjects: fakeListProjects,
      deployApp: fakeDeployApp,
      applyAppLimits: jest.fn().mockResolvedValue(undefined),
      setAppEnvironment: jest.fn().mockResolvedValue(undefined),
      setAppDomain: jest.fn().mockResolvedValue(undefined),
      deleteApplication: jest.fn().mockResolvedValue(undefined),
      deploymentStatus: fakeDeploymentStatus,
    }),
  } as unknown as PanelTransportFactory;

  const fakeGithub = {
    decryptToken: jest.fn((enc: string | null) => {
      if (!enc) throw new Error('Aucun compte GitHub lié');
      return 'gh-token-fake';
    }),
    listRepos: jest
      .fn()
      .mockResolvedValue([
        { fullName: 'owner/demo', defaultBranch: 'main', private: false, language: 'TypeScript' },
        { fullName: 'owner/other', defaultBranch: 'main', private: true, language: 'Go' },
      ]),
    fetchUser: jest.fn().mockResolvedValue({ login: 'octocat' }),
    repoExists: jest.fn().mockResolvedValue(true),
    // Phase 16 — lecture de codediali.toml/netlify.toml : retour « none » (repo
    // simple, pas de build file) — cohérent avec le service réel, n'impose rien.
    readBuildConfig: jest.fn().mockResolvedValue({ environment: {}, source: 'none' }),
    // Phase 10bis.5 — détection auto d'URL (best-effort, jamais de réseau). Le
    // mock réutilise le VRAI assainissement statique (sanitizeGitUrl) pour que
    // la garde SSRF (hôtes privés / protocole) soit réellement exercée en e2e.
    detectRepo: jest.fn(async (url: string) => {
      const repoUrl = GithubService.sanitizeGitUrl(url); // 400 si invalide/privée
      return {
        valid: true,
        repoUrl,
        repoFullName: 'owner/demo',
        defaultBranch: 'main',
        language: 'TypeScript',
        suggestedBuildPack: 'nixpacks',
      };
    }),
    deriveRepoFullName: jest.fn((url: string) => {
      try {
        const segs = new URL(url)
          .pathname.split('/')
          .filter(Boolean)
          .map((s) => s.replace(/\.git$/i, ''));
        return segs.length >= 2 ? segs.slice(-2).join('/') : segs[0] ?? null;
      } catch {
        return null;
      }
    }),
  } as never as GithubService;

  async function setDeployEnabled(on: boolean) {
    const row = await prisma.securitySetting.findFirst();
    if (row) {
      await prisma.securitySetting.update({
        where: { id: row.id },
        data: { deployEnabled: on },
      });
    } else {
      await prisma.securitySetting.create({ data: { deployEnabled: on } });
    }
  }

  // Reproduction déterministe (zéro réseau) de la ligne ACTIVE produite par le
  // checkout store (ADR-035 — le paiement vaut approbation).
  async function seedActiveSubscription(userId: string, targetProductId: string) {
    return prisma.subscription.create({
      data: { userId, productId: targetProductId, status: SubscriptionStatus.ACTIVE },
    });
  }

  async function meId(token: string): Promise<string> {
    const me = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return me.body.id as string;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PanelTransportFactory)
      .useValue(fakeFactory)
      .overrideProvider(GithubService)
      .useValue(fakeGithub)
      .overrideProvider(HostResolverFactory)
      .useValue({ create: () => ({ resolveIp: () => Promise.resolve(null) }) })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    crypto = moduleRef.get(CryptoService);

    for (const email of [adminEmail, clientA, clientB, clientC, clientD]) {
      const role = email === adminEmail ? Role.ADMIN : Role.USER;
      await prisma.user.create({
        data: { email, passwordHash: await bcrypt.hash(password, 10), role },
      });
    }
    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;
    aToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: clientA, password })
        .expect(201)
    ).body.accessToken as string;
    bToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: clientB, password })
        .expect(201)
    ).body.accessToken as string;
    cToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: clientC, password })
        .expect(201)
    ).body.accessToken as string;
    dToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: clientD, password })
        .expect(201)
    ).body.accessToken as string;

    clientAId = await meId(aToken);
    // Le client A est lié à GitHub (token chiffré stocké — Phase 10).
    await prisma.user.update({
      where: { id: clientAId },
      data: { githubTokenEnc: crypto.encrypt('gh-token-fake') },
    });

    // ── Plateforme : serveur Coolify connecté + module A + pack pour le happy path.
    serverId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/servers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `srv_coolify_${stamp}`,
          hostname: 'portal.exemple.com',
          panelProvider: 'COOLIFY',
          apiBaseUrl: 'https://panel.exemple.com/api/v1',
          apiToken: 'secret-token-raw',
        })
        .expect(201)
    ).body.id as string;
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers/${serverId}/panel-verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    moduleId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/admin/deployment-modules`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `Mod E2E A ${stamp}`,
          code: 'E2EMAIN',
          kind: 'SHARED_PROJECT',
          serverId,
          sharedProjectUuid: 'coolify-proj-1',
          sharedProjectName: 'Projet partagé',
        })
        .expect(201)
    ).body.id as string;
    packId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/packs`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `pack_e2e_${stamp}`,
          ramMb: 512,
          cpuCores: 0.5,
          maxApps: 5,
          deploymentModuleId: moduleId,
        })
        .expect(201)
    ).body.id as string;
    productId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `prod_dep_${stamp}`, kind: 'deployment', packId })
        .expect(201)
    ).body.id as string;

    // Abonnements ACTIVE (checkout) des clients A et B sur le bon pack.
    const bId = await meId(bToken);
    await seedActiveSubscription(clientAId, productId);
    await seedActiveSubscription(bId, productId);

    // ── Cible « cassée » : serveur NON-Coolify relié à un pack, pour le client D.
    // L'API admin refuse d'attacher un serveur non-Coolify à un module (validation
    // métier) — on seed la chaîne en base pour EXERCER la garde métier côté
    // déploiement (requireCoolifyServer → 400).
    breakageServerId = (
      await prisma.server.create({
        data: { name: `srv_plain_${stamp}`, hostname: 'plain.exemple.com' },
      })
    ).id;
    breakageModuleId = (
      await prisma.deploymentModule.create({
        data: {
          name: `Mod E2E cassé ${stamp}`,
          code: 'E2EBAD',
          kind: DeploymentModuleKind.SHARED_PROJECT,
          serverId: breakageServerId,
          sharedProjectUuid: 'coolify-proj-bad',
          sharedProjectName: 'Projet cassé',
        },
      })
    ).id;
    breakagePackId = (
      await prisma.hostingPack.create({
        data: {
          name: `pack_e2e_bad_${stamp}`,
          ramMb: 256,
          cpuCores: 1,
          maxApps: 5,
          deploymentModuleId: breakageModuleId,
        },
      })
    ).id;
    breakageProductId = (
      await prisma.product.create({
        data: { name: `prod_dep_bad_${stamp}`, packId: breakagePackId },
      })
    ).id;
    const dId = await meId(dToken);
    await seedActiveSubscription(dId, breakageProductId);

    await setDeployEnabled(true);
  });

  afterAll(async () => {
    await setDeployEnabled(false);
    await prisma.user
      .deleteMany({ where: { email: { in: [adminEmail, clientA, clientB, clientC, clientD] } } })
      .catch(() => {});
    for (const id of [productId, breakageProductId]) {
      if (id) await prisma.product.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of [packId, breakagePackId]) {
      if (id) await prisma.hostingPack.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of [moduleId, breakageModuleId]) {
      if (id) await prisma.deploymentModule.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of [serverId, breakageServerId]) {
      if (id) await prisma.server.deleteMany({ where: { id } }).catch(() => {});
    }
    await app.close();
  });

  it('401 without a token', async () => {
    await request(app.getHttpServer()).get(`/${GlobalPrefix}/client/deployments`).expect(401);
  });

  it('link-status returns { linked:false } for a client without GitHub (never the token)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/github/link-status`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(201);
    expect(res.body).toEqual({ linked: false, login: null });
    expect(res.body).not.toHaveProperty('token');
  });

  it('link-status returns { linked:true, login } for the GitHub-linked client', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/github/link-status`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(201);
    expect(res.body).toEqual({ linked: true, login: 'octocat' });
  });

  it('lists the auto-detected GitHub repos (no network — stubbed)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/github/repos`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect((res.body as Array<{ fullName: string }>).some((r) => r.fullName === 'owner/demo')).toBe(true);
  });

  it('deploy happy path → 201 DEPLOYING, coolifyUuid never exposed, audit deploy.create', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ repoFullName: 'owner/demo', branch: 'main' })
      .expect(201);
    expect(res.body.status).toBe('DEPLOYING');
    expect(res.body.repoFullName).toBe('owner/demo');
    expect(res.body.branch).toBe('main');
    // Cible résolue depuis le pack/module : le serveur COOLIFY connecté.
    expect(res.body.server).toEqual({ id: serverId, name: `srv_coolify_${stamp}` });
    // Le nom d'app dérive du dépôt (owner/demo → demo) — aucune « service » n'existe plus.
    expect(res.body.appName).toBe('demo');
    expect(res.body).not.toHaveProperty('coolifyUuid');
    expect(fakeCreateGitApp).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'COOLIFY' }),
      expect.objectContaining({
        repoUrl: 'https://github.com/owner/demo.git',
        branch: 'main',
        serviceName: 'demo',
        buildPack: 'nixpacks',
        appName: 'demo',
        projectUuid: 'coolify-proj-1',
      }),
    );
    expect(fakeDeployApp).toHaveBeenCalledWith(expect.anything(), 'coolify-app-1');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'deploy.create', actorEmail: clientA },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
    const details = audit?.details as { repoFullName: string; coolifyUuid?: string };
    expect(details.repoFullName).toBe('owner/demo');
    // L'UUID reste côté serveur/audit (admin), jamais dans la réponse client.
    expect(details.coolifyUuid).toBe('coolify-app-1');
  });

  it('refuses a repo the client does not own (400)', async () => {
    (fakeGithub.repoExists as unknown as jest.Mock).mockResolvedValueOnce(false);
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ repoFullName: 'autrui/repo' })
      .expect(400);
  });

  it('refuses to deploy when the client has no ACTIVE pack (403)', async () => {
    // Client C : aucun abonnement ACTIVE → aucune cible (mode URL, sans token GH).
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${cToken}`)
      .send({ repoUrl: 'https://gitlab.com/foo/bar.git' })
      .expect(403);
    expect(String(res.body.message)).toContain("Aucun pack d'hébergement actif");
  });

  it('refuses to deploy when the module’s server is not a connected Coolify (400)', async () => {
    // Client D : pack ACTIF lié à un module dont le serveur n'est PAS Coolify connecté.
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${dToken}`)
      .send({ repoUrl: 'https://gitlab.com/foo/bar.git' })
      .expect(400);
    expect(String(res.body.message)).toContain('Coolify de cette cible');
  });

  it('a deployed app fails cleanly: Coolify create refused → 502 + FAILED row + audit deploy.failed', async () => {
    fakeCreateGitApp.mockRejectedValueOnce(new Error('Coolify API : création refusée (HTTP 401)'));
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ repoFullName: 'owner/demo' })
      .expect(502);
    expect(String(res.body.message)).toContain('Échec du déploiement');
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'deploy.failed', actorEmail: clientA },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
  });

  it('cross-client isolation: B cannot see or fetch A’s deployment (404/absent)', async () => {
    const aList = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    // listMine renvoie { deployments, quota } (Phase 13 — payload du dashboard).
    const aArray = aList.body.deployments as Array<{ id: string; repoFullName: string }>;
    const mine = aArray.find((d) => d.repoFullName === 'owner/demo');
    expect(mine).toBeTruthy();
    expect(mine).not.toHaveProperty('coolifyUuid');

    const bList = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(200);
    const bArray = bList.body.deployments as Array<{ id: string }>;
    expect(bArray.some((d) => d.id === mine!.id)).toBe(false);

    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/deployments/${mine!.id}`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(404);
  });

  it('live status poll: DEPLOYING + rawStatus running → ACTIVE + audit deploy.status', async () => {
    const aList = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    const mine = (aList.body.deployments as Array<{ id: string; repoFullName: string; status: string }>)
      .find((d) => d.repoFullName === 'owner/demo' && d.status === 'DEPLOYING');
    expect(mine).toBeTruthy();

    fakeDeploymentStatus.mockResolvedValueOnce({ rawStatus: 'running' });
    const poll = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/deployments/${mine!.id}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(poll.body.status).toBe('ACTIVE');
    expect(poll.body).not.toHaveProperty('coolifyUuid');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'deploy.status', resourceId: mine!.id, actorEmail: clientA },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
  });

  it('impersonation session is READ-ONLY on deployments (POST → 403)', async () => {
    impToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/users/${clientAId}/impersonate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201)
    ).body.accessToken as string;
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${impToken}`)
      .send({ repoFullName: 'owner/demo' })
      .expect(403);
    // Lecture OK avec le jeton d'impersonation.
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${impToken}`)
      .expect(200);
  });

  it('deploy DTO rejects a malformed repoFullName (400)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ repoFullName: 'owner/repo/extra' })
      .expect(400);
  });

  // ── Phase 10bis.5 — mode URL collée (client B, SANS compte GitHub) ─────────
  describe('mode URL collée (sans GitHub lié)', () => {
    it('detect → 201 avec le dépôt détecté (branche + build pack suggéré), aucun token requis', async () => {
      const res = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/deployments/detect`)
        .set('Authorization', `Bearer ${bToken}`)
        .send({ url: 'https://github.com/owner/demo.git' })
        .expect(201);
      expect(res.body.valid).toBe(true);
      expect(res.body.repoFullName).toBe('owner/demo');
      expect(res.body.defaultBranch).toBe('main');
      expect(res.body.suggestedBuildPack).toBe('nixpacks');
      expect(fakeGithub.detectRepo).toHaveBeenCalledWith('https://github.com/owner/demo.git');
      expect(res.body).not.toHaveProperty('token');
    });

    it('deploy by URL → 201 DEPLOYING avec buildPack/appName stockés, sans toucher au token GitHub', async () => {
      (fakeGithub.detectRepo as unknown as jest.Mock).mockResolvedValueOnce({
        valid: true,
        repoUrl: 'https://gitlab.com/foo/bar.git',
        repoFullName: 'foo/bar',
        defaultBranch: 'develop',
        language: null,
        suggestedBuildPack: 'dockerfile',
      });
      (fakeGithub.decryptToken as unknown as jest.Mock).mockClear();
      fakeCreateGitApp.mockClear();

      const res = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/deployments`)
        .set('Authorization', `Bearer ${bToken}`)
        .send({
          repoUrl: 'https://gitlab.com/foo/bar.git',
          buildPack: 'dockerfile',
          appName: 'app-b',
        })
        .expect(201);
      expect(res.body.status).toBe('DEPLOYING');
      expect(res.body.repoFullName).toBe('foo/bar');
      expect(res.body.branch).toBe('develop'); // branche détectée, pas « main »
      expect(res.body.buildPack).toBe('dockerfile');
      expect(res.body.appName).toBe('app-b');
      expect(res.body).not.toHaveProperty('coolifyUuid');
      expect(fakeGithub.decryptToken).not.toHaveBeenCalled();
      expect(fakeCreateGitApp).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'COOLIFY' }),
        expect.objectContaining({
          repoUrl: 'https://gitlab.com/foo/bar.git',
          branch: 'develop',
          buildPack: 'dockerfile',
          appName: 'app-b',
        }),
      );

      // La ligne est bien en base avec l'URL brute (audit lisible, infra masquée).
      const row = await prisma.deployment.findFirst({
        where: { repoUrl: 'https://gitlab.com/foo/bar.git' },
      });
      expect(row).toBeTruthy();
      expect(row?.buildPack).toBe('dockerfile');
      expect(row?.appName).toBe('app-b');
    });

    it('deploy by URL refuses an invalid / private-host URL (400, SSRF léger)', async () => {
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/deployments`)
        .set('Authorization', `Bearer ${bToken}`)
        .send({ repoUrl: 'http://127.0.0.1/secret.git' })
        .expect(400);
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/deployments`)
        .set('Authorization', `Bearer ${bToken}`)
        .send({ repoUrl: 'git@github.com:o/r.git' })
        .expect(400);
    });

    it('deploy rejects providing BOTH repoFullName and repoUrl (400)', async () => {
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/deployments`)
        .set('Authorization', `Bearer ${aToken}`)
        .send({
          repoFullName: 'owner/demo',
          repoUrl: 'https://github.com/owner/demo.git',
        })
        .expect(400);
    });
  });
});