import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import request = require('supertest');
import { OrderStatus, PaymentMethodType, Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import {
  PanelTransport,
  PanelTransportFactory,
} from './../src/servers/panel-transport.factory';
import {
  PAYMENT_SIMULATOR_ENABLED_ENV,
  isPaymentSimulatorEnabled,
} from './../src/config/payment-simulator';
import { acceptanceFor, preloadAcceptance } from './pricing-acceptance.fixture';

// Sweep (timer) OFF : aucune ligne de ce test n'en dépend.
process.env.ORDER_SWEEP_ENABLED = 'false';
process.env.RENEWAL_SWEEP_ENABLED = 'false';

/**
 * GO §5 — C5.7 : « un connecteur Stripe test correctement configuré doit
 * fonctionner SANS simulateur » (garde historique corrigée).
 *
 * Preuve contrôlée, sans AUCUN appel externe :
 *  - simulateur EXPLICITEMENT désactivé pendant toute la suite ;
 *  - `STRIPE_API_BASE` pointe vers un mini-serveur FACTICE en loopback
 *    (127.0.0.1, port éphémère) qui répond comme l'API Stripe test
 *    (`POST /v1/checkout/sessions`, `GET /v1/account`) et journalise chaque
 *    requête reçue — tout appel sortant réel serait hors de ce transport ;
 *  - configuration enregistrée par l'API admin (secrets chiffrés serveur),
 *    identité vérifiée par « Tester la connexion » (GO §3).
 *
 * Scénario : carte masquée/refusée sans prestataire → configuration non
 * vérifiée encore refusée (§3) → vérification OK → checkout 201 → ouverture
 * du règlement 201 avec session Stripe factice → désactivation = refus sans
 * aucun repli automatique.
 */
describe('C5.7 — checkout carte SANS simulateur (connecteur Stripe test factice)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const adminEmail = `s7admin_${uid}@example.com`;
  const clientEmail = `s7client_${uid}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let clientToken = '';

  let cardId = '';
  const productIds: string[] = [];
  let productSlug = '';
  let productSeq = 0;

  const orderIds: string[] = [];

  const FAKE_ACCOUNT = 'acct_fake_123456789';
  const FAKE_SECRET = 'sk_test_fake_key_for_c57_no_external_call';
  const FAKE_WEBHOOK = 'whsec_fake_c57_transport';
  const fakeCalls: {
    method: string;
    url: string;
    authorization: string | null;
    idempotencyKey: string | null;
    host: string | null;
    body: string;
  }[] = [];
  let fakeSessionCount = 0;

  let fakeServer: http.Server | null = null;
  let fakeBaseUrl = '';

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };
  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({}) as PanelTransport,
  } as unknown as PanelTransportFactory;

  const api = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function login(email: string): Promise<string> {
    const res = await api()
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email, password })
      .expect(201);
    return res.body.accessToken as string;
  }

  async function newProduct(): Promise<string> {
    productSeq += 1;
    const p = await prisma.product.create({
      data: {
        name: `s7-${uid}-${productSeq}`,
        slug: `s7-${uid}-${productSeq}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 1500,
      },
    });
    productIds.push(p.id);
    productSlug = p.slug!;
    await preloadAcceptance(app.getHttpServer(), productSlug, cardId);
    return productSlug;
  }

  /** Checkout CARTe (jeton client, preuve d'acceptation préchargée). */
  async function checkoutWithCard(): Promise<{
    status: number;
    body: Record<string, unknown>;
  }> {
    const res = await api()
      .post(`/${GlobalPrefix}/store/checkout`)
      .set(auth(clientToken))
      .send({
        productSlug,
        paymentMethodId: cardId,
        name: 'Client C5.7',
        email: clientEmail,
        ...(acceptanceFor(productSlug, cardId) ?? {}),
      });
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  const publicTypes = async (): Promise<string[]> => {
    const res = await api().get(`/${GlobalPrefix}/store/payment-methods`).expect(200);
    return (res.body as { type: string }[]).map((m) => m.type);
  };

  const saveStripe = (body: Record<string, unknown>) =>
    api()
      .put(`/${GlobalPrefix}/store/admin/payments/provider`)
      .set(auth(adminToken))
      .send({ code: 'stripe', ...body });

  const checkStripe = () =>
    api()
      .post(`/${GlobalPrefix}/store/admin/payments/provider/check`)
      .set(auth(adminToken))
      .send({});

  function openCardPayment(orderId: string, key: string): request.Test {
    return api()
      .post(`/${GlobalPrefix}/client/payments/orders/${orderId}/card`)
      .set(auth(clientToken))
      .set('Idempotency-Key', key)
      .send({});
  }

  // ── Transport factice (loopback uniquement) ────────────────────────────
  async function startFakeStripe(): Promise<void> {
    fakeServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        fakeCalls.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: (req.headers.authorization as string | undefined) ?? null,
          idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
          host: (req.headers.host as string | undefined) ?? null,
          body,
        });
        res.setHeader('content-type', 'application/json');
        const url = req.url ?? '';
        if (req.method === 'POST' && url === '/v1/checkout/sessions') {
          fakeSessionCount += 1;
          const sessionId = `cs_test_fake_${fakeSessionCount}`;
          res.end(
            JSON.stringify({
              id: sessionId,
              object: 'checkout_session',
              url: `https://pay.fake.test/session/${sessionId}`,
              livemode: false,
              payment_intent: `pi_test_fake_${fakeSessionCount}`,
              expires_at: Math.floor(Date.now() / 1000) + 1800,
            }),
          );
          return;
        }
        if (req.method === 'GET' && url === '/v1/account') {
          res.end(JSON.stringify({ id: FAKE_ACCOUNT, livemode: false }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: 'not found (fake stripe)' } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeServer!.once('error', reject);
      fakeServer!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = fakeServer!.address() as AddressInfo;
    fakeBaseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async function stopFakeStripe(): Promise<void> {
    if (!fakeServer) return;
    await new Promise<void>((resolve) => fakeServer!.close(() => resolve()));
    fakeServer = null;
  }

  // ── Boot + fixtures ────────────────────────────────────────────────────
  beforeAll(async () => {
    // Simulateur EXPLICITEMENT éteint pour toute la suite (GO §5 C5.7).
    delete process.env[PAYMENT_SIMULATOR_ENABLED_ENV];
    await startFakeStripe();
    // Avant l'init : le transport du connecteur = notre serveur factice,
    // AUCUN appel vers api.stripe.com n'est possible par construction.
    process.env.STRIPE_API_BASE = fakeBaseUrl;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransportFactory)
      .useValue(mailFactoryStub)
      .overrideProvider(PanelTransportFactory)
      .useValue(fakePanelFactory)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = moduleRef.get(PrismaService);
    limiter = moduleRef.get(SaRateLimiter);
    limiter.reset();

    // État déterministe : aucun prestataire résiduel, parcours carte actif.
    await prisma.paymentProviderSetting.deleteMany({
      where: { code: { in: ['stripe', 'simulated'] } },
    });
    await prisma.paymentSettings.upsert({
      where: { id: 'singleton' },
      update: { cardOrderPaymentEnabled: true, walletPaymentEnabled: true, cardTopupEnabled: false },
      create: { id: 'singleton', cardOrderPaymentEnabled: true },
    });

    await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Admin C5.7',
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
      },
    });
    await prisma.user.create({
      data: {
        email: clientEmail,
        name: 'Client C5.7',
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.USER,
      },
    });
    adminToken = await login(adminEmail);
    clientToken = await login(clientEmail);

    const card = await prisma.paymentMethod.create({
      data: { name: `CB-C57-${uid}`, type: PaymentMethodType.CARD, isActive: true },
    });
    cardId = card.id;

    await newProduct();
  });

  beforeEach(() => {
    limiter.reset();
  });

  afterAll(async () => {
    delete process.env.STRIPE_API_BASE;
    delete process.env[PAYMENT_SIMULATOR_ENABLED_ENV];
    delete process.env.ORDER_SWEEP_ENABLED;
    delete process.env.RENEWAL_SWEEP_ENABLED;
    if (prisma) {
      const cards = await prisma.cardPayment
        .findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })
        .catch(() => [] as { id: string }[]);
      const cardIds = cards.map((c) => c.id);
      await prisma.auditLog
        .deleteMany({
          where: {
            OR: [
              { resourceId: { in: [...orderIds, ...cardIds] } },
              { actorEmail: { in: [adminEmail, clientEmail] } },
            ],
          },
        })
        .catch(() => {});
      await prisma.paymentWebhookEvent
        .deleteMany({ where: { cardPaymentId: { in: cardIds } } })
        .catch(() => {});
      await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
      await prisma.cardPayment.deleteMany({ where: { id: { in: cardIds } } }).catch(() => {});
      await prisma.walletTransaction
        .deleteMany({ where: { orderId: { in: orderIds } } })
        .catch(() => {});
      await prisma.orderStatusHistory
        .deleteMany({ where: { orderId: { in: orderIds } } })
        .catch(() => {});
      await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
      await prisma.product.deleteMany({ where: { id: { in: productIds } } }).catch(() => {});
      await prisma.paymentMethod.deleteMany({ where: { id: cardId } }).catch(() => {});
      await prisma.paymentProviderSetting
        .deleteMany({ where: { code: { in: ['stripe', 'simulated'] } } })
        .catch(() => {});
      await prisma.customer.deleteMany({ where: { email: clientEmail } }).catch(() => {});
      await prisma.user
        .deleteMany({ where: { email: { in: [adminEmail, clientEmail] } } })
        .catch(() => {});
      // Retour aux valeurs par défaut de la migration (parcours carte éteint).
      await prisma.paymentSettings
        .update({
          where: { id: 'singleton' },
          data: { cardOrderPaymentEnabled: false, cardTopupEnabled: true },
        })
        .catch(() => {});
    }
    await app?.close();
    await stopFakeStripe();
  });

  // ═════ S1 — aucun prestataire (simulateur OFF) ════════════════════════
  it('S1 — sans prestataire : carte MASQUÉE et checkout 400 honnête (aucun repli)', async () => {
    expect(isPaymentSimulatorEnabled()).toBe(false);
    expect(await prisma.paymentProviderSetting.findUnique({ where: { code: 'stripe' } })).toBeNull();

    const types = await publicTypes();
    expect(types).not.toContain(PaymentMethodType.CARD);

    const before = await prisma.order.count();
    const res = await checkoutWithCard();
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('pas encore disponible');
    expect(await prisma.order.count()).toBe(before);
  });

  // ═════ S2 — configuration enregistrée mais NON vérifiée (GO §3) ═══════
  it('S2 — Stripe configuré mais identité NON vérifiée : carte MASQUÉE, checkout 400 (§3)', async () => {
    const saved = await saveStripe({
      displayName: 'Stripe factice C5.7',
      isActive: true,
      secretKey: FAKE_SECRET,
      webhookSecret: FAKE_WEBHOOK,
      allowedCurrencies: ['USD', 'EUR'],
    }).expect(200);
    expect(saved.body).toMatchObject({ hasSecretKey: true, isActive: true, environment: 'test' });
    expect(saved.body.lastCheckAccount).toBeNull();

    // Déclaré ≠ vérifié : le client ne voit pas un moyen qui refuserait.
    const types = await publicTypes();
    expect(types).not.toContain(PaymentMethodType.CARD);

    const before = await prisma.order.count();
    const res = await checkoutWithCard();
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('pas encore disponible');
    expect(await prisma.order.count()).toBe(before);
  });

  // ═════ S3 — vérification d'identité sur transport factice ═════════════
  it('S3 — « Tester la connexion » contre le transport factice → identité vérifiée', async () => {
    const checked = await checkStripe().expect(201);
    expect(checked.body.lastCheckAccount).toBe(FAKE_ACCOUNT);
    expect(checked.body.lastCheckError).toBeNull();
    expect(checked.body.merchantAccount).toBe(FAKE_ACCOUNT);

    const accountCalls = fakeCalls.filter((c) => c.url === '/v1/account');
    expect(accountCalls).toHaveLength(1);
    expect(accountCalls[0].method).toBe('GET');
    expect(accountCalls[0].authorization).toBe(`Bearer ${FAKE_SECRET}`);
    // Loopback seul : la requête est bien arrivée à NOTRE transport.
    expect(String(accountCalls[0].host)).toContain('127.0.0.1');
  });

  // ═════ S4 — garde historique corrigée : checkout SANS simulateur ══════
  it('S4 — carte visible au client puis checkout → 201 (simulateur désactivé)', async () => {
    expect(isPaymentSimulatorEnabled()).toBe(false);

    const types = await publicTypes();
    expect(types).toContain(PaymentMethodType.CARD);

    await newProduct();
    const res = await checkoutWithCard();
    expect(res.status).toBe(201);
    const orderId = String(res.body.orderId);
    expect(orderId).toBeTruthy();
    orderIds.push(orderId);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order.paymentMethodId).toBe(cardId);
  });

  // ═════ S5 — ouverture du règlement → session Stripe factice ═══════════
  it('S5 — ouverture du règlement : session créée chez le transport factice (Stripe, pas simulateur)', async () => {
    const orderId = orderIds[orderIds.length - 1]!;
    const callsBefore = fakeCalls.length;

    const res = await openCardPayment(orderId, `s7-open-${uid}`).expect(201);
    expect(String(res.body.checkoutUrl)).toBe(
      `https://pay.fake.test/session/cs_test_fake_${fakeSessionCount}`,
    );

    const row = await prisma.cardPayment.findFirstOrThrow({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.providerCode).toBe('stripe');
    expect(row.merchantAccount).toBe(FAKE_ACCOUNT);
    expect(row.environment).toBe('test');
    expect(row.livemode).toBe(false);
    expect(row.providerCallState).toBe('RESOLVED');
    expect(row.dispatchedAt).toBeTruthy();
    expect(row.providerSessionRef).toBe(`cs_test_fake_${fakeSessionCount}`);

    const sessionCalls = fakeCalls
      .slice(callsBefore)
      .filter((c) => c.url === '/v1/checkout/sessions');
    expect(sessionCalls).toHaveLength(1);
    expect(sessionCalls[0].method).toBe('POST');
    expect(sessionCalls[0].authorization).toBe(`Bearer ${FAKE_SECRET}`);
    expect(sessionCalls[0].idempotencyKey).toBe(`orderpay:${row.reference}`);
    expect(sessionCalls[0].body).toContain(`metadata%5Breference%5D=${row.reference}`);

    // Le simulateur ne s'est JAMAIS activé en arrière-plan (aucune ligne).
    expect(isPaymentSimulatorEnabled()).toBe(false);
    expect(await prisma.paymentProviderSetting.findUnique({ where: { code: 'simulated' } })).toBeNull();
  });

  // ═════ S6 — désactivation : refus net, aucun repli automatique ════════
  it('S6 — prestataire désactivé (sans simulateur) : carte MASQUÉE + checkout 400, aucun repli', async () => {
    await saveStripe({
      displayName: 'Stripe factice C5.7',
      isActive: false,
    }).expect(200);

    const types = await publicTypes();
    expect(types).not.toContain(PaymentMethodType.CARD);

    const before = await prisma.order.count();
    const res = await checkoutWithCard();
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('pas encore disponible');
    expect(await prisma.order.count()).toBe(before);

    // Aucun moyen n'est substitué : le repli vers le simulateur n'existe pas.
    expect(isPaymentSimulatorEnabled()).toBe(false);
    expect(await prisma.paymentProviderSetting.findUnique({ where: { code: 'simulated' } })).toBeNull();
  });
});
