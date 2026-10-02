import { INestApplication, ValidationPipe } from '@nestjs/common';
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
} from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { CryptoService } from './../src/crypto/crypto.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { PanelTransport, PanelTransportFactory } from './../src/servers/panel-transport.factory';
import { ProvisioningService } from './../src/store/provisioning.service';
import { HostingServicesService } from './../src/hosting/hosting-services.service';
import {
  installFingerprintEnv,
  newClientRequestId,
  samplePayload,
} from './hosting-reservation.fixture';

/**
 * 17B.4F-C3 — e2e SUR BASE ISOLÉE (`icode_host_pro_c3test`, identité vérifiée)
 * avec `HOSTING_C3_ENABLED=true`. Couvre les scénarios critiques réclamés par
 * la revue C3, sur PostgreSQL RÉEL (jamais simulé) :
 *
 *  1. cycle de vie complet : checkout → provisioning → Order/Deployment ACTIFS,
 *     allocation BOUND et HostingService `PROVISIONING → ACTIVE` (la preuve
 *     finale est requise, sinon le service reste réservable-bas) ;
 *  2. le service devient RÉELLEMENT utilisable (réservation directe C1) avec
 *     le quota maxApps TOUJOURS respecté (contrôle négatif sur service
 *     encore PROVISIONING : même réservation refusée « non actif ») ;
 *  3. double-clic (2 checkouts simultanés, même clé) → UNE commande, UNE
 *     séquence provider (un seul createGitApp) ;
 *  4. même utilisateur, clés différentes → commandes distinctes ;
 *  5. deux provisionOrder concurrents sur la même commande → un seul claim,
 *     une seule séquence provider ;
 *  6. provider OK / persistance KO → états réellement atteints (intention +
 *     token durcis), retry → 409 SANS takeover, token préservé, y compris à
 *     lease expiré ;
 *  7. bind réussi / activation impossible (preuve absente) → état réel
 *     restitué en lecture seule, aucun appel provider, aucune activation
 *     forcée, service jamais basculé à tort.
 *
 * Coutures (AUCUN réseau réel) : PanelTransportFactory (createGitApp compté,
 * deploymentStatus « finished » = preuve Coolify ACTIVE), MailTransportFactory
 * (jamais de SMTP). PrismaService / CryptoService RÉELS sur la base isolée.
 */
