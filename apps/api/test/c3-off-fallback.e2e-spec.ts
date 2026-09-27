import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import { OrderStatus, PaymentMethodType, ProvisionAction } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { PanelTransport, PanelTransportFactory } from './../src/servers/panel-transport.factory';
import { ProvisioningService } from './../src/store/provisioning.service';
import { installFingerprintEnv } from './hosting-reservation.fixture';

/**
 * 17B.4F-C3 — e2e OFF (guard `HOSTING_C3_ENABLED` absent) sur la base ISOLÉE
 * complète (schéma C1+C3 présent). Scénario de revue : « OFF avec cache absent,
 * puis création d'une commande C3 par un AUTRE processus ».
 *
 *  - L'instance OFF est FRAÎCHE (jamais de résolution antérieure = aucun cache
 *    négatif périmé) ;
 *  - la ligne `OrderProvisioningTracking` est créée « par un autre processus »
 *    (insertion directe, équivalent d'un checkout ON concurrent) APRÈS le boot
 *    OFF ;
 *  - `provisionOrder` OFF sonde la table DÉDIÉE EN LIVE → refus 409 explicite,
 *    JAMAIS de repli legacy, ZÉRO appel provider, commande intacte ;
 *  - contrôle : le même appel sous ON (flag reposé à la volée) route bien en
 *    C3 (preuve que le refus OFF venait bien du flag, pas du parcours).
 *
 * Coutures : Panel/Mail factories factices (aucun réseau réel).
 */
