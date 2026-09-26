import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import {
  HostingServiceAllocationStatus,
  HostingServiceStatus,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { CryptoService } from './../src/crypto/crypto.service';
import { GlobalPrefix } from './../src/config/constants';
import { PanelTransportFactory, PanelTransport } from './../src/servers/panel-transport.factory';
import { HostResolverFactory } from './../src/servers/host-resolver.factory';
import { GithubService } from './../src/deployments/github.service';
import { CloudflareTransportFactory } from './../src/cloudflare/cloudflare.transport';
import { CONSUMING_ALLOCATION_STATUSES } from './../src/hosting/hosting-services.service';
import {
  installFingerprintEnv,
  newClientRequestId,
  removeFingerprintEnv,
} from './hosting-reservation.fixture';

/**
 * 17B.4F-C2 — e2e du branchement du moteur C1 sur `POST /client/deployments`,
 * avec la garde `HOSTING_C2_ENABLED` (OFF par défaut) et le contrat HTTP
 * historique préservé quand elle est éteinte.
 *
 * TOUT est stubé côté réseau : panel (PanelTransportFactory), GitHub
 * (GithubService), Cloudflare (transport factice) — AUCUN appel provider réel.
 * Exécuté sur la base ISOLÉE `icode_host_pro_c1_test` (DATABASE_URL externe) ;
 * AUCUNE écriture live. Les fixtures `HostingService` sont créées ici (autorisées
 * sur base isolée) et supprimées par ids exacts en afterAll.
 */
describe('Deployments 17B.4F-C2 — garde HOSTING_C2_ENABLED (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: CryptoService;
  const stamp = Date.now();
  const adminEmail = `c2admin_${stamp}@example.com`;
  const offEmail = `c2off_${stamp}@example.com`; // section OFF
  const mainEmail = `c2main_${stamp}@example.com`;
  const legacyEmail = `c2legacy_${stamp}@example.com`;
  const suspEmail = `c2susp_${stamp}@example.com`;
  const incEmail = `c2inc_${stamp}@example.com`;
  const ambEmail = `c2amb_${stamp}@example.com`;
  const quotaEmail = `c2quota_${stamp}@example.com`;
  const clientEmails = [offEmail, mainEmail, legacyEmail, suspEmail, incEmail, ambEmail, quotaEmail];
  const password = 'password123';

  let adminToken = '';
  const token: Record<string, string> = {};
  const userId: Record<string, string> = {};
  let productId = '';
  let serverId = '';
  let moduleId = '';
  let packId = '';
  let subscriptionIds: string[] = [];
  let mainSvc = '';
  let suspSvc = '';
  let incSvc = '';
  let ambSvc = '';
  let quotaSvc = '';
  const serviceIds: string[] = [];
  let allocBaseline = 0;
  const ORIGINAL_C2_ENV = process.env.HOSTING_C2_ENABLED;

  // ── Stubs réseau (aucun appel réel, comme la suite Phase 10bis) ────────────
  const fakeVerify = jest.fn().mockResolvedValue({ ok: true, detail: 'FAKE PANEL OK' });
  const fakeCreateGitApp = jest.fn().mockResolvedValue({ uuid: 'coolify-app-1' });
  const fakeCreateProject = jest.fn().mockResolvedValue({ uuid: 'coolify-proj-1', name: 'x' });
  const fakeDeployApp = jest.fn().mockResolvedValue(undefined);
  const fakeDeploymentStatus = jest.fn().mockResolvedValue({ rawStatus: 'in_progress' });
  const fakeDeleteApplication = jest.fn().mockResolvedValue(undefined);
  const fakeCfTransport = {
    findRecordByName: jest.fn().mockResolvedValue(null),
    createRecord: jest.fn().mockResolvedValue('fake-rec-1'),
    deleteRecord: jest.fn().mockResolvedValue(undefined),
    listZones: jest.fn().mockResolvedValue([]),
  };
  const fakeFactory = {
    create: (): PanelTransport =>
      ({
        verify: fakeVerify,
        createGitApp: fakeCreateGitApp,
        createProject: fakeCreateProject,
        listProjects: jest.fn().mockResolvedValue([{ uuid: 'coolify-proj-1', name: 'Projet' }]),
        listServers: jest.fn().mockResolvedValue([]),
        deployApp: fakeDeployApp,
        applyAppLimits: jest.fn().mockResolvedValue(undefined),
        setAppEnvironment: jest.fn().mockResolvedValue(undefined),
        applyNodePort: jest.fn().mockResolvedValue(undefined),
        resolveExposedPort: jest.fn().mockResolvedValue(null),
        setAppDomain: jest.fn().mockResolvedValue(undefined),
        deleteApplication: fakeDeleteApplication,
        deploymentStatus: fakeDeploymentStatus,
      }) as unknown as PanelTransport,
  } as unknown as PanelTransportFactory;

  const fakeGithub = {
    decryptToken: jest.fn((enc: string | null) => {
      if (!enc) throw new Error('Aucun compte GitHub lié');
      return 'gh-token-fake';
    }),
    listRepos: jest.fn().mockResolvedValue([]),
    fetchUser: jest.fn().mockResolvedValue({ login: 'octocat' }),
    repoExists: jest.fn().mockResolvedValue(true),
    readBuildConfig: jest.fn().mockResolvedValue({ environment: {}, source: 'none' }),
    detectRepo: jest.fn(async (url: string) => {
      const repoUrl = GithubService.sanitizeGitUrl(url);
      return {
        valid: true,
        repoUrl,
        repoFullName: 'owner/demo',
        defaultBranch: 'main',
        language: 'TypeScript',
        suggestedBuildPack: 'nixpacks',
      };
    }),
    deriveRepoFullName: jest.fn(() => 'owner/demo'),
  } as never as GithubService;

  async function setDeployEnabled(on: boolean) {
    const row = await prisma.securitySetting.findFirst();
    if (row) {
      await prisma.securitySetting.update({ where: { id: row.id }, data: { deployEnabled: on } });
    } else {
      await prisma.securitySetting.create({ data: { deployEnabled: on } });
    }
  }

  async function meId(tkn: string): Promise<string> {
    const me = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${tkn}`)
      .expect(200);
    return me.body.id as string;
  }

  const post = (tkn: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${tkn}`)
      .send(body);

  const consuming = (svcId: string) =>
    prisma.hostingServiceAllocation.count({
      where: {
        hostingServiceId: svcId,
        status: { in: [...CONSUMING_ALLOCATION_STATUSES] },
      },
    });

  const depCount = (email: string) =>
    prisma.deployment.count({ where: { user: { email } } });

  // ClientSubdomain de CETTE suite : ids exacts, teardown déterministe.
  const trackedCsIds = new Set<string>();
  async function snapshotSuiteClientSubdomains(): Promise<void> {
    const deps = await prisma.deployment
      .findMany({
        where: { user: { email: { in: [adminEmail, ...clientEmails] } } },
        select: { id: true },
      })
      .catch(() => [] as Array<{ id: string }>);
    if (!deps.length) return;
    const rows = await prisma.clientSubdomain
      .findMany({
        where: { deploymentId: { in: deps.map((d) => d.id) } },
        select: { id: true },
      })
      .catch(() => [] as Array<{ id: string }>);
    for (const r of rows) trackedCsIds.add(r.id);
  }
  afterEach(async () => {
    await snapshotSuiteClientSubdomains();
  });

  async function mkService(userId: string, subscriptionId: string, over: Record<string, unknown> = {}) {
    const row = await prisma.hostingService.create({
      data: {
        userId,
        subscriptionId,
        productId,
        packId,
        deploymentModuleId: moduleId,
        status: HostingServiceStatus.ACTIVE,
        maxAppsSnapshot: null,
        ramMbSnapshot: 512,
        cpuCoresSnapshot: 0.5,
        storageLimitGbSnapshot: null,
        packNameSnapshot: `pack_e2e_${stamp}`,
        productNameSnapshot: `prod_c2_${stamp}`,
        ...over,
      },
    });
    serviceIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    installFingerprintEnv(); // clé d'empreinte SYNTHÉTIQUE (fixtures C1)
    delete process.env.HOSTING_C2_ENABLED; // section OFF = défaut du fichier

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PanelTransportFactory)
      .useValue(fakeFactory)
      .overrideProvider(GithubService)
      .useValue(fakeGithub)
      .overrideProvider(HostResolverFactory)
      .useValue({ create: () => ({ resolveIp: () => Promise.resolve(null) }) })
      .overrideProvider(CloudflareTransportFactory)
      .useValue({ create: () => fakeCfTransport })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    crypto = moduleRef.get(CryptoService);

    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
      },
    });
    for (const email of clientEmails) {
      const u = await prisma.user.create({
        data: { email, passwordHash: await bcrypt.hash(password, 10), role: Role.USER },
      });
      userId[email] = u.id;
      // Lien GitHub factice (mode repoFullName) : token chiffré réellement stocké.
      await prisma.user.update({
        where: { id: u.id },
        data: { githubTokenEnc: crypto.encrypt('gh-token-fake') },
      });
    }
    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;
    for (const email of clientEmails) {
      token[email] = (
        await request(app.getHttpServer())
          .post(`/${GlobalPrefix}/auth/login`)
          .send({ email, password })
          .expect(201)
      ).body.accessToken as string;
    }

    // ── Plateforme : serveur Coolify connecté + module A + pack (maxApps=5). ──
    serverId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/servers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `srv_c2_${stamp}`,
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
          name: `Mod E2E C2 ${stamp}`,
          code: 'E2EC2',
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
          name: `pack_c2_${stamp}`,
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
        .send({ name: `prod_c2_${stamp}`, kind: 'deployment', packId })
        .expect(201)
    ).body.id as string;

    for (const email of clientEmails) {
      const sub = await prisma.subscription.create({
        data: {
          userId: userId[email],
          productId,
          status: SubscriptionStatus.ACTIVE,
        },
      });
      subscriptionIds.push(sub.id);
    }

    // ── Fixtures HostingService (base ISOLÉE — jamais live) ──────────────────
    mainSvc = await mkService(userId[mainEmail], subscriptionIds[clientEmails.indexOf(mainEmail)]);
    suspSvc = await mkService(userId[suspEmail], subscriptionIds[clientEmails.indexOf(suspEmail)], {
      status: HostingServiceStatus.SUSPENDED,
    });
    // Incompatible : rattaché, ACTIF, mais provenance pack/module différente.
    incSvc = await mkService(userId[incEmail], subscriptionIds[clientEmails.indexOf(incEmail)], {
      packId: null,
      deploymentModuleId: null,
    });
    // Ambigu : service existant AUCUNEMENT rattaché (provenance absente).
    ambSvc = await mkService(userId[ambEmail], subscriptionIds[clientEmails.indexOf(ambEmail)], {
      subscriptionId: null,
    });
    quotaSvc = await mkService(
      userId[quotaEmail],
      subscriptionIds[clientEmails.indexOf(quotaEmail)],
    );
    // legacyEmail / offEmail : AUCUN service (preuve legacy / section OFF).

    allocBaseline = await prisma.hostingServiceAllocation.count();
    await setDeployEnabled(true);
  });

  afterAll(async () => {
    await setDeployEnabled(false);
    await snapshotSuiteClientSubdomains();
    if (trackedCsIds.size > 0) {
      await prisma.clientSubdomain
        .deleteMany({ where: { id: { in: [...trackedCsIds] } } })
        .catch(() => {});
    }
    // Ordre des FK : allocations (→ service RESTRICT) puis services (→ user
    // RESTRICT), abonnements, enfin les comptes et le catalogue.
    await prisma.hostingServiceAllocation
      .deleteMany({ where: { hostingServiceId: { in: serviceIds } } })
      .catch(() => {});
    await prisma.hostingService.deleteMany({ where: { id: { in: serviceIds } } }).catch(() => {});
    await prisma.subscription.deleteMany({ where: { id: { in: subscriptionIds } } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { email: { in: [adminEmail, ...clientEmails] } } })
      .catch(() => {});
    for (const id of [productId]) if (id) await prisma.product.deleteMany({ where: { id } }).catch(() => {});
    for (const id of [packId]) if (id) await prisma.hostingPack.deleteMany({ where: { id } }).catch(() => {});
    for (const id of [moduleId]) if (id) await prisma.deploymentModule.deleteMany({ where: { id } }).catch(() => {});
    for (const id of [serverId]) if (id) await prisma.server.deleteMany({ where: { id } }).catch(() => {});

    // Restaure l'environnement pour tout worker suivant (off par défaut).
    if (ORIGINAL_C2_ENV === undefined) delete process.env.HOSTING_C2_ENABLED;
    else process.env.HOSTING_C2_ENABLED = ORIGINAL_C2_ENV;
    removeFingerprintEnv();
    await app.close();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — garde OFF (état par défaut : variable absente).
  // Contrat HTTP historique : aucun clientRequestId requis, aucune écriture
  // C1, endpoint de liste INERTE (réponse fixe documentée).
  // ══════════════════════════════════════════════════════════════════════════
  describe('Garde OFF (défaut — env absente)', () => {
    beforeAll(() => {
      delete process.env.HOSTING_C2_ENABLED;
    });

    it('GET hosting-services → réponse FIXE inerte {enabled:false,services:[]}', async () => {
      const res = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/client/hosting-services`)
        .set('Authorization', `Bearer ${token[mainEmail]}`)
        .expect(200);
      expect(res.body).toEqual({ enabled: false, services: [] });
      expect(await prisma.hostingServiceAllocation.count()).toBe(allocBaseline);
    });

    it('POST sans clientRequestId → 201 (contrat historique), ZÉRO accès moteur C1', async () => {
      const res = await post(token[offEmail], {
        repoFullName: 'owner/demo',
        branch: 'main',
      }).expect(201);
      expect(res.body.status).toBe('DEPLOYING');
      expect(res.body.id).toBeTruthy();
      expect(await prisma.hostingServiceAllocation.count()).toBe(allocBaseline);
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'deploy.create', actorEmail: offEmail },
        orderBy: { createdAt: 'desc' },
      });
      const details = audit?.details as Record<string, unknown>;
      expect(details).toBeTruthy();
      expect(details).not.toHaveProperty('c2'); // marqueur absent = garde OFF
    });

    it('POST avec clientRequestId malformé → 201 (ignoré : la validation C1 est inerte)', async () => {
      const res = await post(token[offEmail], {
        repoFullName: 'owner/demo',
        branch: 'main',
        clientRequestId: 'pas-un-uuid',
      }).expect(201);
      expect(res.body.status).toBe('DEPLOYING');
      expect(await prisma.hostingServiceAllocation.count()).toBe(allocBaseline);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — garde ON : classification locale sans repli, réservation +
  // rejeu, intention provider, compensation, liaison allocation → déploiement.
  // ══════════════════════════════════════════════════════════════════════════
  describe("Garde ON (HOSTING_C2_ENABLED='true')", () => {
    beforeAll(() => {
      process.env.HOSTING_C2_ENABLED = 'true';
    });
    afterAll(() => {
      delete process.env.HOSTING_C2_ENABLED;
    });

    it('clientRequestId absent sur parcours C2 → 400, aucune allocation créée', async () => {
      const res = await post(token[mainEmail], { repoFullName: 'owner/demo' });
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toContain('clientRequestId');
      expect(await consuming(mainSvc)).toBe(0);
      expect(await depCount(mainEmail)).toBe(0);
    });

    it('clientRequestId non-UUID → 400, aucune allocation créée', async () => {
      const res = await post(token[mainEmail], {
        repoFullName: 'owner/demo',
        clientRequestId: 'not-a-uuid',
      });
      expect(res.status).toBe(400);
      expect(await consuming(mainSvc)).toBe(0);
    });

    it('hostingServiceId étranger (service d’un autre client) → 404, JAMAIS de repli legacy', async () => {
      const before = await depCount(mainEmail);
      const res = await post(token[mainEmail], {
        repoFullName: 'owner/demo',
        clientRequestId: newClientRequestId(),
        hostingServiceId: suspSvc, // appartient à suspEmail
      });
      expect(res.status).toBe(404);
      expect(await depCount(mainEmail)).toBe(before);
      expect(await consuming(mainSvc)).toBe(0);
    });

    it('service SUSPENDU → 409, aucun repli legacy (pas de row, pas de slot)', async () => {
      const res = await post(token[suspEmail], {
        repoFullName: 'owner/demo',
        clientRequestId: newClientRequestId(),
      });
      expect(res.status).toBe(409);
      expect(String(res.body.message)).toContain('non actif');
      expect(await depCount(suspEmail)).toBe(0);
      expect(await consuming(suspSvc)).toBe(0);
    });

    it('service incompatible (provenance pack/module différente) → 409, aucun repli', async () => {
      const res = await post(token[incEmail], {
        repoFullName: 'owner/demo',
        clientRequestId: newClientRequestId(),
      });
      expect(res.status).toBe(409);
      expect(String(res.body.message)).toContain('incompatible');
      expect(await depCount(incEmail)).toBe(0);
      expect(await consuming(incSvc)).toBe(0);
    });

    it('services existants mais NON rattachés à l’abonnement actif → 409, aucun repli', async () => {
      const res = await post(token[ambEmail], {
        repoFullName: 'owner/demo',
        clientRequestId: newClientRequestId(),
      });
      expect(res.status).toBe(409);
      expect(String(res.body.message)).toContain('rattaché');
      expect(await depCount(ambEmail)).toBe(0);
      expect(await consuming(ambSvc)).toBe(0);
    });

    it('legacy PROUVÉ (0 ligne HostingService) → 201 sans clientRequestId, audit c2=legacy_no_service', async () => {
      const res = await post(token[legacyEmail], {
        repoFullName: 'owner/demo',
        branch: 'main',
      }).expect(201);
      expect(res.body.status).toBe('DEPLOYING');
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'deploy.create', actorEmail: legacyEmail },
        orderBy: { createdAt: 'desc' },
      });
      const details = audit?.details as Record<string, unknown>;
      expect(details.c2).toBe('legacy_no_service');
      expect(await prisma.hostingServiceAllocation.count()).toBe(allocBaseline);
    });

    it('GET hosting-services ON → services du jeton + compatibilité pack/module', async () => {
      const res = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/client/hosting-services`)
        .set('Authorization', `Bearer ${token[mainEmail]}`)
        .expect(200);
      expect(res.body.enabled).toBe(true);
      expect(
        (res.body.services as Array<Record<string, unknown>>).find((s) => s.id === mainSvc),
      ).toMatchObject({ id: mainSvc, status: 'ACTIVE', compatible: true });
    });

    let cidA = '';
    let depAId = '';

    it('heureux C2 : réservation → intention → création app → BOUND lié, empreinte + audit c2', async () => {
      cidA = newClientRequestId();
      const res = await post(token[mainEmail], {
        repoFullName: 'owner/demo',
        clientRequestId: cidA,
        hostingServiceId: mainSvc,
      }).expect(201);
      depAId = res.body.id as string;
      expect(res.body.status).toBe('DEPLOYING');
      expect(res.body).not.toHaveProperty('coolifyUuid');

      const alloc = await prisma.hostingServiceAllocation.findFirst({
        where: { hostingServiceId: mainSvc },
      });
      expect(alloc).toBeTruthy();
      expect(alloc!.status).toBe(HostingServiceAllocationStatus.BOUND);
      expect(alloc!.deploymentId).toBe(depAId);
      expect(alloc!.providerIntentAt).not.toBeNull(); // intention AVANT mutation distante
      expect(alloc!.requestFingerprint).toMatch(/^fp:v1:/); // empreinte C1 posée
      expect(alloc!.idempotencyKey).toContain(cidA);

      // La branche ABSENTE côté intention est résolue « main » sur la row —
      // mais l'empreinte garde bien l'intention reçue (null), pas la résolution.
      const dep = await prisma.deployment.findUnique({ where: { id: depAId } });
      expect(dep?.branch).toBe('main');

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'deploy.create', actorEmail: mainEmail },
        orderBy: { createdAt: 'desc' },
      });
      const details = audit?.details as Record<string, unknown>;
      expect(details.c2).toEqual({
        hostingServiceId: mainSvc,
        allocationId: alloc!.id,
        clientRequestId: cidA,
      });
      expect(await consuming(mainSvc)).toBe(1);
    });

    it('rejeu même clientRequestId + payload identique → MÊME déploiement, zéro appel provider', async () => {
      const before = fakeCreateGitApp.mock.calls.length;
      const res = await post(token[mainEmail], {
        repoFullName: 'owner/demo',
        clientRequestId: cidA,
        hostingServiceId: mainSvc,
      }).expect(201);
      expect(res.body.id).toBe(depAId);
      expect(fakeCreateGitApp.mock.calls.length).toBe(before); // AUCUNE ré-exécution
      expect(await consuming(mainSvc)).toBe(1);
      expect(await depCount(mainEmail)).toBe(1);
    });

    it('rejeu même clientRequestId mais payload DIFFÉRENT (branche absente vs « main ») → 409 empreinte', async () => {
      const before = fakeCreateGitApp.mock.calls.length;
      const res = await post(token[mainEmail], {
        repoFullName: 'owner/demo',
        branch: 'main', // cidA envoyé SANS branche : empreinte différente
        clientRequestId: cidA,
        hostingServiceId: mainSvc,
      });
      expect(res.status).toBe(409);
      expect(String(res.body.message)).toContain('empreinte');
      expect(fakeCreateGitApp.mock.calls.length).toBe(before);
      expect(await depCount(mainEmail)).toBe(1); // aucune 2ᵉ opération
    });

    it('branche absente ≠ « main » : nouveau clientRequestId avec « main » explicite → opération DISTINCTE (201)', async () => {
      const res = await post(token[mainEmail], {
        repoFullName: 'owner/demo',
        branch: 'main',
        clientRequestId: newClientRequestId(),
        hostingServiceId: mainSvc,
      }).expect(201);
      expect(res.body.id).not.toBe(depAId);
      expect(await consuming(mainSvc)).toBe(2);
      expect(await depCount(mainEmail)).toBe(2);
    });

    it('DOUBLE POST simultané même clientRequestId → UNE seule opération (concurrence)', async () => {
      const cidC = newClientRequestId();
      const body = {
        repoFullName: 'owner/demo',
        clientRequestId: cidC,
        hostingServiceId: mainSvc,
      };
      const gitBefore = fakeCreateGitApp.mock.calls.length;
      const depsBefore = await depCount(mainEmail);
      const allocBefore = await consuming(mainSvc);

      const [r1, r2] = await Promise.all([post(token[mainEmail], body), post(token[mainEmail], body)]);

      // Chaque réponse ∈ {201 (réussite), 409 (rejeu en cours/incertain)} —
      // JAMAIS deux exécutions, JAMAIS de takeover silencieux.
      expect([201, 409]).toContain(r1.status);
      expect([201, 409]).toContain(r2.status);
      expect([r1.status, r2.status].filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);

      expect(await depCount(mainEmail)).toBe(depsBefore + 1); // 1 seule row
      expect(await consuming(mainSvc)).toBe(allocBefore + 1); // 1 seule allocation
      expect(fakeCreateGitApp.mock.calls.length).toBe(gitBefore + 1); // 1 seule exécution provider
    });

    it('refus GitHub APRÈS réservation → 400 + libération pré-provider (slot non consommé)', async () => {
      (fakeGithub.repoExists as unknown as jest.Mock).mockResolvedValueOnce(false);
      const depsBefore = await depCount(mainEmail);
      const allocBefore = await consuming(mainSvc);

      const res = await post(token[mainEmail], {
        repoFullName: 'owner/repo-private',
        clientRequestId: newClientRequestId(),
        hostingServiceId: mainSvc,
      });
      expect(res.status).toBe(400);

      expect(await depCount(mainEmail)).toBe(depsBefore); // AUCUNE row
      expect(await consuming(mainSvc)).toBe(allocBefore); // slot libéré
      const rollback = await prisma.auditLog.findFirst({
        where: { action: 'deploy.c2.rollback', actorEmail: mainEmail },
        orderBy: { createdAt: 'desc' },
      });
      expect(rollback).toBeTruthy();
      expect((rollback?.details as Record<string, unknown>).trigger).toBe('pre_intent');
    });

    it('échec provider APRÈS intention → 502, row FAILED, slot CONSERVÉ, retry → 409 incertitude', async () => {
      fakeCreateGitApp.mockRejectedValueOnce(new Error('panel timeout'));
      const cidT = newClientRequestId();
      const allocBefore = await consuming(mainSvc);

      const res = await post(token[mainEmail], {
        repoFullName: 'owner/demo',
        clientRequestId: cidT,
        hostingServiceId: mainSvc,
      });
      expect(res.status).toBe(502);

      const alloc = await prisma.hostingServiceAllocation.findFirst({
        where: { idempotencyKey: { contains: cidT } },
      });
      expect(alloc).toBeTruthy();
      expect(alloc!.status).toBe(HostingServiceAllocationStatus.RESERVED);
      expect(alloc!.providerIntentAt).not.toBeNull(); // intention → JAMAIS de release
      expect(alloc!.deploymentId).toBeNull();
      expect(await consuming(mainSvc)).toBe(allocBefore + 1); // incertain = consommé

      const failed = await prisma.deployment.findFirst({
        where: { user: { email: mainEmail }, status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(failed).toBeTruthy();

      // Retry du MÊME clientRequestId : rejeu → 409 incertitude, jamais de 2ᵉ appel.
      const gitBefore = fakeCreateGitApp.mock.calls.length;
      const retry = await post(token[mainEmail], {
        repoFullName: 'owner/demo',
        clientRequestId: cidT,
        hostingServiceId: mainSvc,
      });
      expect(retry.status).toBe(409);
      expect(String(retry.body.message)).toContain('incertitude');
      expect(fakeCreateGitApp.mock.calls.length).toBe(gitBefore);
    });

    it('B0 plein (5/5) : rejeu d’une opération existante renvoyée, NOUVEAU clientRequestId → 403 sans slot consommé', async () => {
      // Remplissage du quota pack (maxApps=5) pour quotaEmail — tout en C2.
      const firstCid = newClientRequestId();
      let firstId = '';
      for (let i = 0; i < 5; i++) {
        const cid = i === 0 ? firstCid : newClientRequestId();
        const r = await post(token[quotaEmail], {
          repoFullName: 'owner/demo',
          clientRequestId: cid,
          hostingServiceId: quotaSvc,
        }).expect(201);
        if (i === 0) firstId = r.body.id as string;
      }
      expect(await depCount(quotaEmail)).toBe(5);
      expect(await consuming(quotaSvc)).toBe(5);

      // Rejeu MÊME clientRequestId malgré B0 plein → opération existante (201).
      const gitBefore = fakeCreateGitApp.mock.calls.length;
      const replay = await post(token[quotaEmail], {
        repoFullName: 'owner/demo',
        clientRequestId: firstCid,
        hostingServiceId: quotaSvc,
      }).expect(201);
      expect(replay.body.id).toBe(firstId);
      expect(fakeCreateGitApp.mock.calls.length).toBe(gitBefore); // rejeu sans exécution

      // NOUVELLE opération avec B0 plein → 403, slot NON consommé, aucun appel.
      const allocBefore = await consuming(quotaSvc);
      const res = await post(token[quotaEmail], {
        repoFullName: 'owner/demo',
        clientRequestId: newClientRequestId(),
        hostingServiceId: quotaSvc,
      });
      expect(res.status).toBe(403);
      expect(await consuming(quotaSvc)).toBe(allocBefore); // compensation OK
      expect(await depCount(quotaEmail)).toBe(5);
      expect(fakeCreateGitApp.mock.calls.length).toBe(gitBefore);
    });
  });
});
