import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import {
  BillingCycle,
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
import { installFingerprintEnv } from './hosting-reservation.fixture';
import { acceptanceFor, preloadAcceptance } from './pricing-acceptance.fixture';

/**
 * Q12-P3 — résolution abonnement → service « réelle » (e2e, PostgreSQL réel) :
 *
 *  1. **Parcours checkout/provisioning C3 réel** : la confirmation crée le
 *     `HostingService` AVEC son `subscriptionId` (lien abonnement → service
 *     posé dans la MÊME transaction) — défaut d'origine : `subscriptionId`
 *     jamais renseigné → toute suspension résolvait « rien » ;
 *     suspension/réactivation admin basculent le service ET dispatchent les
 *     apps de l'abonnement (stop/start réversibles, aucune suppression) ;
 *  2. **Ligne legacy C2** (service SANS `subscriptionId`, app reliée UNIQUEMENT
 *     par son allocation — `Deployment.hostingServiceId`/`orderId` null) :
 *     la suspension se fait via l'`orderId` réel de l'abonnement, l'app est
 *     trouvée via `HostingServiceAllocation` ;
 *  3. **Isolation** : suspendre l'abonnement legacy ne touche JAMAIS le
 *     service de l'autre abonnement.
 *
 * Aucun réseau : PanelTransportFactory + MailTransportFactory stubbés,
 * C4 ON (les dispatches stop/start et le provisioning passent par le
 * protocole — tentatives durablement consignées), C3 ON.
 */
describe('Résolution abonnement → service réelle (e2e, Q12-P3)', () => {
  process.env.HOSTING_C3_ENABLED = 'true';
  process.env.ORDER_SWEEP_ENABLED = 'false';
  process.env.RENEWAL_SWEEP_ENABLED = 'false';
  process.env.HOSTING_C4_ENABLED = 'true';
  installFingerprintEnv();

  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const memberEmail = `p3member_${stamp}@example.com`;
  const adminEmail = `p3admin_${stamp}@example.com`;
  const password = 'password123';
  let memberToken = '';
  let adminToken = '';
  let memberUserId = '';

  let srvId = '';
  let modId = '';
  let packId = '';
  let provId = '';
  let pmId = '';
  let prodId = '';
  let prodSlug = '';

  const allOrderIds: string[] = [];
  const guestEmails: string[] = [];

  let createGitAppCalls = 0;
  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };

  const stopCalls: Array<{ provider: string; uuid: string }> = [];
  const startCalls: Array<{ provider: string; uuid: string }> = [];
  const deleteCalls: string[] = [];

  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport =>
      ({
        verify: jest.fn().mockResolvedValue({ ok: true, detail: 'FAKE PANEL OK' }),
        createGitApp: jest.fn(async () => {
          createGitAppCalls += 1;
          return { uuid: `app-${createGitAppCalls}` };
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
        deleteApplication: jest.fn(async (uuid: string) => {
          deleteCalls.push(uuid);
          throw new Error('SUPPRESSION INTERDITE');
        }),
        deploymentStatus: jest.fn().mockResolvedValue({ rawStatus: 'finished' }),
        stopApplication: jest.fn(async (_t: PanelTargetLike, uuid: string) => {
          stopCalls.push({ provider: 'COOLIFY', uuid });
        }),
        startApplication: jest.fn(async (_t: PanelTargetLike, uuid: string) => {
          startCalls.push({ provider: 'COOLIFY', uuid });
        }),
      }) as unknown as PanelTransport,
  } as unknown as PanelTransportFactory;

  type PanelTargetLike = { provider: string };

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
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timeout (30s) waiting for ${label} — last=${JSON.stringify(last) ?? String(last)}`);
  }

  async function waitOrderActive(orderId: string): Promise<void> {
    await waitFor(
      `order ${orderId} ACTIVE`,
      () => prisma.order.findUnique({ where: { id: orderId } }),
      (o) => o?.status === OrderStatus.ACTIVE,
    );
  }

  function checkoutBody(over: Record<string, unknown>) {
    const productSlug = String(over.productSlug ?? '');
    const paymentMethodId = (over.paymentMethodId as string | undefined) ?? pmId;
    return {
      productSlug,
      paymentMethodId,
      name: 'Membre P3',
      email: memberEmail,
      // P7 : preuve d'acceptation tarifaire obligatoire (préchargée ; absente
      // si combinaison inconnue → 409 explicite si le chemin est payant).
      ...(acceptanceFor(productSlug, paymentMethodId) ?? {}),
      ...over,
    };
  }

  function placeOrder(body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/checkout`)
      .send(body)
      .set('Authorization', `Bearer ${memberToken}`);
  }

  async function confirmOrder(orderId: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/orders/${orderId}/confirm-payment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reference: 'RECETTE-P3' })
      .expect(201);
  }

  function patchSubscription(id: string, status: string) {
    return request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/subscriptions/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status });
  }

  // ── Boot + fixtures ───────────────────────────────────────────────────────
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransportFactory)
      .useValue(mailFactoryStub)
      .overrideProvider(PanelTransportFactory)
      .useValue(fakePanelFactory)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    limiter = moduleRef.get(SaRateLimiter);
    limiter.reset();

    await prisma.user.create({
      data: {
        email: memberEmail,
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.USER,
      },
    });
    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
      },
    });
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

    const member = await prisma.user.findUniqueOrThrow({ where: { email: memberEmail } });
    memberUserId = member.id;

    const server = await prisma.server.create({
      data: {
        name: `p3-srv-${stamp}`,
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
      data: { apiTokenEnc: moduleRef.get(CryptoService).encrypt('fake-coolify-token-p3') },
    });

    const mod = await prisma.deploymentModule.create({
      data: {
        name: `p3-mod-${stamp}`,
        code: `P3-${stamp}`,
        kind: 'SHARED_PROJECT',
        sharedProjectUuid: 'proj-p3-e2e',
        serverId: srvId,
      },
    });
    modId = mod.id;

    const pack = await prisma.hostingPack.create({
      data: {
        name: `p3-pack-${stamp}`,
        ramMb: 512,
        cpuCores: 1,
        storageLimit: null,
        maxApps: 2,
        deploymentModuleId: modId,
      },
    });
    packId = pack.id;

    const prov = await prisma.provisionMethod.create({
      data: {
        name: `p3-prov-${stamp}`,
        code: `p3-prov-${stamp}`,
        actions: [ProvisionAction.CREATE_APP],
      },
    });
    provId = prov.id;

    const pm = await prisma.paymentMethod.create({
      data: { name: `VIR-${stamp}`, type: PaymentMethodType.BANK_TRANSFER, isActive: true },
    });
    pmId = pm.id;

    prodSlug = `p3-prod-${stamp}`;
    const p = await prisma.product.create({
      data: {
        name: `p3-prod-${stamp}`,
        slug: prodSlug,
        status: 'ACTIVE',
        hidden: false,
        billingCycle: BillingCycle.MONTHLY,
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
    prodId = p.id;

    // P7 : preuve d'acceptation préchargée (produit + moyen créés ci-dessus).
    await preloadAcceptance(app.getHttpServer(), prodSlug, pmId);
  });

  afterAll(async () => {
    try {
      if (prisma) {
        const orderIds = [...allOrderIds];
        // Protocole C4 (ON ici) : tentatives/takeovers/évidences des
        // ordres, allocations et déploiements du membre — AVANT les entités.
        const c4Deps = await prisma.deployment
          .findMany({ where: { userId: memberUserId }, select: { id: true } })
          .catch(() => []);
        const c4Allocs = await prisma.hostingServiceAllocation
          .findMany({ where: { hostingService: { userId: memberUserId } }, select: { id: true } })
          .catch(() => []);
        const c4DepIds = c4Deps.map((d) => d.id);
        const c4AllocIds = c4Allocs.map((a) => a.id);
        await prisma.c4ProviderAttempt
          .deleteMany({
            where: {
              OR: [
                { orderId: { in: orderIds } },
                { allocationId: { in: c4AllocIds } },
                { scopeId: { in: [...orderIds, ...c4DepIds, ...c4AllocIds] } },
              ],
            },
          })
          .catch(() => undefined);
        await prisma.c4Takeover
          .deleteMany({ where: { scopeId: { in: [...orderIds, ...c4DepIds, ...c4AllocIds] } } })
          .catch(() => undefined);
        await prisma.c4StopRequest
          .deleteMany({ where: { scopeId: { in: [...orderIds, ...c4DepIds] } } })
          .catch(() => undefined);
        await prisma.c4ReleaseEvidence
          .deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { allocationId: { in: c4AllocIds } }] } })
          .catch(() => undefined);
        await prisma.c4ReadinessProof.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => undefined);

        await prisma.hostingServiceAllocation
          .deleteMany({ where: { hostingService: { orderId: { in: orderIds } } } })
          .catch(() => undefined);
        await prisma.hostingServiceAllocation
          .deleteMany({ where: { hostingService: { userId: memberUserId } } })
          .catch(() => undefined);
        await prisma.deployment.deleteMany({ where: { userId: memberUserId } }).catch(() => undefined);
        await prisma.provisioningLog.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => undefined);
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => undefined);
        await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => undefined);
        await prisma.hostingService.deleteMany({ where: { userId: memberUserId } }).catch(() => undefined);
        await prisma.subscription.deleteMany({ where: { userId: memberUserId } }).catch(() => undefined);
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => undefined);
        await prisma.customer.deleteMany({ where: { email: { in: [memberEmail, ...guestEmails] } } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { email: { in: [memberEmail, adminEmail] } } }).catch(() => undefined);
        await prisma.product.delete({ where: { id: prodId } }).catch(() => undefined);
        await prisma.provisionMethod.delete({ where: { id: provId } }).catch(() => undefined);
        await prisma.paymentMethod.delete({ where: { id: pmId } }).catch(() => undefined);
        await prisma.hostingPack.delete({ where: { id: packId } }).catch(() => undefined);
        await prisma.deploymentModule.delete({ where: { id: modId } }).catch(() => undefined);
        await prisma.server.delete({ where: { id: srvId } }).catch(() => undefined);
      }
    } catch {
      // meilleur effort
    }
    delete process.env.HOSTING_C3_ENABLED;
    delete process.env.HOSTING_C4_ENABLED;
    if (app) await app.close();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 1 — parcours checkout C3 réel : subscriptionId posé à la confirmation
  // ═══════════════════════════════════════════════════════════════════════
  let realOrderId = '';
  let realServiceId = '';
  let realSubId = '';
  let realUuid = '';
  let realDepId = '';

  it('confirmation C3 : HostingService créé AVEC subscriptionId (lien abonnement réel)', async () => {
    const res = await placeOrder(checkoutBody({ productSlug: prodSlug })).expect(201);
    realOrderId = res.body.orderId as string;
    allOrderIds.push(realOrderId);
    expect(res.body.nextStep).toBe('payment-pending');
    // Aucun droit avant confirmation (C3).
    expect(await prisma.hostingService.count({ where: { orderId: realOrderId } })).toBe(0);
    expect(await prisma.subscription.count({ where: { userId: memberUserId } })).toBe(0);

    await confirmOrder(realOrderId);

    // LA preuve P3 : le lien abonnement → service est posé dans la même tx.
    const sub = await prisma.subscription.findFirstOrThrow({
      where: { userId: memberUserId, orderId: realOrderId },
    });
    realSubId = sub.id;
    const svc = await prisma.hostingService.findFirstOrThrow({
      where: { orderId: realOrderId },
    });
    realServiceId = svc.id;
    expect(svc.subscriptionId).toBe(realSubId);

    // Provisioning réel → deployment + allocation BOUND (modèle C2).
    await waitOrderActive(realOrderId);
    const dep = await prisma.deployment.findUniqueOrThrow({ where: { orderId: realOrderId } });
    realUuid = dep.coolifyUuid!;
    realDepId = dep.id;
    expect(dep.status).toBe(DeploymentStatus.ACTIVE);
    const svcFinal = await prisma.hostingService.findUniqueOrThrow({
      where: { id: realServiceId },
    });
    expect(svcFinal.status).toBe(HostingServiceStatus.ACTIVE);
    const alloc = await prisma.hostingServiceAllocation.findFirstOrThrow({
      where: { hostingServiceId: realServiceId },
    });
    expect(alloc.status).toBe(HostingServiceAllocationStatus.BOUND);
    expect(alloc.deploymentId).toBe(dep.id);
  });

  it('suspension admin : service basculé via subscriptionId + apps dispatchées (stop réversible)', async () => {
    const r = await patchSubscription(realSubId, 'SUSPENDED').expect(200);
    expect(r.body.effects).toMatchObject({ apps: 1, done: 1, blocked: 0, failed: 0 });
    const svc = await prisma.hostingService.findUniqueOrThrow({
      where: { id: realServiceId },
      select: { status: true, subscriptionId: true },
    });
    expect(svc.status).toBe(HostingServiceStatus.SUSPENDED);
    expect(svc.subscriptionId).toBe(realSubId);
    expect(stopCalls).toContainEqual({ provider: 'COOLIFY', uuid: realUuid });
    expect(startCalls.some((c) => c.uuid === realUuid)).toBe(false);
    expect(deleteCalls).toHaveLength(0);
    // Sous C4 ON : l'arrêt est une tentative CONFIGURE durable consignée.
    const stopAttempts = await prisma.c4ProviderAttempt.findMany({
      where: { scopeId: realDepId, nature: 'CONFIGURE' },
      orderBy: { dispatchedAt: 'asc' },
    });
    expect(stopAttempts).toHaveLength(1);
    expect(stopAttempts[0].phase).toBe('RETURNED');
    expect(stopAttempts[0].outcome).toBe('SUCCESS');

    const r2 = await patchSubscription(realSubId, 'ACTIVE').expect(200);
    expect(r2.body.effects).toMatchObject({ apps: 1, done: 1, blocked: 0, failed: 0, mode: 'c4' });
    expect(startCalls).toContainEqual({ provider: 'COOLIFY', uuid: realUuid });
    const startAttempts = await prisma.c4ProviderAttempt.findMany({
      where: { scopeId: realDepId, nature: 'CONFIGURE' },
      orderBy: { dispatchedAt: 'asc' },
    });
    expect(startAttempts).toHaveLength(2);
    expect(startAttempts[1].outcome).toBe('SUCCESS');
    const svc2 = await prisma.hostingService.findUniqueOrThrow({
      where: { id: realServiceId },
      select: { status: true },
    });
    expect(svc2.status).toBe(HostingServiceStatus.ACTIVE);
    expect(deleteCalls).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2 — ligne legacy C2 : service sans subscriptionId, app via allocation
  // ═══════════════════════════════════════════════════════════════════════
  let legacySubId = '';
  let legacyServiceId = '';
  const legacyUuid = 'uuid-p3-legacy';

  it('ligne legacy (subscriptionId null, app liée UNIQUEMENT par allocation) : suspension réelle', async () => {
    const customer = await prisma.customer.findFirstOrThrow({ where: { userId: memberUserId } });
    const legacyOrder = await prisma.order.create({
      data: {
        customerId: customer.id,
        customerName: 'Membre P3',
        customerEmail: memberEmail,
        productId: prodId,
        productName: `p3-prod-${stamp}`,
        status: OrderStatus.ACTIVE,
        amountHtCents: 4900,
        taxAmountCents: 0,
        amountTtcCents: 4900,
        paymentMethodId: pmId,
        paymentMethodName: `VIR-${stamp}`,
        idempotencyKey: `p3-legacy-${stamp}`,
      },
    });
    allOrderIds.push(legacyOrder.id);
    const legacySub = await prisma.subscription.create({
      data: {
        userId: memberUserId,
        productId: prodId,
        status: SubscriptionStatus.ACTIVE,
        orderId: legacyOrder.id,
      },
    });
    legacySubId = legacySub.id;
    // Shape C2/legacy : service SANS lien d'abonnement (subscriptionId null).
    const legacySvc = await prisma.hostingService.create({
      data: {
        userId: memberUserId,
        orderId: legacyOrder.id,
        productId: prodId,
        status: HostingServiceStatus.ACTIVE,
        ramMbSnapshot: 512,
        cpuCoresSnapshot: 1,
      },
    });
    legacyServiceId = legacySvc.id;
    expect(legacySvc.subscriptionId).toBeNull();
    // App legacy : hostingServiceId NULL, orderId NULL — lien UNIQUEMENT via allocation.
    const legacyDep = await prisma.deployment.create({
      data: {
        userId: memberUserId,
        serverId: srvId,
        repoFullName: `membre-${stamp}/legacy`,
        coolifyUuid: legacyUuid,
        status: DeploymentStatus.ACTIVE,
      },
    });
    await prisma.hostingServiceAllocation.create({
      data: {
        hostingServiceId: legacyServiceId,
        deploymentId: legacyDep.id,
        idempotencyKey: `p3-legacy-alloc-${stamp}`,
        status: HostingServiceAllocationStatus.BOUND,
      },
    });

    const r = await patchSubscription(legacySubId, 'SUSPENDED').expect(200);
    // Le service est trouvé par l'orderId RÉEL de l'abonnement (fallback legacy).
    expect(r.body.effects).toMatchObject({ apps: 1, done: 1, blocked: 0, failed: 0 });
    const svc = await prisma.hostingService.findUniqueOrThrow({
      where: { id: legacyServiceId },
      select: { status: true, subscriptionId: true },
    });
    expect(svc.status).toBe(HostingServiceStatus.SUSPENDED);
    expect(svc.subscriptionId).toBeNull(); // toujours legacy, jamais réécrit
    // L'app n'est trouvée QUE par son ALLOCATION (aucun lien direct).
    expect(stopCalls).toContainEqual({ provider: 'COOLIFY', uuid: legacyUuid });

    const r2 = await patchSubscription(legacySubId, 'ACTIVE').expect(200);
    expect(r2.body.effects).toMatchObject({ apps: 1, done: 1, blocked: 0, failed: 0 });
    expect(startCalls).toContainEqual({ provider: 'COOLIFY', uuid: legacyUuid });
    expect(deleteCalls).toHaveLength(0);
  });

  it('isolation : suspendre l\u2019abonnement legacy ne touche JAMAIS l\u2019autre service', async () => {
    const svc = await prisma.hostingService.findUniqueOrThrow({
      where: { id: realServiceId },
      select: { status: true },
    });
    expect(svc.status).toBe(HostingServiceStatus.ACTIVE);
    // Et l'app réelle n'a reçu AUCUN stop supplémentaire pendant la bascule legacy.
    expect(stopCalls.filter((c) => c.uuid === realUuid)).toHaveLength(1);
    expect(startCalls.filter((c) => c.uuid === realUuid)).toHaveLength(1);
  });
});
