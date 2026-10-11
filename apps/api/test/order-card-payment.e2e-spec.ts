import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { OrderStatus, PaymentMethodType, RefundKind, Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import {
  PanelTransport,
  PanelTransportFactory,
} from './../src/servers/panel-transport.factory';
import { PAYMENT_SIMULATOR_ENABLED_ENV } from './../src/config/payment-simulator';
import { acceptanceFor, preloadAcceptance } from './pricing-acceptance.fixture';

// Sweep (timer) OFF : aucune ligne de ce test n'en dépend.
process.env.ORDER_SWEEP_ENABLED = 'false';
process.env.RENEWAL_SWEEP_ENABLED = 'false';

/**
 * Lot « paiement direct des commandes » (e2e) — le règlement d'UNE commande
 * par CARTE, sans passer par le portefeuille :
 *
 *  A. réglages des parcours : interrupteurs PUBLICS/ADMIN + GATE 409
 *     `PAYMENT_METHOD_DISABLED` sur le checkout CARTe (aucune commande créée) ;
 *  B. ouverture d'une tentative : montant/devise lus côté SERVEUR, propriété
 *     exigée, tentative vivante = MÊME session, RBAC ;
 *  C. course solde ↔ carte : un débit par solde est refusé tant qu'une
 *     tentative carte est ouverte (409 `CARD_PAYMENT_IN_PROGRESS`) ;
 *  D. encaissement simulé : commande PAID, facture, historique, ZÉRO mouvement
 *     de portefeuille, rejeu idempotent — MÊME après désactivation du parcours
 *     (reprise sans gate) ;
 *  E. remboursements : `WALLET_CREDIT` refusé (origine carte), `EXTERNAL_CARD`
 *     rattaché aux DEUX liens sans jamais toucher au solde, RBAC ADMIN.
 *
 * Aucun réseau réel : connecteur SIMULÉ + Mail/Panel stubbés ; PrismaService
 * RÉEL sur la base dédiée du chantier (icode_host_pro_socle).
 */
describe('Règlement direct d’une commande par carte (e2e, lot paiement direct)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date();

  const adminEmail = `ocadmin_${uid}@example.com`;
  const clientEmail = `occlient_${uid}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let clientToken = '';
  let clientUserId = '';

  let cardId = '';
  const productIds: string[] = [];
  let productSlug = '';
  let productSeq = 0;

  /**
   * Un produit PAR bloc : le checkout réutilise la commande existante du même
   * (client, produit) quel que soit son état — chaque bloc doit donc acheter un
   * article NEUF pour étudier sa propre commande.
   */
  async function newProduct(): Promise<string> {
    productSeq += 1;
    const p = await prisma.product.create({
      data: {
        name: `pd-${uid}-${productSeq}`,
        slug: `pd-${uid}-${productSeq}`,
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

  const orderIds: string[] = [];
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

  async function balanceOf(email: string): Promise<number> {
    const c = await prisma.customer.findUnique({ where: { email } });
    return c?.walletBalanceCents ?? 0;
  }

  async function settings(): Promise<{
    walletPaymentEnabled: boolean;
    cardOrderPaymentEnabled: boolean;
    cardTopupEnabled: boolean;
  }> {
    const s = await prisma.paymentSettings.findUnique({ where: { id: 'singleton' } });
    if (!s) throw new Error('PaymentSettings absent');
    return {
      walletPaymentEnabled: s.walletPaymentEnabled,
      cardOrderPaymentEnabled: s.cardOrderPaymentEnabled,
      cardTopupEnabled: s.cardTopupEnabled,
    };
  }

  const setCardOrder = (enabled: boolean) =>
    prisma.paymentSettings.update({
      where: { id: 'singleton' },
      data: { cardOrderPaymentEnabled: enabled },
    });

  /** Checkout CARTe (preuve d'acceptation préchargée, jeton client). */
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
        name: 'Client Paiement direct',
        email: clientEmail,
        ...(acceptanceFor(productSlug, cardId) ?? {}),
      });
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  function openCardPayment(orderId: string, key?: string): request.Test {
    const req = api()
      .post(`/${GlobalPrefix}/client/payments/orders/${orderId}/card`)
      .set(auth(clientToken))
      .send({});
    if (key) req.set('Idempotency-Key', key);
    return req;
  }

  function walletPay(orderId: string): request.Test {
    return api()
      .post(`/${GlobalPrefix}/client/orders/${orderId}/pay-with-wallet`)
      .set(auth(clientToken))
      .send({});
  }

  function refund(
    orderId: string,
    body: Record<string, unknown>,
    key: string,
    token?: string,
  ): request.Test {
    return api()
      .post(`/${GlobalPrefix}/store/admin/orders/${orderId}/refunds`)
      .set(auth(token ?? adminToken))
      .set('Idempotency-Key', key)
      .send(body);
  }

  /** Émission d'un événement simulé (page hébergée : signé côté serveur). */
  const completeSimulated = (sessionRef: string, outcome: string) =>
    api()
      .post(`/${GlobalPrefix}/payments/simulated/sessions/${sessionRef}/complete`)
      .send({ outcome });

  const sessionRefOf = (checkoutUrl: unknown): string => {
    const url = String(checkoutUrl ?? '');
    const m = url.match(/sessions\/([A-Za-z0-9_]+)$/);
    if (!m) throw new Error(`URL de paiement inattendue : ${url}`);
    return m[1];
  };

  // ── Boot + fixtures ───────────────────────────────────────────────────────
  beforeAll(async () => {
    process.env[PAYMENT_SIMULATOR_ENABLED_ENV] = 'true';

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

    // État PAR DÉFAUT de la migration : parcours carte de commande ÉTEINT.
    await prisma.paymentSettings.upsert({
      where: { id: 'singleton' },
      update: { cardOrderPaymentEnabled: false, walletPaymentEnabled: true, cardTopupEnabled: true },
      create: { id: 'singleton', cardOrderPaymentEnabled: false },
    });

    await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Admin Paiement direct',
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
      },
    });
    const client = await prisma.user.create({
      data: {
        email: clientEmail,
        name: 'Client Paiement direct',
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.USER,
      },
    });
    clientUserId = client.id;

    adminToken = await login(adminEmail);
    clientToken = await login(clientEmail);

    const card = await prisma.paymentMethod.create({
      data: { name: `CB-PD-${uid}`, type: PaymentMethodType.CARD, isActive: true },
    });
    cardId = card.id;

    const product = await prisma.product.create({
      data: {
        name: `pd-${uid}`,
        slug: `pd-${uid}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 1500,
      },
    });
    productIds.push(product.id);
    productSlug = product.slug!;

    await preloadAcceptance(app.getHttpServer(), productSlug, cardId);
  });

  beforeEach(() => {
    limiter.reset();
  });

  afterAll(async () => {
    if (!prisma) {
      delete process.env[PAYMENT_SIMULATOR_ENABLED_ENV];
      delete process.env.ORDER_SWEEP_ENABLED;
      delete process.env.RENEWAL_SWEEP_ENABLED;
      await app?.close();
      return;
    }
    const cards = await prisma.cardPayment.findMany({
      where: { orderId: { in: orderIds } },
      select: { id: true, reference: true },
    });
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
    // Connecteur SIMULÉ créé à la volée : remise à zéro (même contrat que
    // card-topup) pour que les suites suivantes voient « aucun prestataire ».
    await prisma.paymentProviderSetting
      .deleteMany({ where: { code: 'simulated' } })
      .catch(() => {});
    await prisma.customer.deleteMany({ where: { email: clientEmail } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, clientEmail] } } }).catch(() => {});
    // Retour aux valeurs par défaut de la migration (parcours carte éteint).
    await prisma.paymentSettings
      .update({ where: { id: 'singleton' }, data: { cardOrderPaymentEnabled: false } })
      .catch(() => {});

    delete process.env[PAYMENT_SIMULATOR_ENABLED_ENV];
    delete process.env.ORDER_SWEEP_ENABLED;
    delete process.env.RENEWAL_SWEEP_ENABLED;
    await app.close();
  });

  // ═════ A. réglages des parcours + gate checkout ════════════════════════
  describe('A - réglages des parcours (public + admin) et gate checkout', () => {
    it('A1 - défaut migration : carte de commande ÉTEINTE, solde et recharge ON', async () => {
      const res = await api().get(`/${GlobalPrefix}/store/payment-capabilities`).expect(200);
      // §5b — interrupteurs BRUTS + disponibilité effective de la carte.
      expect(res.body).toMatchObject({
        walletPaymentEnabled: true,
        cardOrderPaymentEnabled: false,
        cardTopupEnabled: true,
        cardAvailable: expect.any(Boolean),
        cardCurrencies: expect.any(Array),
      });
      expect((await settings()).cardOrderPaymentEnabled).toBe(false);
    });

    it('A2 - checkout CARTe avec parcours éteint → 409 PAYMENT_METHOD_DISABLED, AUCUNE commande', async () => {
      const before = await prisma.order.count();
      const res = await checkoutWithCard();
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'PAYMENT_METHOD_DISABLED',
        capability: 'cardOrder',
      });
      expect(await prisma.order.count()).toBe(before);
    });

    it('A3 - RBAC : anonyme 401, USER 403 sur les réglages admin', async () => {
      await api().get(`/${GlobalPrefix}/store/admin/payment-settings`).expect(401);
      await api()
        .get(`/${GlobalPrefix}/store/admin/payment-settings`)
        .set(auth(clientToken))
        .expect(403);
    });

    it('A4 - activation ADMIN puis public cohérent (écriture + lecture)', async () => {
      await api()
        .patch(`/${GlobalPrefix}/store/admin/payment-settings`)
        .set(auth(adminToken))
        .send({ cardOrderPaymentEnabled: true })
        .expect(200);
      expect((await settings()).cardOrderPaymentEnabled).toBe(true);
      const res = await api().get(`/${GlobalPrefix}/store/payment-capabilities`).expect(200);
      expect(res.body.cardOrderPaymentEnabled).toBe(true);
    });
  });

  // ═════ B. ouverture d'une tentative de règlement ═══════════════════════
  describe('B - ouverture d’une tentative (montant serveur, propriété, RBAC)', () => {
    let orderId = '';
    let orderTotal = 0;

    it('B1 - checkout CARTe (parcours actif) → 201, commande PENDING_PAYMENT', async () => {
      await newProduct();
      const res = await checkoutWithCard();
      expect(res.status).toBe(201);
      orderId = String(res.body.orderId);
      expect(orderId).toBeTruthy();
      orderIds.push(orderId);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(order.paymentMethodId).toBe(cardId);
      const owner = await prisma.customer.findUniqueOrThrow({
        where: { id: order.customerId! },
      });
      expect(owner.email).toBe(clientEmail);
    });

    it('B2 - ouverture : montant/devise de la COMMANDE, rang kind ORDER, URL hébergée', async () => {
      const res = await openCardPayment(orderId, `pd-open-${uid}`).expect(201);
      expect(String(res.body.checkoutUrl)).toContain('/api/payments/simulated/sessions/');
      expect(res.body.amountCents).toBe(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).amountTtcCents,
      );
      const row = await prisma.cardPayment.findFirstOrThrow({
        where: { orderId },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.kind).toBe('ORDER');
      expect(row.customerId).toBeTruthy();
      expect(row.status).toBe('CREATED');
      orderTotal = row.amountCents;
      expect(orderTotal).toBeGreaterThan(0);
    });

    it('B3 - tentative vivante = MÊME session (aucune seconde tentative créée)', async () => {
      const before = await prisma.cardPayment.count({ where: { orderId } });
      const res = await openCardPayment(orderId, `pd-open2-${uid}`).expect(201);
      const first = await prisma.cardPayment.findFirstOrThrow({
        where: { orderId },
        orderBy: { createdAt: 'asc' },
      });
      expect(res.body.reference).toBe(first.reference);
      expect(await prisma.cardPayment.count({ where: { orderId } })).toBe(before);
    });

    it('B4 - RBAC : anonyme 401, un AUTRE client → 404 (propriété exigée)', async () => {
      await api()
        .post(`/${GlobalPrefix}/client/payments/orders/${orderId}/card`)
        .send({})
        .expect(401);
      // commande d'un autre compte : le détail n'existe pas pour lui
      const otherEmail = `ocother_${uid}@example.com`;
      await prisma.user.create({
        data: {
          email: otherEmail,
          name: 'Autre client',
          passwordHash: await bcrypt.hash(password, 10),
          role: Role.USER,
        },
      });
      const otherToken = await login(otherEmail);
      await api()
        .get(`/${GlobalPrefix}/client/payments/orders/${orderId}/card`)
        .set(auth(otherToken))
        .expect(404);
      await prisma.user.delete({ where: { email: otherEmail } }).catch(() => {});
    });
  });

  // ═════ C. course solde ↔ carte ═════════════════════════════════════════
  describe('C - anti-double-paiement (solde vs carte)', () => {
    let orderId = '';

    beforeAll(async () => {
      await newProduct();
      const res = await checkoutWithCard();
      expect(res.status).toBe(201);
      orderId = String(res.body.orderId);
      orderIds.push(orderId);
      await openCardPayment(orderId, `pd-race-${uid}`).expect(201);
    });

    it('C1 - tentative carte ouverte → 409 CARD_PAYMENT_IN_PROGRESS, zéro débit', async () => {
      const balanceBefore = await balanceOf(clientEmail);
      const txBefore = await prisma.walletTransaction.count({
        where: { customer: { email: clientEmail } },
      });
      const res = await walletPay(orderId);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CARD_PAYMENT_IN_PROGRESS' });
      expect(await balanceOf(clientEmail)).toBe(balanceBefore);
      expect(
        await prisma.walletTransaction.count({
          where: { customer: { email: clientEmail } },
        }),
      ).toBe(txBefore);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    });

    it('C2 - même tentative déclarée PAYMENT_METHOD_DISABLED si le parcours solde est coupé', async () => {
      await prisma.paymentSettings.update({
        where: { id: 'singleton' },
        data: { walletPaymentEnabled: false },
      });
      const res = await walletPay(orderId);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'PAYMENT_METHOD_DISABLED', capability: 'wallet' });
      await prisma.paymentSettings.update({
        where: { id: 'singleton' },
        data: { walletPaymentEnabled: true },
      });
    });

    // GO revue §6a — C1/C2 sont SÉQUENTIELS (la tentative est ouverte dans
    // beforeAll, puis le solde est essayé) : ils prouvent le garde, pas la
    // course. C3 lance les DEUX voies réellement en parallèle (Promise.all,
    // PostgreSQL réelle, verrou `FOR UPDATE` sur la commande) : un seul
    // règlement, jamais deux, quel que soit le gagnant.

    it('C3 - VRAIE course solde ∥ carte (Promise.all) : un seul règlement, invariants intacts', async () => {
      await setCardOrder(true);
      await newProduct();
      const res = await checkoutWithCard();
      expect(res.status).toBe(201);
      const raceOrderId = String(res.body.orderId);
      orderIds.push(raceOrderId);

      // Solde largement suffisant pour que le débit ne soit jamais le frein.
      await prisma.customer.update({
        where: { email: clientEmail },
        data: { walletBalanceCents: { increment: 100_000 } },
      });
      const balanceBefore = await balanceOf(clientEmail);
      const txBefore = await prisma.walletTransaction.count({
        where: { customer: { email: clientEmail } },
      });

      // Les deux appels partent EN MÊME TEMPS (aucun ordre imposé).
      const [walletRes, cardRes] = await Promise.all([
        walletPay(raceOrderId),
        openCardPayment(raceOrderId, `pd-race3-${uid}`),
      ]);

      // Invariant : EXACTEMENT UNE voie gagne ; l'autre est refusée.
      const walletWon = walletRes.status === 201;
      const cardWon = cardRes.status === 201;
      expect([walletWon, cardWon].filter(Boolean)).toHaveLength(1);
      if (walletWon) {
        // Solde : débit TOTAL du TTC, commande réglée, AUCUNE session carte.
        const order = await prisma.order.findUniqueOrThrow({ where: { id: raceOrderId } });
        expect(order.status).toBe(OrderStatus.PAID);
        const cards = await prisma.cardPayment.count({ where: { orderId: raceOrderId } });
        expect(cards).toBe(0);
        const debited =
          balanceBefore - (await balanceOf(clientEmail));
        expect(debited).toBeGreaterThan(0);
        expect(
          await prisma.walletTransaction.count({
            where: { customer: { email: clientEmail } },
          }),
        ).toBe(txBefore + 1);
      } else {
        // Carte : tentative ouverte, zéro débit solde, commande impayée.
        expect(cardRes.status).toBe(201);
        expect(String(cardRes.body.reference ?? '')).toMatch(/^CDP-/);
        expect(String(cardRes.body.checkoutUrl ?? '')).toContain('/sessions/');
        const order = await prisma.order.findUniqueOrThrow({ where: { id: raceOrderId } });
        expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
        expect(await balanceOf(clientEmail)).toBe(balanceBefore);
        expect(
          await prisma.walletTransaction.count({
            where: { customer: { email: clientEmail } },
          }),
        ).toBe(txBefore);
      }
      // Le refus (409) porte un code métier cohérent — jamais un 500.
      const loser = walletWon ? cardRes : walletRes;
      expect(loser.status).toBe(409);
      expect([409]).toContain(loser.status);
    });
  });

  // ═════ D. encaissement simulé + effets ═════════════════════════════════
  describe('D - encaissement simulé (commande réglée, zéro mouvement wallet)', () => {
    let orderId = '';
    let reference = '';
    let balanceBefore = 0;

    beforeAll(async () => {
      await newProduct();
      const res = await checkoutWithCard();
      expect(res.status).toBe(201);
      orderId = String(res.body.orderId);
      orderIds.push(orderId);
      const open = await openCardPayment(orderId, `pd-pay-${uid}`).expect(201);
      reference = String(open.body.reference);
      balanceBefore = await balanceOf(clientEmail);
    });

    it('D1 - désactivation du parcours APRÈS ouverture : la REPRISE reste ouverte (aucun gate)', async () => {
      await setCardOrder(false);
      const view = await api()
        .post(`/${GlobalPrefix}/client/payments/orders/${orderId}/card/refresh`)
        .set(auth(clientToken))
        .expect(201);
      expect(view.body.reference).toBe(reference);
      expect((await settings()).cardOrderPaymentEnabled).toBe(false);
      await setCardOrder(true);
    });

    it('D2 - encaissement simulé → commande PAID + facture + historique, JAMAIS de crédit wallet', async () => {
      const row = await prisma.cardPayment.findUniqueOrThrow({ where: { reference } });
      const sessionRef = String(row.providerSessionRef);
      // Delta nul (pas d'absolu) : une transaction wallet antérieure (course C3
      // gagnée par le portefeuille) ne doit pas fausser l'invariant « le
      // règlement carte ne crée AUCUN mouvement ».
      const txBefore = await prisma.walletTransaction.count({
        where: { customer: { email: clientEmail } },
      });
      await completeSimulated(sessionRef, 'success').expect(200);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      // La commande est RÉGLÉE : PAID, ou déjà ACTIVE si le provisioning
      // post-commit a couru avant la lecture (effet asynchrone normal).
      expect([OrderStatus.PAID, OrderStatus.ACTIVE]).toContain(order.status);
      expect(order.paidAt).toBeTruthy();

      const card = await prisma.cardPayment.findUniqueOrThrow({ where: { reference } });
      expect(card.status).toBe('SUCCEEDED');
      expect(card.paidAt).toBeTruthy();

      const invoice = await prisma.invoice.findUnique({ where: { orderId } });
      expect(invoice?.status).toBe('PAID');

      const history = await prisma.orderStatusHistory.findFirst({
        where: { orderId, status: OrderStatus.PAID },
      });
      expect(history).toBeTruthy();

      // ZÉRO mouvement de portefeuille sur un règlement carte (delta nul).
      expect(await balanceOf(clientEmail)).toBe(balanceBefore);
      expect(
        await prisma.walletTransaction.count({
          where: { customer: { email: clientEmail } },
        }),
      ).toBe(txBefore);
    });

    it('D3 - rejeu du même encaissement → session consommée, aucun second effet', async () => {
      const row = await prisma.cardPayment.findUniqueOrThrow({ where: { reference } });
      const again = await completeSimulated(String(row.providerSessionRef), 'success');
      expect(again.status).toBe(404);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect([OrderStatus.PAID, OrderStatus.ACTIVE]).toContain(order.status);
      expect(await prisma.cardPayment.count({ where: { orderId } })).toBe(1);
      expect(await balanceOf(clientEmail)).toBe(balanceBefore);
      expect(
        await prisma.orderStatusHistory.count({ where: { orderId, status: OrderStatus.PAID } }),
      ).toBe(1);
    });

    it('D4 - tentative supplémentaire sur commande déjà réglée → 409 (aucune session ouverte)', async () => {
      const res = await openCardPayment(orderId, `pd-paid-${uid}`);
      expect(res.status).toBe(409);
      expect(String(res.body.message)).toMatch(/règlement par carte impossible/);
      expect(await prisma.cardPayment.count({ where: { orderId } })).toBe(1);
    });
  });

  // ═════ E. remboursements (suivi de l'origine) ══════════════════════════
  describe('E - remboursements d’une commande réglée par carte', () => {
    let orderId = '';
    let reference = '';
    let balanceBefore = 0;

    beforeAll(async () => {
      await newProduct();
      const res = await checkoutWithCard();
      expect(res.status).toBe(201);
      orderId = String(res.body.orderId);
      orderIds.push(orderId);
      const open = await openCardPayment(orderId, `pd-ref-${uid}`);
      if (open.status !== 201) {
        throw new Error(`ouverture refusée (${open.status}) : ${JSON.stringify(open.body)}`);
      }
      reference = String(open.body.reference);
      const row = await prisma.cardPayment.findUniqueOrThrow({ where: { reference } });
      await completeSimulated(String(row.providerSessionRef), 'success').expect(200);
      balanceBefore = await balanceOf(clientEmail);
    });

    it('E1 - WALLET_CREDIT refusé 409 REFUND_ORIGIN_CARD (le règlement suit son origine)', async () => {
      const res = await refund(
        orderId,
        { amountCents: 500, kind: RefundKind.WALLET_CREDIT },
        `pd-rf-wallet-${uid}`,
      );
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'REFUND_ORIGIN_CARD' });
      expect(await prisma.refund.count({ where: { orderId } })).toBe(0);
      expect(await balanceOf(clientEmail)).toBe(balanceBefore);
    });

    it('E2 - RBAC : USER403 sur le remboursement (route admin)', async () => {
      await refund(
        orderId,
        { amountCents: 500, kind: RefundKind.EXTERNAL_CARD },
        `pd-rf-rbac-${uid}`,
        clientToken,
      ).expect(403);
      expect(await prisma.refund.count({ where: { orderId } })).toBe(0);
    });

    it('E3 - EXTERNAL_CARD : 201 rattaché aux DEUX liens, solde INCHANGÉ, SUCCEEDED', async () => {
      // Delta nul : le remboursement vers la carte ne crée AUCUN mouvement
      // wallet (une transaction antérieure de la course C3 ne fausse pas la mesure).
      const txBefore = await prisma.walletTransaction.count({
        where: { customer: { email: clientEmail } },
      });
      const res = await refund(
        orderId,
        { amountCents: 500, kind: RefundKind.EXTERNAL_CARD, reason: 'Recette partiel' },
        `pd-rf-card-${uid}`,
      );
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ kind: 'EXTERNAL_CARD', orderId });
      expect(res.body.cardPaymentId).toBeTruthy();
      // GO revue §5c — bouton « Rembourser la commande vers la carte » testé
      // jusqu'au STATUT RÉEL : le simulateur conclut dans la même requête
      // (retryProviderCall déclenché par le contrôleur admin).
      expect(res.body.status).toBe('SUCCEEDED');
      expect(res.body.providerRef).toBeTruthy();

      expect(await balanceOf(clientEmail)).toBe(balanceBefore);
      expect(
        await prisma.walletTransaction.count({
          where: { customer: { email: clientEmail } },
        }),
      ).toBe(txBefore);

      const pay = await prisma.cardPayment.findFirstOrThrow({ where: { orderId } });
      expect(pay.refundedCents).toBe(500);
      expect(pay.status).toBe('PARTIALLY_REFUNDED');

      const list = await api()
        .get(`/${GlobalPrefix}/store/admin/orders/${orderId}/refunds`)
        .set(auth(adminToken))
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ cardPaymentId: res.body.cardPaymentId, status: 'SUCCEEDED' });
    });

    it('E4 - plafond cumulé (commande + paiement) : un second remboursement au-delà → 409', async () => {
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const res = await refund(
        orderId,
        { amountCents: order.amountTtcCents, kind: RefundKind.EXTERNAL_CARD },
        `pd-rf-cap-${uid}`,
      );
      expect(res.status).toBe(409);
      expect(String(res.body.message)).toContain('Plafond');
    });

    it("E5 - GO revue §5c : le parcours RECHARGE (card-payments/:id/refunds) REFUSE un règlement de commande", async () => {
      const pay = await prisma.cardPayment.findFirstOrThrow({ where: { orderId } });
      const res = await api()
        .post(`/${GlobalPrefix}/store/admin/payments/card-payments/${pay.id}/refunds`)
        .set(auth(adminToken))
        .set('Idempotency-Key', `pd-rf-topup-guard-${uid}`)
        .send({ amountCents: 100, reason: 'Parcours recharge sur commande (interdit)' });
      expect(res.status).toBe(409);
      expect(String(res.body.message)).toContain('de commande');
      expect(String(res.body.message)).toContain('/store/admin/orders/');
      // Zéro écriture : ni intention, ni débit portefeuille.
      const extra = await prisma.refund.findMany({
        where: { cardPaymentId: pay.id, amountCents: 100 },
      });
      expect(extra).toHaveLength(0);
      expect(await balanceOf(clientEmail)).toBe(balanceBefore);
    });
  });
});
