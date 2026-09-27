import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import {
  DeploymentStatus,
  HostingServiceAllocationStatus,
  HostingServiceStatus,
  OrderStatus,
  PaymentMethodType,
  ProvisionAction,
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
import { HostResolverFactory } from './../src/servers/host-resolver.factory';
import { CloudflareTransportFactory } from './../src/cloudflare/cloudflare.transport';
import { ProvisioningService } from './../src/store/provisioning.service';
import { OrderCancelService } from './../src/store/order-cancel.service';
import { DeploymentsService } from './../src/deployments/deployments.service';
import { SubscriptionsService } from './../src/subscriptions/subscriptions.service';
import { HostingServicesService } from './../src/hosting/hosting-services.service';
import { C4ProtocolService } from './../src/hosting/c4-protocol.service';
import { C4ReleaseService } from './../src/hosting/c4-release.service';
import { C4CapabilityService } from './../src/hosting/c4-capability.service';
import {
  installFingerprintEnv,
  newClientRequestId,
  removeFingerprintEnv,
  samplePayload,
} from './hosting-reservation.fixture';

/**
 * 17B.4F-C4 — e2e SUR BASE ISOLÉE (`icode_host_pro_c4test`, identité vérifiée)
 * avec `HOSTING_C3_ENABLED=true` + `HOSTING_C4_ENABLED=true`. Couvre le
 * protocole consolidé : tentatives durables, arrêt/cleanup/libération sous
 * preuves, finalize admin bornée, gate d'annulation D10, bascules ON/OFF.
 *
 * TOUT est stubé côté réseau (panel, Cloudflare transport, mail) — AUCUN appel
 * provider/DNS réel. PrismaService / CryptoService RÉELS sur base isolée ;
 * aucun `.env` n'est modifié (garde posées/enlevées dans le process de test).
 *
 * Scénarios :
 *  1. parcours ON complet : tentatives CREATE + CONFIGURE consignées,
 *     allocation BOUND, Order/Deployment/service ACTIFS ;
 *  2. ARRÊT pendant la création : consignation tardive de l'UUID conservée
 *     (jamais perdue), aucune opération ni flip, annulation post-arrêt →
 *     libérations concluantes → service CANCELLED ;
 *  3. timeout CREATE (transport simulé, base PostgreSQL réelle) → UNKNOWN
 *     DURABLE, aucun rejeu CREATE (0 appel réseau, 0 tentative ajoutée),
 *     aucun DELETE, aucun RELEASED ; libération bloquée call_uncertain ;
 *  4. delete : échec réseau → 502 sans suppression locale ; 404 absent →
 *     libération RELEASED + freedQuota honnête (D9) ; rejeu → already_released
 *     (une seule libération) ; tentative DELETE orpheline (crash) sans blocage ;
 *  5. pré-protocole : sans intention → pre_provider_released ; intention sans
 *     tentative CREATE → blocked pre_protocol_uncertain ;
 *  6. finalize admin : non-prêt → 409 zéro écriture → prêt → ACTIVE + preuve
 *     identity-bound → rejeu idempotent sans audit ; course séquentielle avec
 *     annulation → 409 ; course RÉELLE (promesses parallèles) → transitions
 *     exclusives, jamais de preuve sur commande CANCELLED ; ORDRE 1 finalize
 *     complet → annulation refusée ; ORDRE 2 annulation COMPLÈTE pendant le
 *     probe réseau (barrière observée) → finalize 409, zéro preuve ;
 *  7. D10 : annulation d'abonnement refusée tant qu'une allocation consomme
 *     ou qu'un service n'est pas terminé ;
 *  8. bascule OFF : zéro tentative nouvelle, arrêts/tentatives antérieurs
 *     intacts, remove OFF sans libération (contrat historique) ;
 *  9. arrêt AVANT dispatch : 0 appel réseau, 0 tentative, annulation → refus
 *     conservatoire pre_protocol_uncertain (slot conservé) ;
 * 10. settle APRÈS passage OFF (en vol) : identifiants consignés + persistés,
 *     AUCUNE transition métier, marqueur d'arrêt intact ;
 * 11. D6 : DNS échoue → slot conservé + rows ADRESSABLES ; échec injecté en
 *     TX finale → rollback conjoint (rows+preuve) ; rejeu de la même demande →
 *     app absente + DNS supprimé → UNE libération, preuve complète, aucun
 *     résidu non adressable ;
 * 12. suppressions concurrentes avec ORDRES OBSERVÉS : (a) séquentiel → 404,
 *     une seule preuve ; (b) intercalé derrière une barrière réseau → gagnant
 *     'released', perdant 'already_released', UNE seule preuve ;
 * 13. terminaison de service (vs suppression d'app) : stops + libérations +
 *     terminal CANCELLED sous preuves ;
 * 14. D10 avec ORDRES DÉMONTRÉS (annulation→réservation, réservation→
 *     annulation) + verrou FOR UPDATE OBSERVÉ (pg_locks granted=false) →
 *     jamais d'allocation consommante sur une souscription CANCELLED ;
 * 15. suspension admin (Subscription SUSPENDED) : AUCUN slot libéré, zéro
 *     preuve, D10 toujours opposable ensuite.
 */
describe('17B.4F-C4 — tentatives/libération/finalize (e2e base isolée c4test)', () => {
  process.env.HOSTING_C3_ENABLED = 'true';
  process.env.HOSTING_C4_ENABLED = 'true';
  installFingerprintEnv();

  let app: INestApplication;
  let prisma: PrismaService;
  let provisioning: ProvisioningService;
  let orderCancel: OrderCancelService;
  let deployments: DeploymentsService;
  let subscriptions: SubscriptionsService;
  let hosting: HostingServicesService;
  let c4: C4ProtocolService;
  let c4r: C4ReleaseService;
  let c4c: C4CapabilityService;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;
  const memberEmail = `c4member_${stamp}@example.com`;
  const member2Email = `c4member2_${stamp}@example.com`;
  const adminEmail = `c4admin_${stamp}@example.com`;
  const password = 'password123';
  let memberToken = '';
  let adminToken = '';
  let memberUserId = '';
  let member2UserId = '';
  let adminUserId = '';

  let srvId = '';
  let modId = '';
  let packId = '';
  let provId = '';
  let pmId = '';
  let prodId = '';
  let domainId = '';

  const allOrderIds: string[] = [];
  const serviceIds: string[] = [];
  const allocIds: string[] = [];
  const subIds: string[] = [];
  let t3OrderId = '';

  // ── Panel scriptable (aucun réseau réel) ──────────────────────────────────
  let createGitCount = 0;
  type CreateGitBehavior = 'ok' | 'hang' | 'fail500' | 'timeout';
  let createGitBehavior: CreateGitBehavior = 'ok';
  let hangResolve: (() => void) | null = null;
  const fakeDeploymentStatus = jest.fn().mockResolvedValue({ rawStatus: 'finished' });
  const fakeDeleteApplication = jest.fn().mockResolvedValue(undefined);
  const fakeCfTransport = {
    findRecordByName: jest.fn().mockResolvedValue(null),
    createRecord: jest.fn().mockResolvedValue('fake-rec-1'),
    deleteRecord: jest.fn().mockResolvedValue(undefined),
    listZones: jest.fn().mockResolvedValue([]),
  };
  const fakePanelFactory = {
    create: (): PanelTransport =>
      ({
        verify: jest.fn().mockResolvedValue({ ok: true, detail: 'FAKE PANEL OK' }),
        createGitApp: jest.fn(async () => {
          createGitCount += 1;
          if (createGitBehavior === 'hang') {
            await new Promise<void>((resolve) => {
              hangResolve = resolve;
            });
          }
          if (createGitBehavior === 'fail500') {
            throw new Error('HTTP 500 boom (simulation e2e)');
          }
          if (createGitBehavior === 'timeout') {
            // Timeout réseau simulé (transport réel, base réelle) : même branche
            // catch que 5xx → settle UNKNOWN (« Timeout/5xx ambigu ⇒ UNKNOWN »).
            await new Promise((r) => setTimeout(r, 30));
            throw new Error('ETIMEDOUT: connect timeout (simulation e2e)');
          }
          return { uuid: `app-c4-${createGitCount}` };
        }),
        createProject: jest.fn().mockResolvedValue({ uuid: 'fake-proj', name: 'x' }),
        listProjects: jest.fn().mockResolvedValue([]),
        listServers: jest.fn().mockResolvedValue([]),
        deployApp: jest.fn().mockResolvedValue(undefined),
        applyAppLimits: jest.fn().mockResolvedValue(undefined),
        setAppEnvironment: jest.fn().mockResolvedValue(undefined),
        applyNodePort: jest.fn().mockResolvedValue(undefined),
        resolveExposedPort: jest.fn().mockResolvedValue(null),
        setAppDomain: jest.fn().mockResolvedValue(undefined),
        deleteApplication: fakeDeleteApplication,
        deploymentStatus: fakeDeploymentStatus,
      }) as unknown as PanelTransport,
  } as unknown as PanelTransportFactory;
  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };

  const actor = () => ({ sub: memberUserId, email: memberEmail });

  // ── Helpers ───────────────────────────────────────────────────────────────
  async function waitFor<T>(
    label: string,
    fn: () => Promise<T>,
    pred: (t: T) => boolean,
  ): Promise<T> {
    const deadline = Date.now() + 30_000;
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
    throw new Error(`Timeout (30s) waiting for ${label} — last=${JSON.stringify(last) ?? String(last)}`);
  }

  /** Commande C3 seedée (mêmes écrits que checkout.service, sans fire-and-forget). */
  async function seedOrder(tag: string): Promise<string> {
    const email = `seed-c4-${tag}-${stamp}@example.com`;
    const customer =
      (await prisma.customer.findFirst({ where: { userId: memberUserId } })) ??
      (await prisma.customer.create({
        data: { email: `c4cust_${stamp}@example.com`, name: `C4 ${stamp}`, userId: memberUserId },
      }));
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        customerName: `c4-${tag}`,
        customerEmail: email,
        productId: prodId,
        productName: `c4-${stamp}`,
        packId,
        status: OrderStatus.PAID,
        amountHtCents: 4900,
        taxAmountCents: 0,
        amountTtcCents: 4900,
        paymentMethodId: pmId,
        paymentMethodName: `CB-${stamp}`,
        idempotencyKey: `c4-${tag}-${stamp}`,
        effectiveDomainId: domainId,
      },
    });
    allOrderIds.push(order.id);
    await prisma.orderProvisioningTracking.create({
      data: {
        orderId: order.id,
        intent: {
          business: {
            productId: prodId,
            packId,
            provisionModuleId: provId,
            billingCycle: 'ONETIME',
            currency: 'USD',
            amountTtcCents: 4900,
            requestedSubdomain: null,
            requestedDomainId: null,
          },
          environment: {
            repoUrl: 'https://github.com/acme/site.git',
            branch: 'main',
            buildPack: 'static',
            appName: 'site',
            publishDirectory: 'dist',
            isStatic: true,
          },
        },
      },
    });
    const svc = await prisma.hostingService.create({
      data: {
        userId: memberUserId,
        orderId: order.id,
        productId: prodId,
        packId,
        deploymentModuleId: modId,
        status: HostingServiceStatus.PROVISIONING,
        maxAppsSnapshot: 1,
        ramMbSnapshot: 512,
        cpuCoresSnapshot: 1,
        storageLimitGbSnapshot: null,
        packNameSnapshot: `c4-pack-${stamp}`,
        productNameSnapshot: `c4-${stamp}`,
      },
    });
    serviceIds.push(svc.id);
    return order.id;
  }

  const runProvision = (orderId: string) => provisioning.provisionOrder(orderId);

  const allocOf = (orderId: string) =>
    prisma.hostingServiceAllocation.findFirst({
      where: { hostingService: { orderId } },
    });

  const attemptsOf = (orderId: string) =>
    prisma.c4ProviderAttempt.findMany({ where: { orderId }, orderBy: { dispatchedAt: 'asc' } });

  // ── Boot + fixtures ───────────────────────────────────────────────────────
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransportFactory)
      .useValue(mailFactoryStub)
      .overrideProvider(PanelTransportFactory)
      .useValue(fakePanelFactory)
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
    provisioning = moduleRef.get(ProvisioningService);
    orderCancel = moduleRef.get(OrderCancelService);
    deployments = moduleRef.get(DeploymentsService);
    subscriptions = moduleRef.get(SubscriptionsService);
    c4 = moduleRef.get(C4ProtocolService);
    c4r = moduleRef.get(C4ReleaseService);
    c4c = moduleRef.get(C4CapabilityService);
    hosting = moduleRef.get(HostingServicesService);
    const limiter = moduleRef.get(SaRateLimiter);
    limiter.reset();

    // Garde d'identité : JAMAIS la base live, JAMAIS une autre base isolée.
    const dbs = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
    if (dbs[0]?.db !== 'icode_host_pro_c4test') {
      throw new Error(
        `Base "${dbs[0]?.db}" inattendue — c4test est réservée à icode_host_pro_c4test.`,
      );
    }

    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
      },
    });
    for (const [email, role] of [
      [memberEmail, Role.USER],
      [member2Email, Role.USER],
    ] as const) {
      await prisma.user.create({
        data: { email, passwordHash: await bcrypt.hash(password, 10), role },
      });
    }
    memberUserId = (await prisma.user.findUniqueOrThrow({ where: { email: memberEmail } })).id;
    member2UserId = (await prisma.user.findUniqueOrThrow({ where: { email: member2Email } })).id;
    memberToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: memberEmail, password })
        .expect(201)
    ).body.accessToken as string;
    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;
    expect(memberToken).toBeTruthy();
    expect(adminToken).toBeTruthy();
    adminUserId = (await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } })).id;

    const server = await prisma.server.create({
      data: {
        name: `c4-srv-${stamp}`,
        hostname: 'panel.test',
        panelProvider: 'COOLIFY',
        apiBaseUrl: 'http://panel.test:8000/api/v1',
        apiTokenEnc: null,
        strictTls: true,
      },
    });
    srvId = server.id;
    await prisma.server.update({
      where: { id: srvId },
      data: { apiTokenEnc: moduleRef.get(CryptoService).encrypt('fake-coolify-token') },
    });

    const mod = await prisma.deploymentModule.create({
      data: {
        name: `c4-mod-${stamp}`,
        code: `C4-${stamp}`,
        kind: 'SHARED_PROJECT',
        sharedProjectUuid: 'proj-c4-e2e',
        serverId: srvId,
      },
    });
    modId = mod.id;

    const pack = await prisma.hostingPack.create({
      data: {
        name: `c4-pack-${stamp}`,
        ramMb: 512,
        cpuCores: 1,
        storageLimit: null,
        maxApps: 1,
        deploymentModuleId: modId,
      },
    });
    packId = pack.id;

    const prov = await prisma.provisionMethod.create({
      data: {
        name: `c4-prov-${stamp}`,
        code: `c4-prov-${stamp}`,
        actions: [ProvisionAction.CREATE_APP, ProvisionAction.CONFIGURE_DNS],
      },
    });
    provId = prov.id;

    const pm = await prisma.paymentMethod.create({
      data: { name: `CB-${stamp}`, type: PaymentMethodType.CARD, isActive: true },
    });
    pmId = pm.id;

    const domain = await prisma.domain.create({
      data: {
        name: `c4-${stamp}.test`,
        zoneId: `zone-c4-${stamp}`,
        status: 'ACTIVE',
        cnameTarget: 'fallback.example.net',
      },
    });
    domainId = domain.id;

    // Jeton Cloudflare factice (décrypté localement, jamais appel réseau réel).
    await prisma.cloudflareSetting.create({
      data: {
        apiTokenEnc: moduleRef.get(CryptoService).encrypt('fake-cf-token'),
        accountEmail: `c4-${stamp}@example.com`,
      },
    });

    const prod = await prisma.product.create({
      data: {
        name: `c4-${stamp}`,
        slug: `c4-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 4900,
        provisionModuleId: provId,
        packId,
        moduleParams: {
          repoUrl: 'https://github.com/acme/site.git',
          branch: 'main',
          buildPack: 'static',
          appName: 'site',
          publishDirectory: 'dist',
          isStatic: true,
        },
      },
    });
    prodId = prod.id;
  });

  afterAll(async () => {
    const orderIds = [...allOrderIds];
    // Tables C4 du protocole — c4test est une base jetable : purge complète
    // (tentatives, preuves, arrêts, takeovers, libérations), sans FK.
    await prisma.c4ProviderAttempt.deleteMany({}).catch(() => {});
    await prisma.c4ReleaseEvidence.deleteMany({}).catch(() => {});
    await prisma.c4ReadinessProof.deleteMany({}).catch(() => {});
    await prisma.c4StopRequest.deleteMany({}).catch(() => {});
    await prisma.c4Takeover.deleteMany({}).catch(() => {});
    await prisma.clientSubdomain.deleteMany({ where: { domainId } }).catch(() => {});
    await prisma.deployment.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.provisioningLog.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.hostingServiceAllocation
      .deleteMany({ where: { OR: [{ id: { in: allocIds } }, { hostingServiceId: { in: serviceIds } }] } })
      .catch(() => {});
    await prisma.subscription.deleteMany({ where: { id: { in: subIds } } }).catch(() => {});
    await prisma.hostingService.deleteMany({ where: { id: { in: serviceIds } } }).catch(() => {});
    await prisma.orderProvisioningTracking.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { userId: memberUserId } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { email: { in: [memberEmail, member2Email, adminEmail] } } })
      .catch(() => {});
    await prisma.product.deleteMany({ where: { id: prodId } }).catch(() => {});
    await prisma.provisionMethod.deleteMany({ where: { id: provId } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: pmId } }).catch(() => {});
    await prisma.cloudflareSetting.deleteMany({ where: { accountEmail: `c4-${stamp}@example.com` } }).catch(() => {});
    await prisma.domain.deleteMany({ where: { id: domainId } }).catch(() => {});
    await prisma.hostingPack.deleteMany({ where: { id: packId } }).catch(() => {});
    await prisma.deploymentModule.deleteMany({ where: { id: modId } }).catch(() => {});
    await prisma.server.deleteMany({ where: { id: srvId } }).catch(() => {});
    delete process.env.HOSTING_C3_ENABLED;
    delete process.env.HOSTING_C4_ENABLED;
    removeFingerprintEnv();
    await app.close();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 1 — parcours ON complet : tentatives consignées + cycle ACTIF
  // ═══════════════════════════════════════════════════════════════════════
  it('parcours ON complet : CREATE+CONFIGURE consignées, allocation BOUND, Order/dep/service ACTIFS', async () => {
    const orderId = await seedOrder('t1');
    await runProvision(orderId);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.ACTIVE);

    const dep = await prisma.deployment.findUniqueOrThrow({ where: { orderId } });
    expect(dep.status).toBe(DeploymentStatus.ACTIVE);
    expect(dep.coolifyUuid).toBeTruthy();

    const alloc = await allocOf(orderId);
    expect(alloc?.status).toBe(HostingServiceAllocationStatus.BOUND);
    expect(alloc?.providerIntentAt).toBeTruthy();
    allocIds.push(alloc!.id);

    const attempts = await attemptsOf(orderId);
    const create = attempts.filter((a) => a.nature === 'CREATE');
    const configure = attempts.filter((a) => a.nature === 'CONFIGURE');
    expect(create).toHaveLength(1);
    expect(create[0].phase).toBe('RETURNED');
    expect(create[0].outcome).toBe('SUCCESS');
    expect(configure).toHaveLength(1);
    expect(configure[0].phase).toBe('RETURNED');
    expect(configure[0].outcome).toBe('SUCCESS');

    const svc = await prisma.hostingService.findUniqueOrThrow({ where: { orderId } });
    expect(svc.status).toBe(HostingServiceStatus.ACTIVE);

    const cs = await prisma.clientSubdomain.findFirst({ where: { deploymentId: dep.id } });
    expect(cs?.recordId).toBe('fake-rec-1');
    expect(order.domainValue).toBe(cs?.fqdn);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2 — ARRÊT pendant la création : consignation tardive + annulation propre
  // ═══════════════════════════════════════════════════════════════════════
  it('arrêt pendant CREATE : UUID consigné malgré l’arrêt, aucun flip, puis annulation → CANCELLED + RELEASED', async () => {
    const orderId = await seedOrder('t2');
    createGitBehavior = 'hang';
    const run = runProvision(orderId);

    // Tentative DISPATCHED committée AVANT le réseau, puis appel provider.
    await waitFor(
      'attempt CREATE DISPATCHED + createGitApp en attente',
      async () => ({
        attempt: await prisma.c4ProviderAttempt.findFirst({
          where: { orderId, nature: 'CREATE', phase: 'DISPATCHED' },
        }),
        hung: hangResolve !== null,
      }),
      (v) => !!v.attempt && v.hung,
    );

    // ARRÊT pendant l'appel réseau.
    await c4.requestStop({ scope: { type: 'ORDER', id: orderId }, reason: 'e2e stop' });
    hangResolve!();
    createGitBehavior = 'ok';
    await run;

    // La consignation TARDIVE est conservée (aucun UUID perdu après bascule).
    const create = await waitFor(
      'attempt CREATE RETURNED SUCCESS',
      () =>
        prisma.c4ProviderAttempt.findFirst({
          where: { orderId, nature: 'CREATE', phase: 'RETURNED', outcome: 'SUCCESS' },
        }),
      (a) => !!a,
    );
    expect(create).toBeTruthy();
    expect(create!.returnedIdentifiers).toBeTruthy();

    // Aucune opération ni flip après l'arrêt.
    const configureCount = await prisma.c4ProviderAttempt.count({
      where: { orderId, nature: 'CONFIGURE' },
    });
    expect(configureCount).toBe(0);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.PROVISIONING); // jamais ACTIVE
    const dep = await prisma.deployment.findUniqueOrThrow({ where: { orderId } });
    expect(dep.coolifyUuid).toBeTruthy(); // identifiant consigné
    const alloc = await allocOf(orderId);
    expect(alloc?.status).toBe(HostingServiceAllocationStatus.RESERVED); // jamais BOUND
    allocIds.push(alloc!.id);

    // Annulation post-arrêt : DELETE non bloqué par l'arrêt, libérations
    // concluantes (app deleted, pas de DNS) → service terminal CANCELLED.
    const res = await orderCancel.cancelProvisioning(orderId, 'motif e2e stop suffisant', actor());
    expect(res.orderStatus).toBe(OrderStatus.CANCELLED);
    expect(res.c4?.serviceStatus).toBe(HostingServiceStatus.CANCELLED);
    expect(res.c4?.releases[0]?.status).toBe('released');
    const allocAfter = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: alloc!.id },
    });
    expect(allocAfter.status).toBe(HostingServiceAllocationStatus.RELEASED);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3 — timeout créateur → UNKNOWN → libération bloquée (slot conservé)
  // ═══════════════════════════════════════════════════════════════════════
  // Timeout CREATE — PostgreSQL RÉEL (base c4test, écritures Prisma réelles)
  // + transport simulé (fakePanelFactory in-process) : AUCUN mock de base.
  it('timeout CREATE → UNKNOWN durable : aucun rejeu CREATE, aucun DELETE, aucun RELEASED ; libération bloquée (call_uncertain)', async () => {
    const orderId = await seedOrder('t3');
    t3OrderId = orderId;
    createGitBehavior = 'timeout';
    try {
      await runProvision(orderId);
    } finally {
      createGitBehavior = 'ok';
    }

    const unknown = await waitFor(
      'attempt CREATE UNKNOWN (timeout)',
      () =>
        prisma.c4ProviderAttempt.findFirst({
          where: { orderId, nature: 'CREATE', outcome: 'UNKNOWN' },
        }),
      (a) => !!a,
    );
    expect(unknown).toBeTruthy();
    expect(unknown!.phase).toBe('RETURNED');

    const alloc = await allocOf(orderId);
    expect(alloc?.status).toBe(HostingServiceAllocationStatus.RESERVED);
    allocIds.push(alloc!.id);
    expect(await c4.unresolvedCreative(alloc!.id)).toBeGreaterThan(0);
    // Aucune ressource créée ⇒ AUCUNE tentative DELETE (rien à supprimer).
    expect((await attemptsOf(orderId)).filter((a) => a.nature === 'DELETE')).toHaveLength(0);

    // REJEU après incertitude : 409 (« intention déjà engagée »), ZÉRO nouveau
    // dispatch provider, ZÉRO libération — l'incertitude n'est jamais « reprise ».
    const beforeRetry = createGitCount;
    await expect(runProvision(orderId)).rejects.toBeInstanceOf(ConflictException);
    expect(createGitCount).toBe(beforeRetry); // aucun rejeu CREATE réseau
    const createAttempts = (await attemptsOf(orderId)).filter((a) => a.nature === 'CREATE');
    expect(createAttempts).toHaveLength(1); // aucune tentative CREATE supplémentaire
    expect(createAttempts[0].outcome).toBe('UNKNOWN');

    const res = await orderCancel.cancelProvisioning(orderId, 'motif e2e incertitude ok', actor());
    expect(res.orderStatus).toBe(OrderStatus.CANCELLED);
    // Slot conservé : jamais de libération tant que le créateur est non résolu.
    expect(res.c4?.releases[0]?.status).toBe('blocked');
    expect(res.c4?.releases[0]?.blockedReason).toBe('call_uncertain');
    expect(res.c4?.serviceStatus).toBe(HostingServiceStatus.CANCELLATION_PENDING);
    const allocAfter = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: alloc!.id },
    });
    expect(allocAfter.status).not.toBe(HostingServiceAllocationStatus.RELEASED); // aucun RELEASED
    expect(allocAfter.status).toBe(HostingServiceAllocationStatus.RESERVED);
    // Arrêt posé par la phase 1 du cancel (jamais effacé ensuite).
    const stop = await prisma.c4StopRequest.findFirst({
      where: { scopeType: 'ORDER', scopeId: orderId },
    });
    expect(stop).toBeTruthy();
    // Aucune libération : zéro preuve commitée malgré l'annulation.
    expect(
      await prisma.c4ReleaseEvidence.count({ where: { allocationId: alloc!.id } }),
    ).toBe(0);
    // UNKNOWN DURABLE : toujours RETURNED/UNKNOWN après l'annulation.
    const unknownAfter = await prisma.c4ProviderAttempt.findUniqueOrThrow({
      where: { id: unknown!.id },
    });
    expect(unknownAfter.phase).toBe('RETURNED');
    expect(unknownAfter.outcome).toBe('UNKNOWN');
    // TOUJOURS aucune tentative DELETE après le cancel complet.
    expect((await attemptsOf(orderId)).filter((a) => a.nature === 'DELETE')).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4 — delete : échec réseau (502) → absent (404) → libération + rejeu
  // ═══════════════════════════════════════════════════════════════════════
  it('delete : échec réseau → 502 sans suppression locale ; absent → RELEASED, freedQuota=true, rejeu déjà libéré', async () => {
    // — échec réseau non-absent : fail-closed.
    const failOrder = await seedOrder('t4fail');
    await runProvision(failOrder);
    const failDep = await prisma.deployment.findUniqueOrThrow({ where: { orderId: failOrder } });
    fakeDeleteApplication.mockRejectedValueOnce(new Error('HTTP 500 boom (e2e)'));
    await expect(deployments.remove(failDep.id, actor())).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(
      await prisma.deployment.findUnique({ where: { id: failDep.id } }),
    ).toBeTruthy(); // aucune suppression locale
    const failAttempts = await attemptsOf(failOrder);
    const failedDelete = failAttempts.find((a) => a.nature === 'DELETE');
    expect(failedDelete?.outcome).toBe('FAILED_RETRYABLE');

    // — rejeu : absent (404) → local poursuivi → libération concluante.
    fakeDeleteApplication.mockRejectedValueOnce(new Error('HTTP 404 not found'));
    const out = await deployments.remove(failDep.id, actor());
    expect(out).toEqual({
      removed: true,
      appName: expect.any(String),
      partial: false,
      freedQuota: true,
      c4: { release: expect.objectContaining({ status: 'released' }) },
    });
    const failAlloc = await prisma.hostingServiceAllocation.findFirst({
      where: { hostingService: { orderId: failOrder } },
    });
    allocIds.push(failAlloc!.id);
    expect(failAlloc?.status).toBe(HostingServiceAllocationStatus.RELEASED);
    const evCount = await prisma.c4ReleaseEvidence.count({
      where: { allocationId: failAlloc!.id },
    });
    expect(evCount).toBe(1);
    // Une SEULE libération : le rejeu est déjà_released (H5).
    const replay = await c4r.releaseAfterCleanup({
      allocationId: failAlloc!.id,
      actorUserId: memberUserId,
      orderId: failOrder,
      app: 'deleted',
      dns: 'not_created',
      dnsHadRecord: false,
    });
    expect(replay.status).toBe('already_released');
    expect(
      await prisma.c4ReleaseEvidence.count({ where: { allocationId: failAlloc!.id } }),
    ).toBe(1);
  });

  it('delete successif : DNS tracké + RELEASED ; tentative DELETE orpheline (crash) ne bloque pas le rejeu', async () => {
    const orderId = await seedOrder('t4ok');
    await runProvision(orderId);
    const dep = await prisma.deployment.findUniqueOrThrow({ where: { orderId } });
    const alloc = await allocOf(orderId);
    allocIds.push(alloc!.id);

    // Simulation de crash : tentative DELETE committée mais jamais consignée.
    const ghost = await prisma.c4ProviderAttempt.create({
      data: {
        nature: 'DELETE',
        phase: 'DISPATCHED',
        scopeType: 'DEPLOYMENT',
        scopeId: dep.id,
        allocationId: alloc!.id,
        orderId,
        holder: 'ghost-crash',
      },
    });

    const out = await deployments.remove(dep.id, actor());
    expect(out.freedQuota).toBe(true);
    expect(out.c4?.release.status).toBe('released');
    expect(out.partial).toBe(false);

    // Le rejeu n'a PAS été bloqué par l'orpheline (DELETE n'est pas créateur) :
    // 3 tentatives DELETE (orpheline + app + DNS), 2 consignées.
    const attempts = await attemptsOf(orderId);
    const deletes = attempts.filter((a) => a.nature === 'DELETE');
    expect(deletes.length).toBe(3);
    expect(deletes.filter((a) => a.phase === 'RETURNED').length).toBe(2);
    const ghostAfter = await prisma.c4ProviderAttempt.findUniqueOrThrow({ where: { id: ghost.id } });
    expect(ghostAfter.phase).toBe('DISPATCHED'); // jamais consignée par le rejeu
    const allocAfter = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: alloc!.id },
    });
    expect(allocAfter.status).toBe(HostingServiceAllocationStatus.RELEASED);
    // Row ClientSubdomain supprimée ownership-strictement.
    const csLeft = await prisma.clientSubdomain.count({ where: { deploymentId: dep.id } });
    expect(csLeft).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5 — pré-protocole : libération pré-provider vs incertitude conservée
  // ═══════════════════════════════════════════════════════════════════════
  it('pré-protocole : sans intention → pre_provider_released ; intention sans tentative CREATE → blocked pre_protocol_uncertain', async () => {
    const svc = await prisma.hostingService.create({
      data: {
        userId: memberUserId,
        productId: prodId,
        packId,
        deploymentModuleId: modId,
        status: HostingServiceStatus.ACTIVE,
        maxAppsSnapshot: null,
        ramMbSnapshot: 512,
        cpuCoresSnapshot: 1,
        storageLimitGbSnapshot: null,
        packNameSnapshot: `c4-pack-${stamp}`,
        productNameSnapshot: `c4-${stamp}`,
      },
    });
    serviceIds.push(svc.id);

    // (a) aucune intention posée → libération structurelle pré-provider.
    const a1 = await prisma.hostingServiceAllocation.create({
      data: { hostingServiceId: svc.id, idempotencyKey: `c4-pre1-${stamp}` },
    });
    allocIds.push(a1.id);
    const r1 = await c4r.releaseAfterCleanup({
      allocationId: a1.id,
      actorUserId: memberUserId,
      app: 'not_created',
      dns: 'not_created',
      dnsHadRecord: false,
    });
    expect(r1.status).toBe('pre_provider_released');
    const a1after = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: a1.id },
    });
    expect(a1after.status).toBe(HostingServiceAllocationStatus.RELEASED);

    // (b) intention posée SANS aucune tentative CREATE → incertitude conservée.
    const a2 = await prisma.hostingServiceAllocation.create({
      data: {
        hostingServiceId: svc.id,
        idempotencyKey: `c4-pre2-${stamp}`,
        providerIntentAt: new Date(),
      },
    });
    allocIds.push(a2.id);
    const r2 = await c4r.releaseAfterCleanup({
      allocationId: a2.id,
      actorUserId: memberUserId,
      app: 'deleted',
      dns: 'not_created',
      dnsHadRecord: false,
    });
    expect(r2).toMatchObject({
      status: 'blocked',
      blockedReason: 'pre_protocol_uncertain',
    });
    const a2after = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: a2.id },
    });
    expect(a2after.status).toBe(HostingServiceAllocationStatus.RESERVED);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6 — finalize admin : bornes, preuve identity-bound, rejeu, course
  // ═══════════════════════════════════════════════════════════════════════
  describe('finalize admin (POST /store/admin/orders/:id/finalize)', () => {
    let readyOrder = '';
    let readyDepId = '';

    const postFinalize = (orderId: string, reason: string) =>
      request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason });

    const seedBoundNotActivated = async (tag: string): Promise<string> => {
      const orderId = await seedOrder(tag);
      const spy = jest
        .spyOn(
          provisioning as never as { awaitAppReady: (...a: unknown[]) => Promise<boolean> },
          'awaitAppReady',
        )
        .mockResolvedValue(false);
      try {
        await runProvision(orderId);
      } finally {
        spy.mockRestore();
      }
      return orderId;
    };

    it('non-prêt → 409 ZÉRO écriture ; prêt → ACTIVE + preuve identity-bound ; rejeu idempotent sans audit', async () => {
      readyOrder = await seedBoundNotActivated('fin1');
      const dep = await prisma.deployment.findUniqueOrThrow({ where: { orderId: readyOrder } });
      readyDepId = dep.id;
      expect(dep.status).toBe(DeploymentStatus.DEPLOYING);
      const alloc = await allocOf(readyOrder);
      expect(alloc?.status).toBe(HostingServiceAllocationStatus.BOUND);
      allocIds.push(alloc!.id);

      // Raison trop courte → validation (400), aucun passage service.
      await postFinalize(readyOrder, 'court').expect(400);

      // Pas encore prêt : refus, zéro preuve, zéro audit, zéro transition.
      fakeDeploymentStatus.mockResolvedValueOnce({ rawStatus: 'in_progress' });
      const refused = await postFinalize(readyOrder, 'provider pas encore actif');
      expect(refused.status).toBe(409);
      expect(await prisma.c4ReadinessProof.findUnique({ where: { orderId: readyOrder } })).toBeNull();
      expect(
        await prisma.auditLog.count({
          where: { action: 'provision.finalize.c4', resourceId: readyOrder },
        }),
      ).toBe(0);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: readyOrder } })).status,
      ).toBe(OrderStatus.PROVISIONING);

      // Prêt : preuve identity-bound + activation dans la même TX.
      fakeDeploymentStatus.mockResolvedValueOnce({ rawStatus: 'finished' });
      const ok = await postFinalize(readyOrder, 'provider confirme actif e2e');
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ orderId: readyOrder, status: 'ACTIVE', replay: false });
      expect(ok.body.proof?.providerStatus).toBe('finished');
      const orderAfter = await prisma.order.findUniqueOrThrow({ where: { id: readyOrder } });
      expect(orderAfter.status).toBe(OrderStatus.ACTIVE);
      const depAfter = await prisma.deployment.findUniqueOrThrow({ where: { id: readyDepId } });
      expect(depAfter.status).toBe(DeploymentStatus.ACTIVE);
      const svcAfter = await prisma.hostingService.findUniqueOrThrow({
        where: { orderId: readyOrder },
      });
      expect(svcAfter.status).toBe(HostingServiceStatus.ACTIVE);
      const proof = await prisma.c4ReadinessProof.findUniqueOrThrow({
        where: { orderId: readyOrder },
      });
      expect(proof.coolifyUuid).toBe(depAfter.coolifyUuid);
      expect(
        await prisma.auditLog.count({
          where: { action: 'provision.finalize.c4', resourceId: readyOrder },
        }),
      ).toBe(1);

      // Rejeu : retour d'état local UNIQUEMENT (0 transport, 0 audit).
      const callsBefore = fakeDeploymentStatus.mock.calls.length;
      const replay = await postFinalize(readyOrder, 'rejeu idempotent e2e');
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ status: 'ACTIVE', replay: true });
      expect(fakeDeploymentStatus.mock.calls.length).toBe(callsBefore);
      expect(
        await prisma.auditLog.count({
          where: { action: 'provision.finalize.c4', resourceId: readyOrder },
        }),
      ).toBe(1);
    });

    it('course avec une annulation : commande CANCELLED → 409, aucune réactivation', async () => {
      const orderId = await seedBoundNotActivated('fin2');
      await orderCancel.cancelProvisioning(orderId, 'annulation avant finalize e2e', actor());
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status,
      ).toBe(OrderStatus.CANCELLED);

      const res = await postFinalize(orderId, 'finalize apres annulation');
      expect(res.status).toBe(409);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status,
      ).toBe(OrderStatus.CANCELLED);
      expect(
        await prisma.auditLog.count({
          where: { action: 'provision.finalize.c4', resourceId: orderId },
        }),
      ).toBe(0);
    });

    it('course RÉELLE (promesses parallèles) : finalize ∥ annulation → transitions exclusives, jamais de preuve sur CANCELLED', async () => {
      const orderId = await seedBoundNotActivated('fin3');
      const [fin, can] = await Promise.allSettled([
        postFinalize(orderId, 'finalize concurrent e2e'),
        orderCancel.cancelProvisioning(orderId, 'annulation concurrente e2e', actor()),
      ]);
      expect(fin.status).toBe('fulfilled'); // réponse HTTP : 201 (gagnant) ou 409 (perdant)
      const finStatus = (fin as PromiseFulfilledResult<{ status: number }>).value.status;
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const proof = await prisma.c4ReadinessProof.findUnique({ where: { orderId } });
      const audits = await prisma.auditLog.count({
        where: { action: 'provision.finalize.c4', resourceId: orderId },
      });
      const svc = await prisma.hostingService.findUniqueOrThrow({ where: { orderId } });

      if (order.status === OrderStatus.ACTIVE) {
        // finalize a gagné la course → annulation refusée (gate statut), preuve + audit une fois.
        expect(finStatus).toBe(201);
        expect(can.status).toBe('rejected');
        expect(proof).toBeTruthy();
        expect(audits).toBe(1);
        expect(svc.status).toBe(HostingServiceStatus.ACTIVE);
      } else {
        // annulation a gagné → finalize 409, AUCUNE preuve, AUCUN audit, aucun flip.
        expect(order.status).toBe(OrderStatus.CANCELLED);
        expect(finStatus).toBe(409);
        expect(can.status).toBe('fulfilled');
        expect(proof).toBeNull();
        expect(audits).toBe(0);
        expect(svc.status).not.toBe(HostingServiceStatus.PROVISIONING); // jamais le miroir figé
      }
      // Invariant : jamais de preuve/audit finalize sur une commande non ACTIVE.
      if (order.status !== OrderStatus.ACTIVE) {
        expect(proof).toBeNull();
        expect(audits).toBe(0);
      }
    });

    it('ordre 1 : finalize COMPLET gagne (201) → annulation postérieure refusée (409), transitions exclusives', async () => {
      const orderId = await seedBoundNotActivated('fin4');
      fakeDeploymentStatus.mockResolvedValueOnce({ rawStatus: 'finished' });
      const fin = await postFinalize(orderId, 'finalize complet avant annulation e2e');
      expect(fin.status).toBe(201);
      expect(fin.body).toMatchObject({ status: 'ACTIVE', replay: false });

      await expect(
        orderCancel.cancelProvisioning(orderId, 'annulation apres finalize e2e', actor()),
      ).rejects.toBeInstanceOf(ConflictException);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.ACTIVE); // aucune réactivation/régression
      expect(await prisma.c4ReadinessProof.findUnique({ where: { orderId } })).toBeTruthy();
      expect(
        await prisma.auditLog.count({
          where: { action: 'provision.finalize.c4', resourceId: orderId },
        }),
      ).toBe(1);
      expect(
        (await prisma.hostingService.findUniqueOrThrow({ where: { orderId } })).status,
      ).toBe(HostingServiceStatus.ACTIVE);
    });

    it('ordre 2 : annulation COMPLÈTE pendant le probe réseau de finalize (barrière observée) → finalize 409, zéro preuve', async () => {
      const orderId = await seedBoundNotActivated('fin5');
      // Barrière : finalize se bloque dans sa lecture réseau HORS transaction.
      let probeEntered = false;
      let resumeProbe!: () => void;
      const gate = new Promise<{ rawStatus: string }>((r) => {
        resumeProbe = () => r({ rawStatus: 'finished' });
      });
      fakeDeploymentStatus.mockImplementationOnce(() => {
        probeEntered = true;
        return gate;
      });
      let finSettled = false;
      const finPromise = postFinalize(orderId, 'finalize pendant annulation e2e').then((res) => {
        finSettled = true;
        return res;
      });
      await waitFor(
        'finalize en attente du probe réseau (barrière atteinte)',
        () => Promise.resolve(probeEntered),
        (entered) => entered,
      );

      // Pendant ce temps l'annulation se COMPLETE (écritures réelles) :
      const can = await orderCancel.cancelProvisioning(
        orderId,
        'annulation complete pendant le probe',
        actor(),
      );
      expect(can.orderStatus).toBe(OrderStatus.CANCELLED);
      expect(finSettled).toBe(false); // observé : finalize toujours en attente (ordre imposé)

      // Relâchement : finalize reprend → TX finale relock Order → CANCELLED → 409.
      resumeProbe();
      const finRes = await finPromise;
      expect(finRes.status).toBe(409);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.CANCELLED);
      expect(await prisma.c4ReadinessProof.findUnique({ where: { orderId } })).toBeNull();
      expect(
        await prisma.auditLog.count({
          where: { action: 'provision.finalize.c4', resourceId: orderId },
        }),
      ).toBe(0);
      expect(
        (await prisma.hostingService.findUniqueOrThrow({ where: { orderId } })).status,
      ).not.toBe(HostingServiceStatus.PROVISIONING); // jamais le miroir figé
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7 — D10 : annulation d'abonnement gate (allocation consommante / service)
  // ═══════════════════════════════════════════════════════════════════════
  it('D10 : annulation d’abonnement refusée (409) tant qu’une allocation consomme ou qu’un service n’est pas terminé', async () => {
    const sub = await prisma.subscription.create({
      data: { userId: member2UserId, productId: prodId, status: 'ACTIVE' },
    });
    subIds.push(sub.id);
    const svc = await prisma.hostingService.create({
      data: {
        userId: member2UserId,
        subscriptionId: sub.id,
        productId: prodId,
        packId,
        deploymentModuleId: modId,
        status: HostingServiceStatus.ACTIVE,
        maxAppsSnapshot: null,
        ramMbSnapshot: 512,
        cpuCoresSnapshot: 1,
        storageLimitGbSnapshot: null,
        packNameSnapshot: `c4-pack-${stamp}`,
        productNameSnapshot: `c4-${stamp}`,
      },
    });
    serviceIds.push(svc.id);
    const alloc = await prisma.hostingServiceAllocation.create({
      data: { hostingServiceId: svc.id, idempotencyKey: `c4-d10-${stamp}` },
    });
    allocIds.push(alloc.id);
    const cancel = () =>
      subscriptions.cancelMySubscription(sub.id, { sub: member2UserId, email: member2Email });

    // (1) allocation encore consommante → 409, aucune transition.
    await expect(cancel()).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status,
    ).toBe('ACTIVE');

    // (2) slot libéré mais service non terminé → 409.
    await prisma.hostingServiceAllocation.update({
      where: { id: alloc.id },
      data: { status: HostingServiceAllocationStatus.RELEASED, releasedAt: new Date() },
    });
    await expect(cancel()).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status,
    ).toBe('ACTIVE');

    // (3) service terminé + zéro allocation consommante → annulée.
    await prisma.hostingService.update({
      where: { id: svc.id },
      data: { status: HostingServiceStatus.CANCELLED },
    });
    await expect(cancel()).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8 — bascule OFF : zéro nouvelle tentative, marqueurs intacts, pas de libération
  // ═══════════════════════════════════════════════════════════════════════
  it('bascule OFF : zéro tentative nouvelle, stops antérieurs intacts, remove sans libération (contrat historique)', async () => {
    delete process.env.HOSTING_C4_ENABLED;
    try {
      const orderId = await seedOrder('off1');
      await runProvision(orderId);

      // Zéro tentative C4 sous OFF (parcours C3 legacy : cycle ACTIF intact).
      expect(await attemptsOf(orderId)).toHaveLength(0);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
        OrderStatus.ACTIVE,
      );

      // Les marqueurs POSÉS sous ON ne sont JAMAIS effacés par le flag.
      const t3Stop = await prisma.c4StopRequest.findFirst({
        where: { scopeType: 'ORDER', scopeId: t3OrderId },
      });
      expect(t3Stop).toBeTruthy();

      // remove OFF : pas de tentatives, pas de libération, D9 honnête.
      const dep = await prisma.deployment.findUniqueOrThrow({ where: { orderId } });
      const alloc = await allocOf(orderId);
      allocIds.push(alloc!.id);
      const out = await deployments.remove(dep.id, actor());
      expect(out.c4).toBeUndefined();
      expect(out.freedQuota).toBe(false);
      const allocAfter = await prisma.hostingServiceAllocation.findUniqueOrThrow({
        where: { id: alloc!.id },
      });
      expect(allocAfter.status).toBe(HostingServiceAllocationStatus.BOUND); // jamais libéré sous OFF
      expect(
        await prisma.c4ReleaseEvidence.count({ where: { allocationId: alloc!.id } }),
      ).toBe(0);
      expect(await attemptsOf(orderId)).toHaveLength(0);
    } finally {
      process.env.HOSTING_C4_ENABLED = 'true';
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9 — arrêt AVANT dispatch : zéro appel réseau + refus conservatoire D2
  // ═══════════════════════════════════════════════════════════════════════
  it('arrêt AVANT dispatch : 0 appel réseau, 0 tentative ; annulation → pre_protocol_uncertain (slot conservé)', async () => {
    const orderId = await seedOrder('t5');
    await c4.requestStop({ scope: { type: 'ORDER', id: orderId }, reason: 'e2e stop pré-dispatch' });
    const before = createGitCount;
    await runProvision(orderId);
    expect(createGitCount).toBe(before); // AUCUN appel réseau (dispatch refusé dans la garde)
    expect(await attemptsOf(orderId)).toHaveLength(0); // refus AVANT toute écriture de tentative
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      OrderStatus.PROVISIONING,
    );
    const dep = await prisma.deployment.findUnique({ where: { orderId } });
    expect(dep).toBeTruthy();
    expect(dep!.coolifyUuid).toBeNull(); // aucun identifiant provider
    const alloc = await allocOf(orderId);
    expect(alloc?.status).toBe(HostingServiceAllocationStatus.RESERVED);
    expect(alloc?.providerIntentAt).toBeTruthy(); // intention TX-A posée, réseau jamais touché
    allocIds.push(alloc!.id);

    // Annulation : refus conservatoire D2 (intention SANS tentative CREATE).
    const res = await orderCancel.cancelProvisioning(orderId, 'motif e2e stop pré-dispatch', actor());
    expect(res.orderStatus).toBe(OrderStatus.CANCELLED);
    expect(res.c4?.serviceStatus).toBe(HostingServiceStatus.CANCELLATION_PENDING);
    expect(res.c4?.releases[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'pre_protocol_uncertain',
    });
    const after = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: alloc!.id },
    });
    expect(after.status).toBe(HostingServiceAllocationStatus.RESERVED); // slot CONSERVÉ
    expect(
      await prisma.c4ReleaseEvidence.count({ where: { allocationId: alloc!.id } }),
    ).toBe(0); // jamais de libération sans tentative de création
    expect(createGitCount).toBe(before); // toujours 0 appel après annulation
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10 — settle APRÈS passage OFF (en vol) : identifiants persistés, 0 flip
  // ═══════════════════════════════════════════════════════════════════════
  it('settle après passage OFF : identifiants consignés + persistés, AUCUNE transition métier, arrêt intact', async () => {
    const orderId = await seedOrder('t8off');
    createGitBehavior = 'hang';
    const run = runProvision(orderId);
    await waitFor(
      'attempt CREATE DISPATCHED + appel en attente (t8off)',
      async () => ({
        attempt: await prisma.c4ProviderAttempt.findFirst({
          where: { orderId, nature: 'CREATE', phase: 'DISPATCHED' },
        }),
        hung: hangResolve !== null,
      }),
      (v) => !!v.attempt && v.hung,
    );

    // Arrêt + passage OFF pendant que l'appel provider est déjà émis.
    await c4.requestStop({ scope: { type: 'ORDER', id: orderId }, reason: 'e2e off-settle' });
    delete process.env.HOSTING_C4_ENABLED;
    expect(process.env.HOSTING_C4_ENABLED).toBeUndefined();
    try {
      hangResolve!();
      createGitBehavior = 'ok';
      await run;

      // Identifiants CONSIGNÉS et PERSISTÉS malgré le passage OFF.
      const settled = await waitFor(
        'attempt CREATE RETURNED SUCCESS (t8off)',
        () =>
          prisma.c4ProviderAttempt.findFirst({
            where: { orderId, nature: 'CREATE', phase: 'RETURNED', outcome: 'SUCCESS' },
          }),
        (a) => !!a,
      );
      const uuid = (settled!.returnedIdentifiers as { uuid?: string } | null)?.uuid;
      expect(uuid).toBeTruthy();
      const dep = await prisma.deployment.findUniqueOrThrow({ where: { orderId } });
      expect(dep.coolifyUuid).toBe(uuid);

      // AUCUNE transition métier : le settle n'active rien (arrêt opposable).
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status,
      ).toBe(OrderStatus.PROVISIONING);
      const svc = await prisma.hostingService.findUniqueOrThrow({ where: { orderId } });
      expect(svc.status).toBe(HostingServiceStatus.PROVISIONING);
      const alloc = await allocOf(orderId);
      expect(alloc?.status).toBe(HostingServiceAllocationStatus.RESERVED); // jamais BOUND
      allocIds.push(alloc!.id);
      expect(await attemptsOf(orderId)).toHaveLength(1); // aucune écriture C4 nouvelle sous OFF
      expect(
        await prisma.c4StopRequest.findFirst({ where: { scopeType: 'ORDER', scopeId: orderId } }),
      ).toBeTruthy(); // marqueur d'arrêt intact (jamais effacé par le flag)
    } finally {
      process.env.HOSTING_C4_ENABLED = 'true';
      createGitBehavior = 'ok';
      if (hangResolve) {
        hangResolve();
        hangResolve = null;
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11 — D6 : DNS échoue → état adressable ; rollback TX finale ; rejeu
  // ═══════════════════════════════════════════════════════════════════════
  it('DNS échoue → slot conservé + rows adressables ; échec injecté en TX finale → rollback conjoint ; rejeu → UNE libération, preuve complète', async () => {
    const orderId = await seedOrder('t9dns');
    await runProvision(orderId);
    const dep = await prisma.deployment.findUniqueOrThrow({ where: { orderId } });
    expect(dep.status).toBe(DeploymentStatus.ACTIVE);
    const alloc = await allocOf(orderId);
    allocIds.push(alloc!.id);
    expect(alloc?.status).toBe(HostingServiceAllocationStatus.BOUND);
    const cs = await prisma.clientSubdomain.findFirst({ where: { deploymentId: dep.id } });
    expect(cs?.recordId).toBe('fake-rec-1'); // DNS créé → dnsHadRecord = true

    // (1) App supprimée + DNS échoue → slot conservé, TOUT reste adressable.
    fakeDeleteApplication.mockRejectedValueOnce(new Error('HTTP 404 not found')); // déjà absente
    fakeCfTransport.deleteRecord.mockRejectedValueOnce(new Error('HTTP 500 cf boom (e2e)'));
    const out1 = await deployments.remove(dep.id, actor());
    expect(out1).toEqual({
      removed: true,
      appName: expect.any(String),
      partial: true,
      freedQuota: false, // D9 honnête : rien n'a été libéré
      c4: {
        release: expect.objectContaining({
          status: 'blocked',
          blockedReason: 'dns_not_conclusive',
        }),
      },
    });
    // ÉTAT ADRESSABLE : AUCUNE écriture locale — deployment + CS toujours liés.
    expect(await prisma.deployment.findUnique({ where: { id: dep.id } })).toBeTruthy();
    const csStill = await prisma.clientSubdomain.findUnique({ where: { deploymentId: dep.id } });
    expect(csStill?.fqdn).toBe(cs!.fqdn);
    expect(csStill?.recordId).toBe('fake-rec-1');
    expect((await allocOf(orderId))?.status).toBe(HostingServiceAllocationStatus.BOUND);
    expect(
      await prisma.c4ReleaseEvidence.count({ where: { allocationId: alloc!.id } }),
    ).toBe(0);
    const deleteAttempts1 = (await attemptsOf(orderId)).filter((a) => a.nature === 'DELETE');
    expect(deleteAttempts1.some((a) => a.outcome === 'FAILED_RETRYABLE')).toBe(true);

    // (2) ÉCHEC INJECTÉ dans la TX finale (dernière écriture : completeRelease)
    //     → rollback CONJOINT vérifié en base PostgreSQL réelle : les deletes
    //     CS+Deployment exécutés EN transaction sont annulés avec la preuve.
    const inj = jest
      .spyOn(hosting, 'completeReleaseInTx')
      .mockImplementationOnce(() => {
        throw new Error('injection échec TX finale (e2e rollback)');
      });
    try {
      fakeDeleteApplication.mockRejectedValueOnce(new Error('HTTP 404 not found'));
      const out2 = await deployments.remove(dep.id, actor());
      expect(out2.removed).toBe(true);
      expect(out2.partial).toBe(true);
      expect(out2.freedQuota).toBe(false);
      expect(out2.c4?.release.status).toBe('blocked');
    } finally {
      inj.mockRestore();
    }
    expect(await prisma.deployment.findUnique({ where: { id: dep.id } })).toBeTruthy();
    expect(
      await prisma.clientSubdomain.findUnique({ where: { deploymentId: dep.id } }),
    ).toBeTruthy();
    expect((await allocOf(orderId))?.status).toBe(HostingServiceAllocationStatus.BOUND); // RELEASING rollbacké → BOUND
    expect(
      await prisma.c4ReleaseEvidence.count({ where: { allocationId: alloc!.id } }),
    ).toBe(0); // preuve annulée avec les deletes (rollback conjoint)

    // (3) REJEU de la même demande → app déjà absente + DNS supprimé → UNE
    //     libération, preuve complète, AUCUN résidu non adressable.
    fakeDeleteApplication.mockRejectedValueOnce(new Error('HTTP 404 not found'));
    const out3 = await deployments.remove(dep.id, actor());
    expect(out3).toEqual({
      removed: true,
      appName: expect.any(String),
      partial: false,
      freedQuota: true,
      c4: { release: expect.objectContaining({ status: 'released' }) },
    });
    expect(await prisma.deployment.findUnique({ where: { id: dep.id } })).toBeNull();
    // Row DNS réellement SUPPRIMÉE (jamais détachée) : plus aucun résidu.
    expect(await prisma.clientSubdomain.findFirst({ where: { fqdn: cs!.fqdn } })).toBeNull();
    const allocFinal = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: alloc!.id },
    });
    expect(allocFinal.status).toBe(HostingServiceAllocationStatus.RELEASED);
    const evidence = await prisma.c4ReleaseEvidence.findMany({
      where: { allocationId: alloc!.id },
    });
    expect(evidence).toHaveLength(1); // UNE seule libération, une seule preuve
    expect(evidence[0]).toMatchObject({
      appOutcome: 'ABSENT', // 404 au rejeu : déjà détruit chez le provider
      dnsOutcome: 'DELETED',
      appIdentifier: dep.coolifyUuid,
      dnsIdentifier: cs!.fqdn,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12 — suppressions concurrentes : ORDRES OBSERVÉS (barrière réseau)
  // ═══════════════════════════════════════════════════════════════════════
  it('suppressions concurrentes, ORDRES OBSERVÉS : (a) séquentiel → 404 ; (b) intercalé (barrière) → UNE seule preuve', async () => {
    // ── (a) ORDRE A observé : demande 1 COMPLÈTE, puis demande 2 → 404.
    const orderA = await seedOrder('t10a');
    await runProvision(orderA);
    const depA = await prisma.deployment.findUniqueOrThrow({ where: { orderId: orderA } });
    const allocA = await allocOf(orderA);
    allocIds.push(allocA!.id);

    const outA1 = await deployments.remove(depA.id, actor());
    expect(outA1.c4?.release.status).toBe('released');
    expect(outA1.freedQuota).toBe(true);
    // 2ᵉ demande APRÈS la première (row supprimée) → 404, zéro écriture.
    await expect(deployments.remove(depA.id, actor())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await prisma.c4ReleaseEvidence.count({ where: { allocationId: allocA!.id } })).toBe(1);
    expect(
      (await prisma.hostingServiceAllocation.findUniqueOrThrow({ where: { id: allocA!.id } }))
        .status,
    ).toBe(HostingServiceAllocationStatus.RELEASED);

    // ── (b) ORDRE B observé : demande 1 BLOQUÉE dans la phase réseau (barrière),
    //     demande 2 se COMPLETE entièrement, puis on relâche la barrière.
    const orderB = await seedOrder('t10b');
    await runProvision(orderB);
    const depB = await prisma.deployment.findUniqueOrThrow({ where: { orderId: orderB } });
    const allocB = await allocOf(orderB);
    allocIds.push(allocB!.id);

    let resumeR1!: () => void;
    const gate = new Promise<void>((r) => {
      resumeR1 = r;
    });
    const callsBefore = fakeDeleteApplication.mock.calls.length;
    fakeDeleteApplication.mockImplementationOnce(async () => {
      await gate; // barrière : remove1 tient la phase réseau jusqu'au relâchement
    });
    const r1 = deployments.remove(depB.id, actor());
    await waitFor(
      'remove1 bloquée sur le transport (barrière atteinte)',
      () => Promise.resolve(fakeDeleteApplication.mock.calls.length),
      (n) => n === callsBefore + 1,
    );

    // remove2 se déroule COMPLÈTEMENT pendant que remove1 attend :
    const outB2 = await deployments.remove(depB.id, actor());
    expect(outB2.c4?.release.status).toBe('released');
    expect(outB2.freedQuota).toBe(true);

    // Relâchement : remove1 reprend, conclut déjà-libérée (aucun double-free).
    resumeR1();
    const outB1 = await r1;
    expect(outB1.removed).toBe(true);
    expect(outB1.c4?.release.status).toBe('already_released');
    expect(outB1.freedQuota).toBe(true); // D9 : RELEASED relu fraîchement

    // Invariant sous les DEUX ordres : UNE seule libération, UNE seule preuve.
    expect(await prisma.c4ReleaseEvidence.count({ where: { allocationId: allocB!.id } })).toBe(1);
    expect(
      (await prisma.hostingServiceAllocation.findUniqueOrThrow({ where: { id: allocB!.id } }))
        .status,
    ).toBe(HostingServiceAllocationStatus.RELEASED);
    expect(await prisma.deployment.findUnique({ where: { id: depB.id } })).toBeNull();
    expect(
      await prisma.clientSubdomain.count({ where: { deploymentId: depB.id } }),
    ).toBe(0); // liée avant suppression, supprimée avec (jamais résiduelle)
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 13 — terminaison d'un service ACTIF (le 2ᵉ visage de « ressources » vs suppression d'app)
  // ═══════════════════════════════════════════════════════════════════════
  it('terminaison d’un service ACTIF : stops + libérations + terminal CANCELLED sous preuves', async () => {
    const orderId = await seedOrder('t11term');
    await runProvision(orderId);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      OrderStatus.ACTIVE,
    );
    const alloc = await allocOf(orderId);
    allocIds.push(alloc!.id);
    expect(alloc?.status).toBe(HostingServiceAllocationStatus.BOUND);

    const out = await orderCancel.terminateActiveService(
      orderId,
      'motif e2e terminaison suffisant',
      actor(),
    );
    expect(out.orderStatus).toBe(OrderStatus.CANCELLED);
    expect(out.provider).toBe('deleted'); // nettoyage distant concluant
    expect(out.c4?.serviceStatus).toBe(HostingServiceStatus.CANCELLED); // terminal uniquement si tout libéré
    expect(out.c4?.releases).toHaveLength(1);
    expect(out.c4?.releases[0]?.status).toBe('released');

    const after = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: alloc!.id },
    });
    expect(after.status).toBe(HostingServiceAllocationStatus.RELEASED);
    expect(await prisma.c4ReleaseEvidence.count({ where: { allocationId: alloc!.id } })).toBe(1);
    expect(
      await prisma.c4StopRequest.findFirst({ where: { scopeType: 'ORDER', scopeId: orderId } }),
    ).toBeTruthy();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 14 — D10 : ORDRES DÉMONTRÉS + verrou FOR UPDATE OBSERVÉ (pg_locks)
  // ═══════════════════════════════════════════════════════════════════════
  it('D10 ordres démontrés (annulation→réservation, réservation→annulation) + verrou HostingService observé (pg_locks)', async () => {
    const mkSub = async () => {
      const s = await prisma.subscription.create({
        data: { userId: member2UserId, productId: prodId, status: 'ACTIVE' },
      });
      subIds.push(s.id);
      return s;
    };
    const mkSvc = (subId: string, status: HostingServiceStatus) =>
      prisma.hostingService.create({
        data: {
          userId: member2UserId,
          subscriptionId: subId,
          productId: prodId,
          packId,
          deploymentModuleId: modId,
          status,
          maxAppsSnapshot: null,
          ramMbSnapshot: 512,
          cpuCoresSnapshot: 1,
          storageLimitGbSnapshot: null,
          packNameSnapshot: `c4-pack-${stamp}`,
          productNameSnapshot: `c4-${stamp}`,
        },
      });
    const consuming = (svcId: string) =>
      prisma.hostingServiceAllocation.count({
        where: {
          hostingServiceId: svcId,
          status: {
            in: [
              HostingServiceAllocationStatus.RESERVED,
              HostingServiceAllocationStatus.BOUND,
              HostingServiceAllocationStatus.RELEASING,
            ],
          },
        },
      });
    const reserve = (svcId: string) =>
      hosting.reserveSlot({
        hostingServiceId: svcId,
        actorUserId: member2UserId,
        clientRequestId: newClientRequestId(),
        payload: samplePayload(),
      });
    const cancel = (subId: string) =>
      subscriptions.cancelMySubscription(subId, { sub: member2UserId, email: member2Email });

    // ── ORDRÉ A observé : annulation COMPLÈTE (service terminé) → la
    //    réservation ultérieure est REFUSÉE, zéro slot consommant.
    const subA = await mkSub();
    const svcA = await mkSvc(subA.id, HostingServiceStatus.CANCELLED);
    serviceIds.push(svcA.id);
    await expect(cancel(subA.id)).resolves.toMatchObject({ status: 'CANCELLED' });
    await expect(reserve(svcA.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await consuming(svcA.id)).toBe(0);
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: subA.id } })).status,
    ).toBe('CANCELLED');

    // ── ORDRÉ B observé : réservation COMPLÈTE → annulation REFUSÉE (409).
    const subB = await mkSub();
    const svcB = await mkSvc(subB.id, HostingServiceStatus.ACTIVE);
    serviceIds.push(svcB.id);
    await expect(reserve(svcB.id)).resolves.toMatchObject({
      replayed: false,
      allocation: { status: HostingServiceAllocationStatus.RESERVED },
    });
    expect(await consuming(svcB.id)).toBe(1);
    await expect(cancel(subB.id)).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: subB.id } })).status,
    ).toBe('ACTIVE');

    // ── VERROU OBSERVÉ : on tient "HostingService" FOR UPDATE dans une TX
    //    ouverte pendant que l'annulation tente son propre verrou : pg_locks
    //    montre granted=false, l'annulation n'a PAS encore tranché, puis elle
    //    échoue (409) une fois le verrou libéré — ordre imposé, pas de course.
    let cancelSettled = false;
    let cancelP: Promise<{ ok: true } | { ok: false; e: unknown }> | null = null;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "HostingService" WHERE "id" = ${svcB.id} FOR UPDATE`;
      cancelP = cancel(subB.id).then(
        () => {
          cancelSettled = true;
          return { ok: true as const };
        },
        (e: unknown) => {
          cancelSettled = true;
          return { ok: false as const, e };
        },
      );
      await waitFor(
        'pg_locks : attente du verrou HostingService observée',
        () =>
          prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_locks WHERE granted = false`,
        (rows) => Number(rows[0]?.n ?? 0) > 0,
      );
      expect(cancelSettled).toBe(false); // observé : l'annulation ATTEND le verrou
    }); // commit → verrou libéré → l'annulation reprend et tranche

    const outcome = (await cancelP!) as { ok: false; e: unknown };
    expect(outcome.ok).toBe(false); // D10 : refusée, slot toujours consommant
    expect(outcome.e).toBeInstanceOf(ConflictException);
    expect(await consuming(svcB.id)).toBe(1);
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: subB.id } })).status,
    ).toBe('ACTIVE');

    // Invariant D10 : JAMAIS de souscription CANCELLED avec un slot consommant.
    for (const pair of [
      [subA.id, svcA.id],
      [subB.id, svcB.id],
    ] as const) {
      const subStatus = (
        await prisma.subscription.findUniqueOrThrow({ where: { id: pair[0] } })
      ).status;
      if (subStatus === 'CANCELLED') {
        expect(await consuming(pair[1])).toBe(0);
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 15 — suspension admin : AUCUN slot libéré (D9/C4 intacts), D10 opposable
  // ═══════════════════════════════════════════════════════════════════════
  it('suspension admin (SUSPENDED) : AUCUN slot libéré, zéro preuve C4, D10 toujours opposable', async () => {
    const sub = await prisma.subscription.create({
      data: { userId: member2UserId, productId: prodId, status: 'ACTIVE' },
    });
    subIds.push(sub.id);
    const svc = await prisma.hostingService.create({
      data: {
        userId: member2UserId,
        subscriptionId: sub.id,
        productId: prodId,
        packId,
        deploymentModuleId: modId,
        status: HostingServiceStatus.ACTIVE,
        maxAppsSnapshot: null,
        ramMbSnapshot: 512,
        cpuCoresSnapshot: 1,
        storageLimitGbSnapshot: null,
        packNameSnapshot: `c4-pack-${stamp}`,
        productNameSnapshot: `c4-${stamp}`,
      },
    });
    serviceIds.push(svc.id);
    const alloc = await prisma.hostingServiceAllocation.create({
      data: { hostingServiceId: svc.id, idempotencyKey: `c4-susp-${stamp}` },
    });
    allocIds.push(alloc.id);

    const out = await subscriptions.updateSubscription(
      sub.id,
      { status: SubscriptionStatus.SUSPENDED },
      { sub: adminUserId, email: adminEmail },
    );
    expect(out.status).toBe(SubscriptionStatus.SUSPENDED);

    // AUCUN slot libéré : la suspension ne touche ni allocation, ni preuve, ni arrêt.
    const after = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: alloc.id },
    });
    expect(after.status).toBe(HostingServiceAllocationStatus.RESERVED);
    expect(await prisma.c4ReleaseEvidence.count({ where: { allocationId: alloc.id } })).toBe(0);
    expect(
      await prisma.c4StopRequest.findFirst({ where: { scopeType: 'ALLOCATION', scopeId: alloc.id } }),
    ).toBeNull();

    // D10 toujours opposable après suspension : annulation → 409, zéro transition.
    await expect(
      subscriptions.cancelMySubscription(sub.id, { sub: member2UserId, email: member2Email }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status,
    ).toBe(SubscriptionStatus.SUSPENDED);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Capability : LIVE probe des 5 tables sous ON
  // ═══════════════════════════════════════════════════════════════════════
  it('capability C4 : operational() = true sur base migrée (5 tables + index)', async () => {
    expect(await c4c.operational()).toBe(true);
    await expect(c4c.assertOperational()).resolves.toBeUndefined();
  });
});
