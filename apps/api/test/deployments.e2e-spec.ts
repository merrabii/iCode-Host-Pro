import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role } from '@prisma/client';
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

// Phase 10bis (M+N) : déploiement GitHub → Coolify côté client. Le panel
// (PanelTransportFactory) et GitHub (GithubService) sont stubés — AUCUN réseau
// réel. La chaîne réelle subscription → service ACTIVE sur serveur COOLIFY
// connecté (panelOk=true) est seedée via les routes admin ; CryptoService réel
// (ENCRYPTION_KEY) couvre le cycle githubTokenEnc/apiTokenEnc chiffrés.
describe('Deployments GitHub → Coolify (e2e, Phase 10bis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: CryptoService;
  const stamp = Date.now();
  const adminEmail = `depadmin_${stamp}@example.com`;
  const clientA = `depa_${stamp}@example.com`;
  const clientB = `depb_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let aToken = '';
  let bToken = '';
  let productId = '';
  let serverId = '';
  let serviceId = '';
  let bServiceId = '';
  let clientAId = '';
  let impToken = '';

  // Coutures : transport panneau factice (verify + ops de déploiement) + GitHub.
  const fakeVerify = jest.fn().mockResolvedValue({ ok: true, detail: 'FAKE PANEL OK' });
  const fakeCreateGitApp = jest.fn().mockResolvedValue({ uuid: 'coolify-app-1' });
  const fakeDeployApp = jest.fn().mockResolvedValue(undefined);
  const fakeDeploymentStatus = jest.fn().mockResolvedValue({ rawStatus: 'in_progress' });
  const fakeFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({
      verify: fakeVerify as unknown as PanelTransport['verify'],
      createGitApp: fakeCreateGitApp,
      deployApp: fakeDeployApp,
      applyAppLimits: jest.fn().mockResolvedValue(undefined),
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

    for (const [email, role] of [
      [adminEmail, Role.ADMIN],
      [clientA, Role.USER],
      [clientB, Role.USER],
    ] as const) {
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

    const aMe = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    clientAId = aMe.body.id as string;
    // Le client A est lié à GitHub (token chiffré stocké — Phase 10).
    await prisma.user.update({
      where: { id: clientAId },
      data: { githubTokenEnc: crypto.encrypt('gh-token-fake') },
    });

    // Plateforme : produit + serveur Coolify connecté (panel-verify → panelOk).
    productId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `prod_dep_${stamp}`, kind: 'deployment' })
        .expect(201)
    ).body.id as string;
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

    // Chaîne client : souscription ACTIVE + service ACTIVE sur le serveur Coolify.
    const subId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/subscriptions`)
        .set('Authorization', `Bearer ${aToken}`)
        .send({ productId })
        .expect(201)
    ).body.id as string;
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/subscriptions/${subId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(200);
    serviceId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/services`)
        .set('Authorization', `Bearer ${aToken}`)
        .send({ subscriptionId: subId, name: 'Site vitrine' })
        .expect(201)
    ).body.id as string;
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/services/${serviceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'PROVISIONING', serverId })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/services/${serviceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(200);

    // Chaîne client B (SANS GitHub) : souscription ACTIVE + service ACTIVE sur le
    // même serveur Coolify — sert au mode URL collée (Phase 10bis.5).
    const bSubId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/subscriptions`)
        .set('Authorization', `Bearer ${bToken}`)
        .send({ productId })
        .expect(201)
    ).body.id as string;
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/subscriptions/${bSubId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(200);
    bServiceId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/services`)
        .set('Authorization', `Bearer ${bToken}`)
        .send({ subscriptionId: bSubId, name: 'App B' })
        .expect(201)
    ).body.id as string;
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/services/${bServiceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'PROVISIONING', serverId })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/services/${bServiceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(200);

    await setDeployEnabled(true);
  });

  afterAll(async () => {
    await setDeployEnabled(false);
    await prisma.user
      .deleteMany({ where: { email: { in: [adminEmail, clientA, clientB] } } })
      .catch(() => {});
    if (productId) await prisma.product.deleteMany({ where: { id: productId } }).catch(() => {});
    if (serverId) await prisma.server.deleteMany({ where: { id: serverId } }).catch(() => {});
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
      .send({ serviceId, repoFullName: 'owner/demo', branch: 'main' })
      .expect(201);
    expect(res.body.status).toBe('DEPLOYING');
    expect(res.body.repoFullName).toBe('owner/demo');
    expect(res.body.branch).toBe('main');
    expect(res.body.service).toEqual({ id: serviceId, name: 'Site vitrine' });
    expect(res.body.server).toEqual({ id: serverId, name: `srv_coolify_${stamp}` });
    expect(res.body).not.toHaveProperty('coolifyUuid');
    expect(fakeCreateGitApp).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'COOLIFY' }),
      expect.objectContaining({
        repoUrl: 'https://github.com/owner/demo.git',
        branch: 'main',
        serviceName: 'Site vitrine',
        buildPack: 'nixpacks',
        appName: 'Site vitrine',
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
      .send({ serviceId, repoFullName: 'autrui/repo' })
      .expect(400);
  });

  it('refuses a non-ACTIVE service (400)', async () => {
    // Un second service REQUESTED (jamais provisionné) ne peut pas être déployé.
    const pendingService = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/services`)
        .set('Authorization', `Bearer ${aToken}`)
        .send({ subscriptionId: (await prisma.subscription.findFirst({ where: { user: { email: clientA } } }))?.id, name: 'En attente' })
        .expect(201)
    ).body.id as string;
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ serviceId: pendingService, repoFullName: 'owner/demo' })
      .expect(400);
  });

  it('refuses a service not assigned to a COOLIFY connected server (400)', async () => {
    const otherServerId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/servers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `srv_plain_${stamp}`, hostname: 'plain.exemple.com', panelProvider: 'HESTIA', apiBaseUrl: 'https://p/api/', apiToken: 't' })
        .expect(201)
    ).body.id as string;
    const sub = await prisma.subscription.findFirst({ where: { user: { email: clientA } } });
    const svc = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/services`)
        .set('Authorization', `Bearer ${aToken}`)
        .send({ subscriptionId: sub?.id, name: 'Hestia impossible' })
        .expect(201)
    ).body.id as string;
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/services/${svc}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'PROVISIONING', serverId: otherServerId })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/services/${svc}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ serviceId: svc, repoFullName: 'owner/demo' })
      .expect(400);
    await prisma.server.deleteMany({ where: { id: otherServerId } }).catch(() => {});
  });

  it('a deployed app fails cleanly: Coolify create refused → 502 + FAILED row + audit deploy.failed', async () => {
    fakeCreateGitApp.mockRejectedValueOnce(new Error('Coolify API : création refusée (HTTP 401)'));
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ serviceId, repoFullName: 'owner/demo' })
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
    const mine = aList.body.find((d: { repoFullName: string }) => d.repoFullName === 'owner/demo') as {
      id: string;
    };
    expect(mine).toBeTruthy();
    expect(mine).not.toHaveProperty('coolifyUuid');

    const bList = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(200);
    expect(bList.body.some((d: { id: string }) => d.id === mine.id)).toBe(false);

    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/deployments/${mine.id}`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(404);
  });

  it('live status poll: DEPLOYING + rawStatus running → ACTIVE + audit deploy.status', async () => {
    const aList = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    const mine = aList.body.find((d: { repoFullName: string; status: string }) => d.repoFullName === 'owner/demo' && d.status === 'DEPLOYING') as { id: string };
    expect(mine).toBeTruthy();

    fakeDeploymentStatus.mockResolvedValueOnce({ rawStatus: 'running' });
    const poll = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/deployments/${mine.id}`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(poll.body.status).toBe('ACTIVE');
    expect(poll.body).not.toHaveProperty('coolifyUuid');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'deploy.status', resourceId: mine.id, actorEmail: clientA },
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
      .send({ serviceId, repoFullName: 'owner/demo' })
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
      .send({ serviceId, repoFullName: 'owner/repo/extra' })
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
          serviceId: bServiceId,
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
        where: { serviceId: bServiceId, repoUrl: 'https://gitlab.com/foo/bar.git' },
      });
      expect(row).toBeTruthy();
      expect(row?.buildPack).toBe('dockerfile');
      expect(row?.appName).toBe('app-b');
    });

    it('deploy by URL refuses an invalid / private-host URL (400, SSRF léger)', async () => {
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/deployments`)
        .set('Authorization', `Bearer ${bToken}`)
        .send({ serviceId: bServiceId, repoUrl: 'http://127.0.0.1/secret.git' })
        .expect(400);
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/deployments`)
        .set('Authorization', `Bearer ${bToken}`)
        .send({ serviceId: bServiceId, repoUrl: 'git@github.com:o/r.git' })
        .expect(400);
    });

    it('deploy rejects providing BOTH repoFullName and repoUrl (400)', async () => {
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/client/deployments`)
        .set('Authorization', `Bearer ${aToken}`)
        .send({
          serviceId,
          repoFullName: 'owner/demo',
          repoUrl: 'https://github.com/owner/demo.git',
        })
        .expect(400);
    });
  });
});