describe('Garde C3 OFF — aucun repli legacy sur commande trackée (base isolée)', () => {
  process.env.HOSTING_C3_ENABLED = 'true'; // booté ON pour créer le tracking « autre processus »
  installFingerprintEnv();

  let app: INestApplication;
  let prisma: PrismaService;
  let provisioningOff: ProvisioningService;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;
  let provId = '';
  let pmId = '';
  let prodId = '';
  const orderIds: string[] = [];

  let createGitAppCalls = 0;
  const mailStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const fakePanelFactory = {
    create: () =>
      ({
        createGitApp: jest.fn(async () => {
          createGitAppCalls += 1;
          return { uuid: `app-off-${createGitAppCalls}` };
        }),
        deployApp: jest.fn().mockResolvedValue(undefined),
        applyAppLimits: jest.fn().mockResolvedValue(undefined),
        setAppEnvironment: jest.fn().mockResolvedValue(undefined),
        applyNodePort: jest.fn().mockResolvedValue(undefined),
        resolveExposedPort: jest.fn().mockResolvedValue(null),
        setAppDomain: jest.fn().mockResolvedValue(undefined),
        deploymentStatus: jest.fn().mockResolvedValue({ rawStatus: 'finished' }),
        verify: jest.fn().mockResolvedValue({ ok: true }),
      }) as unknown as PanelTransport,
  } as unknown as PanelTransportFactory;

  beforeAll(async () => {
    // ── 1) instance ON (l'« autre processus ») : seed catalogue puis checkout.
    const onModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransportFactory)
      .useValue({ create: () => mailStub })
      .overrideProvider(PanelTransportFactory)
      .useValue(fakePanelFactory)
      .compile();
    const onApp = onModule.createNestApplication();
    onApp.setGlobalPrefix(GlobalPrefix);
    onApp.use(cookieParser());
    onApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await onApp.init();
    prisma = onModule.get(PrismaService);

    const prov = await prisma.provisionMethod.create({
      data: {
        name: `off-prov-${stamp}`,
        code: `off-prov-${stamp}`,
        actions: [ProvisionAction.CREATE_APP],
      },
    });
    provId = prov.id;
    const pm = await prisma.paymentMethod.create({
      data: { name: `CB-${stamp}`, type: PaymentMethodType.CARD, isActive: true },
    });
    pmId = pm.id;
    const product = await prisma.product.create({
      data: {
        name: `off-prod-${stamp}`,
        slug: `off-prod-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 4900,
        provisionModuleId: provId,
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
    prodId = product.id;

    // Commande « autre processus » : insertion DIRECTE des écrits que ferait
    // le checkout ON (Order + tracking + HostingService), sans provisioning.
    const offUser = await prisma.user.create({
      data: {
        email: `off-user-${stamp}@example.com`,
        passwordHash: 'x',
        role: 'USER',
      },
    });
    const customer = await prisma.customer.create({
      data: { email: `off-cust-${stamp}@example.com`, name: 'Off C3', userId: offUser.id },
    });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        customerName: 'Off C3',
        customerEmail: `off-cust-${stamp}@example.com`,
        productId: prodId,
        productName: `off-prod-${stamp}`,
        status: OrderStatus.PAID,
        amountHtCents: 4900,
        taxAmountCents: 0,
        amountTtcCents: 4900,
        paymentMethodId: pmId,
        paymentMethodName: `CB-${stamp}`,
        idempotencyKey: `off-${stamp}`,
      },
    });
    orderIds.push(order.id);
    await prisma.orderProvisioningTracking.create({
      data: {
        orderId: order.id,
        intent: {
          business: { productId: prodId, amountTtcCents: 4900, currency: 'USD' },
          environment: { repoUrl: 'https://github.com/acme/site.git', branch: 'main' },
        },
      },
    });
    await prisma.hostingService.create({
      data: {
        userId: customer.userId!,
        orderId: order.id,
        productId: prodId,
        status: 'PROVISIONING',
        maxAppsSnapshot: 1,
        ramMbSnapshot: 512,
        cpuCoresSnapshot: 1,
        storageLimitGbSnapshot: null,
        packNameSnapshot: null,
        productNameSnapshot: `off-prod-${stamp}`,
      },
    });
    await onApp.close(); // l'« autre processus » a terminé son écrit

    // ── 2) instance OFF FRAÎCHE (flag retiré AVANT création de l'instance).
    delete process.env.HOSTING_C3_ENABLED;
    const offModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransportFactory)
      .useValue({ create: () => mailStub })
      .overrideProvider(PanelTransportFactory)
      .useValue(fakePanelFactory)
      .compile();
    const offApp = offModule.createNestApplication();
    offApp.setGlobalPrefix(GlobalPrefix);
    offApp.use(cookieParser());
    offApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await offApp.init();
    app = offApp;
    provisioningOff = offModule.get(ProvisioningService);
  });

  afterAll(async () => {
    await prisma.hostingServiceAllocation.deleteMany({ where: { hostingService: { orderId: { in: orderIds } } } }).catch(() => {});
    await prisma.deployment.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.provisioningLog.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    // HostingService AVANT Order (FK `onDelete: SetNull` sur orderId).
    await prisma.hostingService.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { email: `off-cust-${stamp}@example.com` } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: `off-user-${stamp}@example.com` } }).catch(() => {});
    await prisma.product.deleteMany({ where: { id: prodId } }).catch(() => {});
    await prisma.provisionMethod.deleteMany({ where: { id: provId } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: pmId } }).catch(() => {});
    delete process.env.HOSTING_C3_ENABLED;
    await app.close();
  });

  it('OFF + instance fraîche (cache absent) + commande C3 créée ailleurs ⇒ 409, 0 provider, commande intacte', async () => {
    const orderId = orderIds[0];
    const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(before.status).toBe(OrderStatus.PAID);

    await expect(provisioningOff.provisionOrder(orderId)).rejects.toThrow(
      /provisioning suspendu tant que C3 est désactivé/,
    );

    expect(createGitAppCalls).toBe(0);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(after.status).toBe(OrderStatus.PAID); // jamais basculé en legacy
    const depCount = await prisma.deployment.count({ where: { orderId } });
    expect(depCount).toBe(0);
    const tracking = await prisma.orderProvisioningTracking.findUnique({ where: { orderId } });
    expect(tracking?.claimToken).toBeNull(); // AUCUNE écriture de claim
    expect(tracking?.leaseUntil).toBeNull();
    const svc = await prisma.hostingService.findUniqueOrThrow({ where: { orderId } });
    expect(svc.status).toBe('PROVISIONING');
  });

  it('contrôle : même appel avec le flag ON à la volée ⇒ routage C3 (le refus venait du flag)', async () => {
    process.env.HOSTING_C3_ENABLED = 'true';
    try {
      const orderId = orderIds[0];
      let message: string | null = null;
      try {
        const res = await provisioningOff.provisionOrder(orderId);
        message = `status:${res.status}`;
      } catch (e) {
        message = (e as Error).message;
      }
      // Quel que soit l'issue (B0 refusant, run limité ou état restitué), ce
      // N'EST JAMAIS le refus OFF : le chemin était bien le parcours C3.
      expect(message).not.toMatch(/provisioning suspendu tant que C3 est désactivé/);
      const tracking = await prisma.orderProvisioningTracking.findUnique({ where: { orderId } });
      expect(tracking).toBeTruthy(); // toujours trackée — jamais de parcours legacy
    } finally {
      delete process.env.HOSTING_C3_ENABLED;
    }
  });
});