describe('Provisioning C3 — e2e base isolée (HOSTING_C3_ENABLED=true)', () => {
  process.env.HOSTING_C3_ENABLED = 'true';
  // Sweep de reprise (P2) : désactivé — il relancerait des provisionOrder derrière
  // le dos des baselines de compteurs provider de cette suite.
  process.env.ORDER_SWEEP_ENABLED = 'false';
  installFingerprintEnv();

  let app: INestApplication;
  let prisma: PrismaService;
  let provisioning: ProvisioningService;
  let hostingSvc: HostingServicesService;
  let limiter: SaRateLimiter;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const memberEmail = `c3member_${stamp}@example.com`;
  const member2Email = `c3member2_${stamp}@example.com`;
  const adminEmail = `c3admin_${stamp}@example.com`;
  const password = 'password123';
  let memberToken = '';
  let member2Token = '';
  let adminToken = '';
  let memberUserId = '';

  let srvId = '';
  let modId = '';
  let packId = '';
  let provId = '';
  let pmId = '';
  let prodAId = '';
  let prodBId = '';
  let prodCId = '';

  const allOrderIds: string[] = [];
  const guestEmails: string[] = [];

  let createGitAppCalls = 0;
  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };

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
        deleteApplication: jest.fn().mockResolvedValue(undefined),
        deploymentStatus: jest.fn().mockResolvedValue({ rawStatus: 'finished' }),
      }) as unknown as PanelTransport,
  } as unknown as PanelTransportFactory;

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
    await waitFor(`order ${orderId} ACTIVE`, () => prisma.order.findUnique({ where: { id: orderId } }), (o) => o?.status === OrderStatus.ACTIVE);
  }

  function checkoutBody(over: Record<string, unknown>, email: string = memberEmail) {
    return {
      productSlug: '',
      paymentMethodId: pmId,
      name: 'Membre C3',
      email,
      ...over,
    };
  }

  function placeOrder(body: Record<string, unknown>, token?: string): request.Test {
    const req = request(app.getHttpServer()).post(`/${GlobalPrefix}/store/checkout`).send(body);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  /** Confirmation ADMIN du règlement : SEUL déclencheur des droits C3 (P2). */
  async function confirmOrder(orderId: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/orders/${orderId}/confirm-payment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reference: 'RECETTE' })
      .expect(201);
  }

  /** Commande C3 pré-checkout (mêmes écrits que checkout.service, sans fire-and-forget). */
  async function seedC3Order(tag: string): Promise<string> {
    const email = `seed-${tag}-${stamp}@example.com`;
    // Customer 1:1 avec l'utilisateur : on RÉUTILISE celui du membre (créé au
    // checkout S0) plutôt que d'en créer un second (contrainte unique userId).
    const customer =
      (await prisma.customer.findFirst({ where: { userId: memberUserId } })) ??
      (await prisma.customer.create({
        data: { email, name: `Seed ${tag}`, userId: memberUserId },
      }));
    if (customer.email === email) guestEmails.push(email);
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        customerName: `Seed ${tag}`,
        customerEmail: email,
        productId: prodAId,
        productName: `c3-a-${stamp}`,
        packId,
        status: OrderStatus.PAID,
        amountHtCents: 4900,
        taxAmountCents: 0,
        amountTtcCents: 4900,
        paymentMethodId: pmId,
        paymentMethodName: `CB-${stamp}`,
        idempotencyKey: `seed-${tag}-${stamp}`,
      },
    });
    allOrderIds.push(order.id);
    await prisma.orderProvisioningTracking.create({
      data: {
        orderId: order.id,
        intent: {
          business: {
            productId: prodAId,
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
    await prisma.hostingService.create({
      data: {
        userId: memberUserId,
        orderId: order.id,
        productId: prodAId,
        packId,
        deploymentModuleId: modId,
        status: HostingServiceStatus.PROVISIONING,
        maxAppsSnapshot: 1,
        ramMbSnapshot: 512,
        cpuCoresSnapshot: 1,
        storageLimitGbSnapshot: null,
        packNameSnapshot: `c3-pack-${stamp}`,
        productNameSnapshot: `c3-a-${stamp}`,
      },
    });
    return order.id;
  }

  const runProvision = (orderId: string) => provisioning.provisionOrder(orderId);

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
    provisioning = moduleRef.get(ProvisioningService);
    hostingSvc = moduleRef.get(HostingServicesService);
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
        email: member2Email,
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
    const member = await prisma.user.findUniqueOrThrow({ where: { email: memberEmail } });
    memberUserId = member.id;
    memberToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: memberEmail, password })
        .expect(201)
    ).body.accessToken as string;
    member2Token = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: member2Email, password })
        .expect(201)
    ).body.accessToken as string;
    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;
    expect(memberToken).toBeTruthy();
    expect(member2Token).toBeTruthy();
    expect(adminToken).toBeTruthy();

    const server = await prisma.server.create({
      data: {
        name: `c3-srv-${stamp}`,
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
        name: `c3-mod-${stamp}`,
        code: `C3-${stamp}`,
        kind: 'SHARED_PROJECT',
        sharedProjectUuid: 'proj-c3-e2e',
        serverId: srvId,
      },
    });
    modId = mod.id;

    const pack = await prisma.hostingPack.create({
      data: {
        name: `c3-pack-${stamp}`,
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
        name: `c3-prov-${stamp}`,
        code: `c3-prov-${stamp}`,
        actions: [ProvisionAction.CREATE_APP],
      },
    });
    provId = prov.id;

    const pm = await prisma.paymentMethod.create({
      // BANK_TRANSFER : la méthode CARTe est refusée au checkout sans simulateur
      // de paiement activé (règle P2) — voir store-payment-confirmation e2e.
      data: { name: `VIR-${stamp}`, type: PaymentMethodType.BANK_TRANSFER, isActive: true },
    });
    pmId = pm.id;

    const mkProduct = async (slug: string): Promise<string> => {
      const p = await prisma.product.create({
        data: {
          name: `${slug}-${stamp}`,
          slug,
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
      return p.id;
    };
    prodAId = await mkProduct(`c3-a-${stamp}`);
    prodBId = await mkProduct(`c3-b-${stamp}`);
    prodCId = await mkProduct(`c3-c-${stamp}`);
  });

  afterAll(async () => {
    const orderIds = [...allOrderIds];
    // Abonnements (order-driven, créés par chaque achat pack) — AVANT produits.
    await prisma.subscription
      .deleteMany({ where: { user: { email: { in: [...guestEmails, memberEmail, member2Email] } } } })
      .catch(() => {});
    await prisma.hostingServiceAllocation
      .deleteMany({ where: { hostingService: { orderId: { in: orderIds } } } })
      .catch(() => {});
    await prisma.deployment.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.provisioningLog.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.hostingService.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await prisma.customer
      .deleteMany({ where: { email: { in: [...guestEmails, memberEmail, member2Email] } } })
      .catch(() => {});
    await prisma.user
      .deleteMany({ where: { email: { in: [...guestEmails, memberEmail, member2Email, adminEmail] } } })
      .catch(() => {});
    await prisma.product.deleteMany({ where: { id: { in: [prodAId, prodBId, prodCId] } } }).catch(() => {});
    await prisma.provisionMethod.deleteMany({ where: { id: provId } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: pmId } }).catch(() => {});
    await prisma.hostingPack.deleteMany({ where: { id: packId } }).catch(() => {});
    await prisma.deploymentModule.deleteMany({ where: { id: modId } }).catch(() => {});
    await prisma.server.deleteMany({ where: { id: srvId } }).catch(() => {});
    delete process.env.HOSTING_C3_ENABLED;
    await app.close();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 1 + 2 — cycle de vie complet + service utilisable + quota
  // ═══════════════════════════════════════════════════════════════════════
  describe('cycle de vie C3 complet (checkout → ACTIVE)', () => {
    let s0OrderId = '';
    let s0ServiceId = '';

    it('checkout C3 → provisioning → Order/Deployment ACTIFS, allocation BOUND, HostingService ACTIVE', async () => {
      const res = await placeOrder(
        checkoutBody({ productSlug: `c3-a-${stamp}` }),
        memberToken,
      ).expect(201);
      s0OrderId = res.body.orderId as string;
      allOrderIds.push(s0OrderId);

      // P2 : checkout payant = PENDING_PAYMENT, AUCUN droit C3 avant confirmation
      // du règlement (ni service, ni abonnement, ni tracking, ni provisioning).
      expect(res.body.nextStep).toBe('payment-pending');
      const pending = await prisma.order.findUniqueOrThrow({ where: { id: s0OrderId } });
      expect(pending.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(await prisma.hostingService.count({ where: { orderId: s0OrderId } })).toBe(0);
      expect(
        await prisma.orderProvisioningTracking.count({ where: { orderId: s0OrderId } }),
      ).toBe(0);
      expect(await prisma.subscription.count({ where: { user: { email: memberEmail } } })).toBe(0);

      await confirmOrder(s0OrderId);
      await waitOrderActive(s0OrderId);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: s0OrderId } });
      expect(order.status).toBe(OrderStatus.ACTIVE);

      const dep = await prisma.deployment.findUniqueOrThrow({ where: { orderId: s0OrderId } });
      expect(dep.status).toBe(DeploymentStatus.ACTIVE);
      expect(dep.coolifyUuid).toBeTruthy();

      const svc = await prisma.hostingService.findUniqueOrThrow({ where: { orderId: s0OrderId } });
      s0ServiceId = svc.id;
      // Le point de la revue : le service ne reste PAS bloqué en PROVISIONING.
      expect(svc.status).toBe(HostingServiceStatus.ACTIVE);

      const alloc = await prisma.hostingServiceAllocation.findFirstOrThrow({
        where: { hostingServiceId: svc.id },
      });
      expect(alloc.status).toBe(HostingServiceAllocationStatus.BOUND);
      expect(alloc.deploymentId).toBe(dep.id);
      expect(alloc.providerIntentAt).toBeTruthy();
    });

    it('service ACTIF ⇒ réservation directe utilisable, avec quota maxApps TOUJOURS respecté', async () => {
      // maxApps = 1 et l'allocation C3 BOUND consomme déjà le slot → la
      // réservation doit être refusée PAR LE QUOTA (et non par le statut) :
      // la porte « service réservable » est ouverte (ACTIVE), le quota tient.
      await expect(
        hostingSvc.reserveSlot({
          hostingServiceId: s0ServiceId,
          actorUserId: memberUserId,
          clientRequestId: newClientRequestId(),
          payload: samplePayload(),
        }),
      ).rejects.toThrow(/Quota de slots atteint/);
      // Contrôle : UNE seule ligne d'allocation C3 existe toujours.
      const count = await prisma.hostingServiceAllocation.count({
        where: { hostingServiceId: s0ServiceId },
      });
      expect(count).toBe(1);
    });

    it('contrôle : service encore PROVISIONING ⇒ même réservation refusée « non actif »', async () => {
      const orderId = await seedC3Order('ctrl-prov');
      const svc = await prisma.hostingService.findUniqueOrThrow({ where: { orderId } });
      expect(svc.status).toBe(HostingServiceStatus.PROVISIONING);
      await expect(
        hostingSvc.reserveSlot({
          hostingServiceId: svc.id,
          actorUserId: memberUserId,
          clientRequestId: newClientRequestId(),
          payload: samplePayload(),
        }),
      ).rejects.toThrow(/service non actif/);
      // Jamais de flip : aucune preuve n'a eu lieu, le service n'a jamais été
      // provisionné (c'est le contrôle qui prouve que le flip n'est pas fait
      // à la légère et que le « utilisable » vient bien du parcours complet).
      const svcAfter = await prisma.hostingService.findUniqueOrThrow({ where: { id: svc.id } });
      expect(svcAfter.status).toBe(HostingServiceStatus.PROVISIONING);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3 + 5 — double-clic simultané et provisionnements concurrents
  // ═══════════════════════════════════════════════════════════════════════
  describe('concurrence', () => {
    it('double-clic (2 checkouts SIMULTANÉS, même clé) → UNE commande, UNE séquence provider', async () => {
      limiter.reset();
      // Compte FRAIS (member2) : le premier achat pack y crée l'abonnement ;
      // les deux requêtes simultanées portent la MÊME clé d'idempotence.
      const body = checkoutBody({ productSlug: `c3-b-${stamp}` }, member2Email);
      const baseline = createGitAppCalls;

      const [r1, r2] = await Promise.all([
        placeOrder(body, member2Token).expect(201),
        placeOrder(body, member2Token).expect(201),
      ]);
      const orderId = r1.body.orderId as string;
      expect(r2.body.orderId).toBe(orderId);
      allOrderIds.push(orderId);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const rowCount = await prisma.order.count({ where: { idempotencyKey: order.idempotencyKey } });
      expect(rowCount).toBe(1);
      // P2 : les deux rejeux n'ont ouvert AUCUN droit — UNE commande en attente.
      expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(await prisma.hostingService.count({ where: { orderId } })).toBe(0);

      await confirmOrder(orderId);
      const svcCount = await prisma.hostingService.count({ where: { orderId } });
      expect(svcCount).toBe(1);

      await waitOrderActive(orderId);
      // Les deux fire-and-forget concurrents : une seule séquence provider.
      expect(createGitAppCalls - baseline).toBe(1);
    });

    it('même utilisateur, clés DIFFÉRENTES → jamais de rejeu croisé (409 C4, aucune écriture parasite)', async () => {
      limiter.reset();
      // member1 détient déjà un abonnement actif (S0) : un second achat pack à
      // clé DIFFÉRENTE n'est JAMAIS rejoué dans la première commande — il est
      // refusé explicitement par la règle C4 « upgrade refusé sous C3 ».
      const before = await prisma.order.count({ where: { customerEmail: memberEmail } });
      const res = await placeOrder(
        checkoutBody({ productSlug: `c3-c-${stamp}` }),
        memberToken,
      );
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('upgrade non pris en charge en C3');

      const after = await prisma.order.count({ where: { customerEmail: memberEmail } });
      expect(after).toBe(before); // zéro nouvelle commande, zéro rejeu dans l'existant
      const s0Orders = await prisma.order.findMany({ where: { customerEmail: memberEmail } });
      const keys = s0Orders.map((o) => o.idempotencyKey);
      expect(new Set(keys).size).toBe(keys.length); // clés jamais recyclées
    });

    it('deux provisionOrder CONCURRENTS (même commande) → un seul claim, une seule séquence provider', async () => {
      const orderId = await seedC3Order('conc-prov');
      const baseline = createGitAppCalls;

      const results = await Promise.allSettled([runProvision(orderId), runProvision(orderId)]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // Quel que soit le chemin (busy 409 du second, ou état déjà complet en
      // lecture seule), JAMAIS deux séquences provider.
      expect(createGitAppCalls - baseline).toBe(1);

      await waitOrderActive(orderId);
      const deps = await prisma.deployment.count({ where: { orderId } });
      expect(deps).toBe(1);
      const allocs = await prisma.hostingServiceAllocation.count({
        where: { hostingService: { orderId } },
      });
      expect(allocs).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6 — provider OK / persistance KO + intention durable sans takeover
  // ═══════════════════════════════════════════════════════════════════════
  describe('persistance KO après provider (intention durable)', () => {
    it('bind KO → états réellement atteints ; retry ⇒ 409, token préservé, ZÉRO nouveau provider (même lease expiré)', async () => {
      const orderId = await seedC3Order('persist-ko');
      const baseline = createGitAppCalls;

      const failOnce = jest
        .spyOn(hostingSvc, 'markBoundInTx')
        .mockRejectedValueOnce(new Error('db down (simulation)'));
      await expect(runProvision(orderId)).rejects.toThrow(/db down/);
      failOnce.mockRestore();

      // États réellement atteints : provider exécuté, intention committée,
      // allocation réservée (JAMAIS liée), token du worker présent.
      expect(createGitAppCalls - baseline).toBe(1);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.PROVISIONING);
      const alloc = await prisma.hostingServiceAllocation.findFirstOrThrow({
        where: { hostingService: { orderId } },
      });
      expect(alloc.status).toBe(HostingServiceAllocationStatus.RESERVED);
      expect(alloc.providerIntentAt).toBeTruthy();
      expect(alloc.deploymentId).toBeNull();
      const tracking = await prisma.orderProvisioningTracking.findUniqueOrThrow({
        where: { orderId },
      });
      expect(tracking.claimToken).toBeTruthy();
      const tokenAfterFailure = tracking.claimToken;
      const svc = await prisma.hostingService.findUniqueOrThrow({ where: { orderId } });
      expect(svc.status).toBe(HostingServiceStatus.PROVISIONING);

      // Retry → refus 409 (aucun takeover), token inchangé, 0 appel provider.
      await expect(runProvision(orderId)).rejects.toThrow(/Intention provider déjà engagée/);
      expect(createGitAppCalls - baseline).toBe(1);
      const tracking2 = await prisma.orderProvisioningTracking.findUniqueOrThrow({
        where: { orderId },
      });
      expect(tracking2.claimToken).toBe(tokenAfterFailure);

      // Lease expiré : la garantie ne dépend PAS du lease — même en expiré,
      // aucun takeover, token préservé, toujours 0 appel provider.
      await prisma.orderProvisioningTracking.update({
        where: { orderId },
        data: { leaseUntil: new Date(Date.now() - 60_000) },
      });
      await expect(runProvision(orderId)).rejects.toThrow(/Intention provider déjà engagée/);
      expect(createGitAppCalls - baseline).toBe(1);
      const tracking3 = await prisma.orderProvisioningTracking.findUniqueOrThrow({
        where: { orderId },
      });
      expect(tracking3.claimToken).toBe(tokenAfterFailure);
      const order3 = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order3.status).toBe(OrderStatus.PROVISIONING);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7 — bind OK / activation impossible (T-fen.1) : lecture seule au retry
  // ═══════════════════════════════════════════════════════════════════════
  describe('bind committé / activation impossible (T-fen.1)', () => {
    it('preuve absente → états réels (BOUND, DEPLOYING, PROVISIONING) ; retry ⇒ lecture seule, 0 provider, 0 flip', async () => {
      const orderId = await seedC3Order('fen1');
      const baseline = createGitAppCalls;

      const readySpy = jest
        .spyOn(provisioning as never as { awaitAppReady: (...a: unknown[]) => Promise<boolean> }, 'awaitAppReady')
        .mockResolvedValue(false);
      await runProvision(orderId);
      readySpy.mockRestore();

      expect(createGitAppCalls - baseline).toBe(1);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.PROVISIONING);
      const dep = await prisma.deployment.findUniqueOrThrow({ where: { orderId } });
      expect(dep.status).toBe(DeploymentStatus.DEPLOYING);
      const alloc = await prisma.hostingServiceAllocation.findFirstOrThrow({
        where: { hostingService: { orderId } },
      });
      expect(alloc.status).toBe(HostingServiceAllocationStatus.BOUND);
      expect(alloc.deploymentId).toBe(dep.id);
      const svc = await prisma.hostingService.findUniqueOrThrow({ where: { orderId } });
      expect(svc.status).toBe(HostingServiceStatus.PROVISIONING);

      // Retry : état réel en lecture seule — aucun appel provider, aucune
      // activation forcée, aucun flip de service.
      const res = await runProvision(orderId);
      expect(res.status).toBe(OrderStatus.PROVISIONING);
      expect(createGitAppCalls - baseline).toBe(1);
      const orderAfter = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(orderAfter.status).toBe(OrderStatus.PROVISIONING);
      const svcAfter = await prisma.hostingService.findUniqueOrThrow({ where: { orderId } });
      expect(svcAfter.status).toBe(HostingServiceStatus.PROVISIONING);
    });
  });
});
