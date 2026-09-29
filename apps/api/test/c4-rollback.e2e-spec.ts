import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import {
  HostingServiceStatus,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { CryptoService } from './../src/crypto/crypto.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { PanelTransport, PanelTransportFactory } from './../src/servers/panel-transport.factory';
import { GithubService } from './../src/deployments/github.service';
import { HostResolverFactory } from './../src/servers/host-resolver.factory';
import { CloudflareTransportFactory } from './../src/cloudflare/cloudflare.transport';
import { C4ProtocolService } from './../src/hosting/c4-protocol.service';
import { CONSUMING_ALLOCATION_STATUSES } from './../src/hosting/hosting-services.service';
import {
  installFingerprintEnv,
  newClientRequestId,
  removeFingerprintEnv,
} from './hosting-reservation.fixture';

/**
 * GO CLÔTURE C1 — rollback PostgreSQL RÉEL sous C2+C4 ON.
 *
 * Vrai `C4ProtocolService` + VRAIES transactions Prisma (settleStandalone =
 * `$transaction` dédiée, `SELECT … FOR UPDATE` + écriture tentative + `persist`
 * dans LA MÊME TX) sur base isolée `icode_host_pro_c4test` (identité vérifiée
 * AVANT toute écriture). Transports SEULEMENT simulés (panel, GitHub,
 * Cloudflare, mail) — AUCUN appel provider/DNS réel.
 *
 * Les échecs injectés dans `persist` sont des échecs RÉELS PostgreSQL, jamais
 * un mock de la settle ni de la TX :
 *  • createProject → ConflictException de la garde de divergence concurrente
 *    (row insérée PENDANT l'appel provider) ;
 *  • createGitApp → verrou `SELECT … FOR UPDATE` sur la row Deployment tenu par
 *    une SECONDE connexion → la settle bloque dans `persist` → timeout Prisma
 *    (P2028) → rollback TX réel ;
 *  • DNS → violation d'unicité RÉELLE sur `ClientSubdomain.fqdn` (row insérée
 *    PENDANT l'appel provider) → P2002 dans `persist` → rollback TX réel.
 *
 * Cas couverts par opération : réponse provider réussie (persist committé),
 * stop/OFF avant consignation (barrière / consignation tardive + gel),
 * échec injecté dans persist APRÈS la première écriture de la TX (rollback :
 * tentative toujours DISPATCHED, aucune écriture partielle, aucun appel
 * suivant, aucun `deploy.failed` — sauf contrat HALT ON sans arrêt, documenté).
 */
describe('C4 rollback intégration PostgreSQL réel — createProject / createGitApp / DNS (e2e c4test)', () => {
  process.env.HOSTING_C2_ENABLED = 'true';
  process.env.HOSTING_C4_ENABLED = 'true';
  installFingerprintEnv();

  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: CryptoService;
  let c4: C4ProtocolService;

  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const adminEmail = `rbadmin_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';

  let srvId = '';
  let modId = '';
  let packId = '';
  let productId = '';
  let domainId = '';
  let domainName = '';
  const caseEmails: string[] = [];
  const serviceIds: string[] = [];
  const subIds: string[] = [];

  // Détails de gel — miroir exact des constantes privées de DeploymentsService.
  const FROZEN_DETAIL =
    'Création confirmée puis figée (barrière de sécurité) — identifiants conservés, aucune opération supplémentaire. Contactez le support.';
  const FROZEN_SETTLE_FAILED_DETAIL =
    'Création confirmée puis figée (barrière de sécurité) — consignation ANNULÉE (transaction échouée), identifiants NON enregistrés, aucune opération supplémentaire. Contactez le support.';

  // ── Portes (hang) contrôlables pendant l'appel provider ──────────────────
  type GateKey = 'proj' | 'git' | 'rec';
  type GateState = { armed: boolean; hung: boolean; release: (() => void) | null };
  const freshGate = (): GateState => ({ armed: false, hung: false, release: null });
  const gates: Record<GateKey, GateState> = { proj: freshGate(), git: freshGate(), rec: freshGate() };
  const armGate = (k: GateKey): void => {
    gates[k] = { armed: true, hung: false, release: null };
  };
  const fireGate = (k: GateKey): void => {
    const g = gates[k];
    if (g.release) g.release();
  };
  async function passGate(k: GateKey): Promise<void> {
    const g = gates[k];
    if (!g.armed) return;
    g.hung = true;
    await new Promise<void>((res) => {
      g.release = res;
    });
    g.armed = false;
  }

  // ── Hooks exécutés DANS l'appel provider (injections mid-flight) ─────────
  type HookKey = 'proj' | 'git' | 'find' | 'create';
  type HookFn = (arg?: unknown) => void | Promise<void>;
  let hooks: Partial<Record<HookKey, HookFn>> = {};
  const setHook = (k: HookKey, fn?: HookFn): void => {
    hooks = { ...hooks, [k]: fn };
    if (!fn) delete hooks[k];
  };

  let projSeq = 0;
  let gitSeq = 0;
  let recSeq = 0;
  const fakeVerify = jest.fn().mockResolvedValue({ ok: true, detail: 'FAKE PANEL OK' });
  const fakeCreateProject = jest.fn(async () => {
    if (hooks.proj) await hooks.proj();
    await passGate('proj');
    projSeq += 1;
    return { uuid: `proj-rb-${projSeq}`, name: `Projet ${projSeq}` };
  });
  const fakeCreateGitApp = jest.fn(async () => {
    if (hooks.git) await hooks.git();
    await passGate('git');
    gitSeq += 1;
    return { uuid: `app-rb-${gitSeq}` };
  });
  const fakeSetAppDomain = jest.fn().mockResolvedValue(undefined);
  const fakeDeployApp = jest.fn().mockResolvedValue(undefined);
  const fakeApplyAppLimits = jest.fn().mockResolvedValue(undefined);
  const fakeSetAppEnvironment = jest.fn().mockResolvedValue(undefined);
  const fakeFindRecordByName = jest.fn(async (_t: unknown, _z: unknown, fqdn: unknown) => {
    if (hooks.find) await hooks.find(fqdn);
    return null;
  });
  const fakeCreateRecord = jest.fn(async (_t: unknown, _z: unknown, rec: { name: string }) => {
    if (hooks.create) await hooks.create(rec);
    await passGate('rec');
    recSeq += 1;
    return `fake-rec-rb-${recSeq}`;
  });
  const fakeCfTransport = {
    findRecordByName: fakeFindRecordByName,
    createRecord: fakeCreateRecord,
    deleteRecord: jest.fn().mockResolvedValue(undefined),
    listZones: jest.fn().mockResolvedValue([]),
  };
  const fakeFactory = {
    create: (): PanelTransport =>
      ({
        verify: fakeVerify,
        createGitApp: fakeCreateGitApp,
        createProject: fakeCreateProject,
        listProjects: jest.fn().mockResolvedValue([]),
        listServers: jest.fn().mockResolvedValue([]),
        deployApp: fakeDeployApp,
        applyAppLimits: fakeApplyAppLimits,
        setAppEnvironment: fakeSetAppEnvironment,
        applyNodePort: jest.fn().mockResolvedValue(undefined),
        resolveExposedPort: jest.fn().mockResolvedValue(null),
        setAppDomain: fakeSetAppDomain,
        deleteApplication: jest.fn().mockResolvedValue(undefined),
        deploymentStatus: jest.fn().mockResolvedValue({ rawStatus: 'finished' }),
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
    detectRepo: jest.fn(async (url: string) => ({
      valid: true,
      repoUrl: url,
      repoFullName: 'owner/demo',
      defaultBranch: 'main',
      language: 'TypeScript',
      suggestedBuildPack: 'nixpacks',
    })),
    deriveRepoFullName: jest.fn(() => 'owner/demo'),
  } as never as GithubService;

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };

  async function waitFor<T>(
    label: string,
    fn: () => Promise<T>,
    pred: (t: T) => boolean,
    timeoutMs = 30_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        const value = await fn();
        if (pred(value)) return value;
        last = value;
      } catch (err) {
        last = err;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `Timeout (${timeoutMs} ms) waiting for ${label} — last=${JSON.stringify(last) ?? String(last)}`,
    );
  }

  async function setDeployEnabled(on: boolean): Promise<void> {
    const row = await prisma.securitySetting.findFirst();
    if (row) {
      await prisma.securitySetting.update({ where: { id: row.id }, data: { deployEnabled: on } });
    } else {
      await prisma.securitySetting.create({ data: { deployEnabled: on } });
    }
  }

  const post = (tkn: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/deployments`)
      .set('Authorization', `Bearer ${tkn}`)
      .send(body);

  /**
   * POST démarré IMMÉDIATEMENT (superagent est paresseux : la requête n'est
   * émise qu'au premier `.then`) — indispensable pour les tests qui attendent
   * un appel provider en vol sans consommer la réponse.
   */
  const postStarted = (tkn: string, body: Record<string, unknown>) => {
    let res: request.Response | null = null;
    const done = post(tkn, body).then((r) => {
      res = r;
      return r;
    });
    return { done, early: () => res };
  };

  const attemptsOf = (depId: string) =>
    prisma.c4ProviderAttempt.findMany({
      where: { scopeType: 'DEPLOYMENT', scopeId: depId },
      orderBy: { dispatchedAt: 'asc' },
    });
  type AttemptRow = Awaited<ReturnType<typeof attemptsOf>>[number];
  const intentOf = (a: AttemptRow): { type?: string; op?: string } =>
    (a.targetIntent ?? {}) as { type?: string; op?: string };
  const projectAttempt = (list: AttemptRow[]) =>
    list.find((a) => a.nature === 'CREATE' && intentOf(a).type === 'project');
  const appAttempt = (list: AttemptRow[]) =>
    list.find((a) => a.nature === 'CREATE' && intentOf(a).type === 'application');
  const dnsAttempt = (list: AttemptRow[]) =>
    list.find((a) => a.nature === 'CONFIGURE' && intentOf(a).op === 'allocate_dns');
  const identifiersOf = (a: AttemptRow): Record<string, unknown> =>
    (a.returnedIdentifiers ?? {}) as Record<string, unknown>;

  const auditCount = (action: string, depId?: string) =>
    prisma.auditLog.count({ where: { action, ...(depId ? { resourceId: depId } : {}) } });

  const depOf = (email: string) =>
    prisma.deployment.findFirst({ where: { user: { email } }, orderBy: { createdAt: 'desc' } });

  const allocOfCid = (cid: string) =>
    prisma.hostingServiceAllocation.findFirst({ where: { idempotencyKey: { contains: cid } } });

  const consuming = (svcId: string) =>
    prisma.hostingServiceAllocation.count({
      where: {
        hostingServiceId: svcId,
        status: { in: [...CONSUMING_ALLOCATION_STATUSES] },
      },
    });

  /** Verrou row `Deployment` tenu par une SECONDE connexion réelle (non mocké). */
  async function holdDeploymentLock(depId: string): Promise<() => Promise<void>> {
    let acquired!: () => void;
    const acq = new Promise<void>((res) => {
      acquired = res;
    });
    let release!: () => void;
    const rel = new Promise<void>((res) => {
      release = res;
    });
    const tx = prisma.$transaction(
      async (t) => {
        await t.$queryRaw`SELECT "id" FROM "Deployment" WHERE "id" = ${depId} FOR UPDATE`;
        acquired();
        await rel;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await acq;
    return async () => {
      release();
      await tx;
    };
  }

  /**
   * Session en attente d'un verrou `UPDATE "Deployment"` (le conflit de row
   * lock apparaît comme `locktype=transactionid` avec `relation` NULL dans
   * pg_locks — on détecte via pg_stat_activity.wait_event_type='Lock').
   */
  const deployLockWaiters = () =>
    prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND state = 'active'
        AND pid <> pg_backend_pid()
        AND query ILIKE '%UPDATE%Deployment%'`;

  // ── Fixture par cas : UN utilisateur + UN service + UNE souscription ─────
  async function mkCase(tag: string): Promise<{
    email: string;
    token: string;
    svcId: string;
    userId: string;
  }> {
    const email = `rb_${tag}_${stamp}@example.com`;
    const user = await prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash(password, 10), role: Role.USER },
    });
    caseEmails.push(email);
    await prisma.user.update({
      where: { id: user.id },
      data: { githubTokenEnc: crypto.encrypt('gh-token-fake') },
    });
    const sub = await prisma.subscription.create({
      data: { userId: user.id, productId, status: SubscriptionStatus.ACTIVE },
    });
    subIds.push(sub.id);
    const svc = await prisma.hostingService.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        productId,
        packId,
        deploymentModuleId: modId,
        status: HostingServiceStatus.ACTIVE,
        maxAppsSnapshot: null,
        ramMbSnapshot: 512,
        cpuCoresSnapshot: 1,
        storageLimitGbSnapshot: null,
        packNameSnapshot: `rb-pack-${stamp}`,
        productNameSnapshot: `rb-prod-${stamp}`,
      },
    });
    serviceIds.push(svc.id);
    const token = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email, password })
        .expect(201)
    ).body.accessToken as string;
    return { email, token, svcId: svc.id, userId: user.id };
  }

  const deployBody = (
    svcId: string,
    subdomain?: string,
  ): Record<string, unknown> => ({
    repoFullName: 'owner/demo',
    branch: 'main',
    clientRequestId: newClientRequestId(),
    hostingServiceId: svcId,
    ...(subdomain ? { subdomain } : {}),
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransportFactory)
      .useValue(mailFactoryStub)
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
    c4 = moduleRef.get(C4ProtocolService);
    moduleRef.get(SaRateLimiter).reset();

    // Garde d'identité : JAMAIS la base live, JAMAIS une autre base isolée.
    const dbs = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
    if (dbs[0]?.db !== 'icode_host_pro_c4test') {
      throw new Error(
        `Base "${dbs[0]?.db}" inattendue — ce spec n'écrit QUE sur icode_host_pro_c4test.`,
      );
    }

    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
      },
    });
    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;

    const server = await prisma.server.create({
      data: {
        name: `rb-srv-${stamp}`,
        hostname: 'panel.rb.test',
        panelProvider: 'COOLIFY',
        apiBaseUrl: 'http://panel.rb.test:8000/api/v1',
        apiTokenEnc: null,
        strictTls: true,
        coolifyServerUuid: `srv-rb-${stamp}`,
      },
    });
    srvId = server.id;
    await prisma.server.update({
      where: { id: srvId },
      data: { apiTokenEnc: crypto.encrypt('fake-coolify-token') },
    });
    // Vérification panneau (flag panelVerifiedAt/Ok) — transport simulé.
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers/${srvId}/panel-verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    const mod = await prisma.deploymentModule.create({
      data: {
        name: `rb-mod-${stamp}`,
        code: `RB${stamp}`,
        kind: 'PER_CLIENT_PROJECT',
        perClientPrefix: 'client',
        serverId: srvId,
      },
    });
    modId = mod.id;

    const pack = await prisma.hostingPack.create({
      data: {
        name: `rb-pack-${stamp}`,
        ramMb: 512,
        cpuCores: 1,
        storageLimit: null,
        maxApps: 5,
        deploymentModuleId: modId,
      },
    });
    packId = pack.id;

    const product = await prisma.product.create({
      data: {
        name: `rb-prod-${stamp}`,
        slug: `rb-prod-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 4900,
        packId,
      },
    });
    productId = product.id;

    domainName = `rb-${stamp}.test`;
    const domain = await prisma.domain.create({
      data: {
        name: domainName,
        zoneId: `zone-rb-${stamp}`,
        status: 'ACTIVE',
        cnameTarget: 'fallback.example.net',
      },
    });
    domainId = domain.id;
    await prisma.cloudflareSetting.create({
      data: {
        apiTokenEnc: crypto.encrypt('fake-cf-token'),
        accountEmail: `rb-${stamp}@example.com`,
        rootDomainId: domainId,
      },
    });

    await setDeployEnabled(true);
  });

  afterAll(async () => {
    await setDeployEnabled(false);
    // Nettoyage LIMITÉ aux fixtures créées par CETTE suite (aucune purge
    // globale des tables C4) : ids dérivés des users/services suivis ci-dessus.
    const caseUsers: { id: string }[] = await prisma.user
      .findMany({ where: { email: { in: caseEmails } }, select: { id: true } })
      .catch(() => []);
    const caseUserIds = caseUsers.map((u) => u.id);
    const caseDeps: { id: string; orderId: string | null }[] = await prisma.deployment
      .findMany({ where: { userId: { in: caseUserIds } }, select: { id: true, orderId: true } })
      .catch(() => []);
    const caseDepIds = caseDeps.map((d) => d.id);
    const caseOrderIds = caseDeps.map((d) => d.orderId).filter((x): x is string => !!x);
    const caseAllocs: { id: string }[] = await prisma.hostingServiceAllocation
      .findMany({ where: { hostingServiceId: { in: serviceIds } }, select: { id: true } })
      .catch(() => []);
    const caseAllocIds = caseAllocs.map((a) => a.id);
    const caseScopeIds = [...caseDepIds, ...caseOrderIds, ...caseAllocIds, ...serviceIds];
    await prisma.c4ProviderAttempt
      .deleteMany({
        where: {
          OR: [
            { scopeType: 'DEPLOYMENT', scopeId: { in: caseDepIds } },
            { allocationId: { in: caseAllocIds } },
            { orderId: { in: caseOrderIds } },
          ],
        },
      })
      .catch(() => {});
    await prisma.c4StopRequest
      .deleteMany({ where: { scopeType: 'SERVICE', scopeId: { in: serviceIds } } })
      .catch(() => {});
    await prisma.c4Takeover.deleteMany({ where: { scopeId: { in: caseScopeIds } } }).catch(() => {});
    await prisma.c4ReleaseEvidence
      .deleteMany({ where: { allocationId: { in: caseAllocIds } } })
      .catch(() => {});
    await prisma.c4ReadinessProof
      .deleteMany({
        where: { OR: [{ orderId: { in: caseOrderIds } }, { deploymentId: { in: caseDepIds } }] },
      })
      .catch(() => {});
    await prisma.clientSubdomain.deleteMany({ where: { domainId } }).catch(() => {});
    await prisma.hostingServiceAllocation
      .deleteMany({ where: { hostingServiceId: { in: serviceIds } } })
      .catch(() => {});
    await prisma.deployment.deleteMany({ where: { user: { email: { in: caseEmails } } } }).catch(
      () => {},
    );
    await prisma.hostingService.deleteMany({ where: { id: { in: serviceIds } } }).catch(() => {});
    await prisma.subscription.deleteMany({ where: { id: { in: subIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, ...caseEmails] } } }).catch(
      () => {},
    );
    await prisma.cloudflareSetting.deleteMany({ where: { accountEmail: `rb-${stamp}@example.com` } }).catch(() => {});
    await prisma.domain.deleteMany({ where: { id: domainId } }).catch(() => {});
    await prisma.product.deleteMany({ where: { id: productId } }).catch(() => {});
    await prisma.hostingPack.deleteMany({ where: { id: packId } }).catch(() => {});
    await prisma.deploymentModule.deleteMany({ where: { id: modId } }).catch(() => {});
    await prisma.server.deleteMany({ where: { id: srvId } }).catch(() => {});

    delete process.env.HOSTING_C2_ENABLED;
    delete process.env.HOSTING_C4_ENABLED;
    removeFingerprintEnv();
    await app.close();
  });

  beforeEach(() => {
    // Compteurs d'appels ZÉROS par test (implémentations/mockResolvedValue
    // conservés — clear, pas reset).
    jest.clearAllMocks();
    hooks = {};
    for (const k of Object.keys(gates) as GateKey[]) {
      gates[k] = freshGate();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 1 — réponse provider réussie : les trois ops consignées + persist committé
  // ═══════════════════════════════════════════════════════════════════════
  it('réponse provider réussie : createProject + createGitApp + DNS consignés, persist ATOMIQUE committé', async () => {
    const c = await mkCase('t1');
    const sub = `rbt1${stamp}`;
    const cid = newClientRequestId();
    const res = await post(c.token, {
      repoFullName: 'owner/demo',
      branch: 'main',
      clientRequestId: cid,
      hostingServiceId: c.svcId,
      subdomain: sub,
    }).expect(201);
    const depId = res.body.id as string;
    expect(res.body.status).toBe('DEPLOYING');

    const dep = await prisma.deployment.findUniqueOrThrow({ where: { id: depId } });
    const attempts = await attemptsOf(depId);

    // createProject : consignation + ClientProject + liens Deployment dans LA TX.
    const pa = projectAttempt(attempts);
    expect(pa).toBeTruthy();
    expect(pa!.phase).toBe('RETURNED');
    expect(pa!.outcome).toBe('SUCCESS');
    const projUuid = identifiersOf(pa!).projectUuid as string;
    expect(projUuid).toBeTruthy();
    expect(dep.coolifyProjectUuid).toBe(projUuid);
    expect(dep.clientProjectId).toBeTruthy();
    const cp = await prisma.clientProject.findUnique({ where: { id: dep.clientProjectId! } });
    expect(cp?.projectUuid).toBe(projUuid);

    // createGitApp : consignation + coolifyUuid persisté dans LA TX.
    const ga = appAttempt(attempts);
    expect(ga).toBeTruthy();
    expect(ga!.phase).toBe('RETURNED');
    expect(ga!.outcome).toBe('SUCCESS');
    const appUuid = identifiersOf(ga!).uuid as string;
    expect(appUuid).toBeTruthy();
    expect(dep.coolifyUuid).toBe(appUuid);

    // DNS : consignation + row ClientSubdomain + fqdn/recordId persistés.
    const da = dnsAttempt(attempts);
    expect(da).toBeTruthy();
    expect(da!.phase).toBe('RETURNED');
    expect(da!.outcome).toBe('SUCCESS');
    const ids = identifiersOf(da!);
    expect(ids.fqdn).toBe(`${sub}.${domainName}`);
    expect(ids.recordId).toBeTruthy();
    expect(dep.fqdn).toBe(`${sub}.${domainName}`);
    const cs = await prisma.clientSubdomain.findFirst({ where: { deploymentId: depId } });
    expect(cs?.fqdn).toBe(`${sub}.${domainName}`);
    expect(cs?.recordId).toBe(ids.recordId);

    // Aucune tentative laissée ouverte / ambiguë sur ce déploiement.
    expect(attempts.filter((a) => a.phase === 'DISPATCHED')).toHaveLength(0);
    expect(
      attempts.filter((a) => a.outcome === 'UNKNOWN' || a.outcome === 'FAILED_RETRYABLE'),
    ).toHaveLength(0);

    // Cycle métier complet : allocation liée, quota consommé, audit de succès.
    const alloc = await allocOfCid(cid);
    expect(alloc?.status).toBe('BOUND');
    expect(alloc?.deploymentId).toBe(depId);
    expect(await consuming(c.svcId)).toBe(1);
    expect(await auditCount('deploy.create', depId)).toBe(1);
    expect(await auditCount('deploy.failed', depId)).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2 — createProject : stop pendant l'appel → consignation tardive + gel
  // ═══════════════════════════════════════════════════════════════════════
  it('createProject — stop pendant l\'appel : consignation SUCCESS + persistés, gel SANS transition, AUCUN appel suivant', async () => {
    const c = await mkCase('t2');
    setHook('proj', async () => {
      await c4.requestStop({ scope: { type: 'SERVICE', id: c.svcId }, reason: 'e2e t2' });
    });
    const cid = newClientRequestId();
    const res = await post(c.token, {
      repoFullName: 'owner/demo',
      branch: 'main',
      clientRequestId: cid,
      hostingServiceId: c.svcId,
    }).expect(201);
    const depId = res.body.id as string;

    const dep = await prisma.deployment.findUniqueOrThrow({ where: { id: depId } });
    const attempts = await attemptsOf(depId);

    // Consignation TARDIVE effectuée (arrêt pendant l'appel n'autorise que
    // elle) : identifiants réellement persistés, puis gel SANS transition.
    const pa = projectAttempt(attempts);
    expect(pa!.phase).toBe('RETURNED');
    expect(pa!.outcome).toBe('SUCCESS');
    expect(dep.coolifyProjectUuid).toBe(identifiersOf(pa!).projectUuid);
    expect(dep.clientProjectId).toBeTruthy();

    // Gel : SEUL le détail change — aucun statut métier, aucun appel suivant.
    expect(dep.status).toBe('PENDING');
    expect(dep.detail).toBe(FROZEN_DETAIL);
    expect(dep.coolifyUuid).toBeNull();
    expect(fakeCreateGitApp).toHaveBeenCalledTimes(0);
    expect(fakeDeployApp).toHaveBeenCalledTimes(0);

    const alloc = await allocOfCid(cid);
    expect(alloc?.status).toBe('RESERVED');
    expect(alloc?.deploymentId).toBeNull();
    expect(await auditCount('deploy.create', depId)).toBe(0);
    expect(await auditCount('deploy.failed', depId)).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3 — createProject : échec RÉEL dans persist (divergence) → rollback TX
  // ═══════════════════════════════════════════════════════════════════════
  it('createProject — échec injecté dans persist (divergence concurrente réelle) + stop : rollback TX, tentative DISPATCHED, aucune écriture partielle', async () => {
    const c = await mkCase('t3');
    armGate('proj');
    setHook('proj', undefined);
    const cid = newClientRequestId();
    const p = postStarted(c.token, {
      repoFullName: 'owner/demo',
      branch: 'main',
      clientRequestId: cid,
      hostingServiceId: c.svcId,
    });

    // T1 : appel provider en vol (tentative CREATE committée, row projet absente).
    await waitFor(
      'createProject en vol',
      async () => ({ hung: gates.proj.hung, dep: await depOf(c.email), res: p.early() }),
      (v) => (v.res ? true : v.hung && !!v.dep),
      10_000,
    );
    const early = p.early();
    if (early) {
      throw new Error(`POST terminé sans hang (${early.status}) : ${JSON.stringify(early.body)}`);
    }
    const depRow = await depOf(c.email);
    const depId = depRow!.id;

    // Injection : row CONCURRENTE divergente + ARRÊT, posés PENDANT l'appel.
    await prisma.clientProject.create({
      data: {
        userId: c.userId,
        serverId: srvId,
        moduleId: modId,
        name: 'divergent-rb',
        projectUuid: 'divergent-proj-uuid',
      },
    });
    await c4.requestStop({ scope: { type: 'SERVICE', id: c.svcId }, reason: 'e2e t3' });
    fireGate('proj');

    const res = await p.done;
    expect(res.status).toBe(201);

    // Rollback TX réel : la tentative est revenue DISPATCHED (update d'identité
    // annulée), AUCUN identifiant prétendu, SEULE la row fixture existe.
    const attempts = await attemptsOf(depId);
    const pa = projectAttempt(attempts);
    expect(pa).toBeTruthy();
    expect(pa!.phase).toBe('DISPATCHED');
    expect(pa!.outcome).toBeNull();
    expect(pa!.returnedIdentifiers).toBeNull();

    const dep = await prisma.deployment.findUniqueOrThrow({ where: { id: depId } });
    expect(dep.coolifyProjectUuid).toBeNull();
    expect(dep.clientProjectId).toBeNull();
    expect(dep.status).toBe('PENDING');
    expect(dep.detail).toBe(FROZEN_SETTLE_FAILED_DETAIL);

    const cps = await prisma.clientProject.findMany({ where: { userId: c.userId } });
    expect(cps).toHaveLength(1);
    expect(cps[0].projectUuid).toBe('divergent-proj-uuid');

    // Aucun appel suivant (createGitApp jamais atteint) et aucun deploy.failed.
    expect(fakeCreateGitApp).toHaveBeenCalledTimes(0);
    const alloc = await allocOfCid(cid);
    expect(alloc?.status).toBe('RESERVED');
    expect(await auditCount('deploy.create', depId)).toBe(0);
    expect(await auditCount('deploy.failed', depId)).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4 — createGitApp : stop pendant l'appel → consignation tardive + gel
  // ═══════════════════════════════════════════════════════════════════════
  it('createGitApp — stop pendant l\'appel : UUID consigné + persisté, gel SANS transition, allocation JAMAIS liée', async () => {
    const c = await mkCase('t4');
    setHook('git', async () => {
      await c4.requestStop({ scope: { type: 'SERVICE', id: c.svcId }, reason: 'e2e t4' });
    });
    const cid = newClientRequestId();
    const res = await post(c.token, {
      repoFullName: 'owner/demo',
      branch: 'main',
      clientRequestId: cid,
      hostingServiceId: c.svcId,
    }).expect(201);
    const depId = res.body.id as string;

    const dep = await prisma.deployment.findUniqueOrThrow({ where: { id: depId } });
    const attempts = await attemptsOf(depId);
    const ga = appAttempt(attempts);
    expect(ga).toBeTruthy();
    expect(ga!.phase).toBe('RETURNED');
    expect(ga!.outcome).toBe('SUCCESS');
    expect(dep.coolifyUuid).toBe(identifiersOf(ga!).uuid);

    // Gel post-appel : aucun flip métier, aucune opération suivante.
    expect(dep.status).toBe('PENDING');
    expect(dep.detail).toBe(FROZEN_DETAIL);
    expect(fakeSetAppDomain).toHaveBeenCalledTimes(0);
    expect(fakeDeployApp).toHaveBeenCalledTimes(0);
    expect(fakeApplyAppLimits).toHaveBeenCalledTimes(0);
    expect(fakeFindRecordByName).toHaveBeenCalledTimes(0);

    const alloc = await allocOfCid(cid);
    expect(alloc?.status).toBe('RESERVED'); // markBound JAMAIS tourné
    expect(alloc?.deploymentId).toBeNull();
    expect(await auditCount('deploy.create', depId)).toBe(0);
    expect(await auditCount('deploy.failed', depId)).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5 — createGitApp : échec RÉEL dans persist (verrou FOR UPDATE → P2028)
  // ═══════════════════════════════════════════════════════════════════════
  it('createGitApp — échec injecté dans persist (verrou row réel → timeout Prisma) + stop : rollback TX, DISPATCHED, aucun deploy.failed', async () => {
    const c = await mkCase('t5');
    armGate('git');
    const cid = newClientRequestId();
    const p = postStarted(c.token, {
      repoFullName: 'owner/demo',
      branch: 'main',
      clientRequestId: cid,
      hostingServiceId: c.svcId,
    });

    // Appel provider en vol : tentative CREATE committée, projet déjà consigné.
    await waitFor(
      'createGitApp en vol',
      async () => ({ hung: gates.git.hung, dep: await depOf(c.email), res: p.early() }),
      (v) => (v.res ? true : v.hung && !!v.dep),
      10_000,
    );
    const early5 = p.early();
    if (early5) {
      throw new Error(`POST terminé sans hang (${early5.status}) : ${JSON.stringify(early5.body)}`);
    }
    const depId = (await depOf(c.email))!.id;

    // Verrou row Deployment par une SECONDE connexion réelle + ARRÊT, puis
    // libération de l'appel : la settle SUCCESS se bloque dans `persist`.
    const unlock = await holdDeploymentLock(depId);
    await c4.requestStop({ scope: { type: 'SERVICE', id: c.svcId }, reason: 'e2e t5' });
    fireGate('git');

    try {
      // La settle TX attend la row verrouillée (file d'attente Postgres réelle)…
      await waitFor(
        'settle bloquée sur le verrou Deployment',
        deployLockWaiters,
        (v) => (v[0]?.n ?? 0) >= 1,
        15_000,
      );
      // …puis meurt au timeout Prisma (~5 s) : on relâche APRÈS l'échec TX,
      // pour que le gel (seule écriture restante) puisse s'appliquer.
      await new Promise((r) => setTimeout(r, 6_000));
    } finally {
      await unlock();
    }

    const res = await p.done;
    expect(res.status).toBe(201);

    // Rollback TX réel : update tentative + update coolifyUuid ANNULÉS.
    const attempts = await attemptsOf(depId);
    const ga = appAttempt(attempts);
    expect(ga).toBeTruthy();
    expect(ga!.phase).toBe('DISPATCHED');
    expect(ga!.outcome).toBeNull();
    expect(ga!.returnedIdentifiers).toBeNull();

    const dep = await prisma.deployment.findUniqueOrThrow({ where: { id: depId } });
    expect(dep.coolifyUuid).toBeNull(); // identifiant JAMAIS prétendu enregistré
    expect(dep.status).toBe('PENDING'); // stop actif → absorbé, JAMAIS de FAILED
    expect(dep.detail).toBe(FROZEN_SETTLE_FAILED_DETAIL);

    // Aucune opération suivante, aucun deploy.failed (absorbé par l'arrêt).
    expect(fakeSetAppDomain).toHaveBeenCalledTimes(0);
    expect(fakeDeployApp).toHaveBeenCalledTimes(0);
    expect(fakeFindRecordByName).toHaveBeenCalledTimes(0);
    expect(fakeApplyAppLimits).toHaveBeenCalledTimes(0);
    const alloc = await allocOfCid(cid);
    expect(alloc?.status).toBe('RESERVED');
    expect(await auditCount('deploy.create', depId)).toBe(0);
    expect(await auditCount('deploy.failed', depId)).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6 — DNS : stop pendant la LECTURE → barrière READ→CREATE → REFUSED
  // ═══════════════════════════════════════════════════════════════════════
  it('DNS — stop pendant la lecture (barrière READ→CREATE) : tentative REFUSED, AUCUNE row/record, aucune opération suivante', async () => {
    const c = await mkCase('t6');
    const sub = `rbt6${stamp}`;
    setHook('find', async () => {
      await c4.requestStop({ scope: { type: 'SERVICE', id: c.svcId }, reason: 'e2e t6' });
    });
    const cid = newClientRequestId();
    const res = await post(c.token, {
      repoFullName: 'owner/demo',
      branch: 'main',
      clientRequestId: cid,
      hostingServiceId: c.svcId,
      subdomain: sub,
    }).expect(201);
    const depId = res.body.id as string;

    const dep = await prisma.deployment.findUniqueOrThrow({ where: { id: depId } });
    const attempts = await attemptsOf(depId);
    const da = dnsAttempt(attempts);
    expect(da).toBeTruthy();
    expect(da!.phase).toBe('RETURNED');
    expect(da!.outcome).toBe('REFUSED'); // terminale SÛRE : aucune ressource créée
    expect(identifiersOf(da!).reason).toBe('barrier_during_read');

    // AUCUNE création réseau/locale : createRecord jamais appelé, zéro row.
    expect(fakeCreateRecord).toHaveBeenCalledTimes(0);
    expect(await prisma.clientSubdomain.count({ where: { deploymentId: depId } })).toBe(0);
    expect(dep.fqdn).toBeNull();
    expect(dep.subdomain).toBeNull();

    // Gel SANS transition ni appel suivant (setAppDomain/run jamais atteints).
    expect(dep.status).toBe('PENDING');
    expect(dep.detail).toBe(FROZEN_DETAIL);
    expect(fakeSetAppDomain).toHaveBeenCalledTimes(0);
    expect(fakeDeployApp).toHaveBeenCalledTimes(0);
    expect(await auditCount('deploy.domain', depId)).toBe(0);
    expect(await auditCount('deploy.failed', depId)).toBe(0);

    const alloc = await allocOfCid(cid);
    expect(alloc?.status).toBe('BOUND'); // liée au createGitApp réussi (état antérieur au DNS)
    expect(await auditCount('deploy.create', depId)).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7 — DNS : échec RÉEL dans persist (P2002 fqdn) → rollback TX réel
  // ═══════════════════════════════════════════════════════════════════════
  it('DNS — échec injecté dans persist (unicité fqdn réelle → P2002) + stop : rollback TX, DISPATCHED, aucune row partielle', async () => {
    const c = await mkCase('t7');
    const sub = `rbt7${stamp}`;
    let conflictFqdn = '';
    setHook('create', async (arg) => {
      const rec = arg as { name: string };
      conflictFqdn = rec.name;
      // Row CONCURRENTE sur le MÊME fqdn + ARRÊT, posés PENDANT l'appel.
      await prisma.clientSubdomain.create({
        data: {
          subdomain: sub,
          domainId,
          fqdn: rec.name,
          status: 'CREATED',
          deploymentId: null,
        },
      });
      await c4.requestStop({ scope: { type: 'SERVICE', id: c.svcId }, reason: 'e2e t7' });
    });
    const cid = newClientRequestId();
    const res = await post(c.token, {
      repoFullName: 'owner/demo',
      branch: 'main',
      clientRequestId: cid,
      hostingServiceId: c.svcId,
      subdomain: sub,
    }).expect(201);
    const depId = res.body.id as string;
    expect(conflictFqdn).toBe(`${sub}.${domainName}`);

    // Rollback TX réel : tentative DISPATCHED (update annulée), row de la
    // settle JAMAIS persistée — SEULE la row fixture existe sur ce fqdn.
    const attempts = await attemptsOf(depId);
    const da = dnsAttempt(attempts);
    expect(da).toBeTruthy();
    expect(da!.phase).toBe('DISPATCHED');
    expect(da!.outcome).toBeNull();
    expect(da!.returnedIdentifiers).toBeNull();

    const rowsOnFqdn = await prisma.clientSubdomain.findMany({ where: { fqdn: conflictFqdn } });
    expect(rowsOnFqdn).toHaveLength(1);
    expect(rowsOnFqdn[0].deploymentId).toBeNull(); // jamais liée par la settle annulée

    const dep = await prisma.deployment.findUniqueOrThrow({ where: { id: depId } });
    expect(dep.fqdn).toBeNull();
    expect(dep.subdomain).toBeNull();
    expect(dep.status).toBe('PENDING');
    expect(dep.detail).toBe(FROZEN_SETTLE_FAILED_DETAIL);

    // Gel : aucun appel suivant, aucun deploy.failed.
    expect(fakeSetAppDomain).toHaveBeenCalledTimes(0);
    expect(fakeDeployApp).toHaveBeenCalledTimes(0);
    expect(await auditCount('deploy.domain', depId)).toBe(0);
    expect(await auditCount('deploy.create', depId)).toBe(0);
    expect(await auditCount('deploy.failed', depId)).toBe(0);
    const alloc = await allocOfCid(cid);
    expect(alloc?.status).toBe('BOUND'); // état antérieur au DNS, inchangé
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8 — createGitApp : même échec persist SANS arrêt → contrat HALT ON
  //      (rollback TX + FAILED + deploy.failed, tentative TOUJOURS bloquante)
  // ═══════════════════════════════════════════════════════════════════════
  it('createGitApp — échec persist SANS arrêt : rollback TX réel + contrat HALT ON (502, FAILED, deploy.failed, tentative DISPATCHED)', async () => {
    const c = await mkCase('t8');
    armGate('git');
    const cid = newClientRequestId();
    const p = postStarted(c.token, {
      repoFullName: 'owner/demo',
      branch: 'main',
      clientRequestId: cid,
      hostingServiceId: c.svcId,
    });
    await waitFor(
      'createGitApp en vol (t8)',
      async () => ({ hung: gates.git.hung, dep: await depOf(c.email), res: p.early() }),
      (v) => (v.res ? true : v.hung && !!v.dep),
      10_000,
    );
    const early8 = p.early();
    if (early8) {
      throw new Error(`POST terminé sans hang (${early8.status}) : ${JSON.stringify(early8.body)}`);
    }
    const depId = (await depOf(c.email))!.id;

    const unlock = await holdDeploymentLock(depId);
    fireGate('git');
    try {
      await waitFor(
        'settle bloquée sur le verrou (t8)',
        deployLockWaiters,
        (v) => (v[0]?.n ?? 0) >= 1,
        15_000,
      );
      await new Promise((r) => setTimeout(r, 6_000));
    } finally {
      await unlock();
    }

    // Sans arrêt/OFF : échec de settle PROPAGÉ (contrat ON historique) →
    // catch général → 502 + FAILED + audit deploy.failed. Le rollback de la
    // settle reste intégral : tentative DISPATCHED, coolifyUuid jamais écrit.
    const res = await p.done;
    expect(res.status).toBe(502);

    const attempts = await attemptsOf(depId);
    const ga = appAttempt(attempts);
    expect(ga).toBeTruthy();
    expect(ga!.phase).toBe('DISPATCHED');
    expect(ga!.outcome).toBeNull();
    expect(ga!.returnedIdentifiers).toBeNull();

    const dep = await prisma.deployment.findUniqueOrThrow({ where: { id: depId } });
    expect(dep.coolifyUuid).toBeNull();
    expect(dep.status).toBe('FAILED'); // HALT ON documenté (sans arrêt)
    expect(await auditCount('deploy.failed', depId)).toBe(1);

    expect(fakeSetAppDomain).toHaveBeenCalledTimes(0);
    expect(fakeDeployApp).toHaveBeenCalledTimes(0);
    expect(fakeFindRecordByName).toHaveBeenCalledTimes(0);
    const alloc = await allocOfCid(cid);
    expect(alloc?.status).toBe('RESERVED'); // post-intention : jamais de libération
    expect(alloc?.deploymentId).toBeNull();
  });
});
