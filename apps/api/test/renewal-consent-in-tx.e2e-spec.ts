import { ConflictException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import {
  BillingCycle,
  InvoiceStatus,
  OrderStatus,
  PaymentMethodType,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { acceptanceFor, preloadAcceptance } from './pricing-acceptance.fixture';
import {
  PanelTransport,
  PanelTransportFactory,
} from './../src/servers/panel-transport.factory';
import { CheckoutService } from '../src/store/checkout.service';
import { JwtPayload } from '../src/auth/types';

// Sweeps (timers) OFF : les passages sont déclenchés à la demande.
process.env.ORDER_SWEEP_ENABLED = 'false';
process.env.RENEWAL_SWEEP_ENABLED = 'false';

/**
 * Corrections finales ciblées (P2) — consentement + éligibilité DANS la
 * transaction de débit/confirmation, sur PostgreSQL réel (icode_host_pro_socle) :
 *
 *  (1) course révocation/débit sérialisée sur le verrou `FOR UPDATE` de la
 *      commande : la révocation committée AVANT la décision → zéro débit,
 *      zéro confirmation (« un CAS sans effet committé séparément n'est pas
 *      une réservation durable ») — puis le règlement MANUEL du même dossier
 *      reste ouvert, sans jamais réarmer la chaîne ;
 *  (2) paiement gagnant le verrou AVANT la révocation → UN seul paiement,
 *      révocation EFFECTIVE ensuite (FIFO des verrous de ligne PG) ;
 *  (3) renouvellement GRATUIT (amount <= 0) soumis à la MÊME règle : la
 *      confirmation `free` tranche dans sa propre transaction — refus sous
 *      verrou si révoqué, autorisée si consenti ;
 *  (4) révocation + création concurrente d'une fille → aucune descendance
 *      ARMÉE, quel que soit l'ordre d'arrivée gagnant ;
 *  (5) éligibilité SOUS VERROU (produit changé / abonnement non ACTIVE) →
 *      refus dans la transaction, jamais un mouvement.
 *
 * La voie MANUELLE (règlement client sans `requireRenewalConsent`) n'est
 * jamais soumise à la garde : révoquer n'empêche pas de régler.
 * Aucun réseau réel : MailTransportFactory + PanelTransportFactory stubbés.
 */
describe('P2 — consentement/eligibilite dans la transaction de debit (e2e PG)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;
  let checkoutSvc: CheckoutService;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const adminEmail = `p2admin_${stamp}@example.com`;
  const daveEmail = `p2dave_${stamp}@example.com`;
  const eveEmail = `p2eve_${stamp}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let daveToken = '';
  let eveToken = '';

  let daveUserId = '';
  let daveName = '';

  // Fixtures.
  let packId = '';
  let monthlyProductId = '';
  let monthlySlug = '';
  let monthlyName = '';
  let otherProductId = '';
  let virId = '';
  let createdMailId: string | null = null;
  const orderIds: string[] = [];

  // Scénario partagé (T1) : chaîne mère de Dave.
  let motherId = '';

  let daughterSeq = 0;
  let motherSeq = 0;

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };
  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({}) as PanelTransport,
  } as unknown as PanelTransportFactory;

  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

  /** Suit une promesse en vol : `flag.settled === false` = encore bloquée
   *  (preuve qu'elle attend un verrou détenu par la barrière de test). */
  function track<T>(p: PromiseLike<T>) {
    const flag = { settled: false };
    const promise = Promise.resolve(p).then((r) => {
      flag.settled = true;
      return r;
    });
    promise.catch(() => undefined); // jamais d'unhandled rejection pendant les attentes
    return { flag, promise };
  }

  /** Verrouille une commande `FOR UPDATE` et GARDE la tx ouverte (barrière). */
  async function holdOrderLock(orderId: string): Promise<{ release: () => Promise<void> }> {
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => {
      locked = r;
    });
    let open!: () => void;
    const openGate = new Promise<void>((r) => {
      open = r;
    });
    const txP = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      locked();
      await openGate;
      return true;
    });
    txP.catch(() => undefined); // expiration éventuelle (5 s) : jamais d'unhandled
    await lockedP;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        open();
        await txP;
      },
    };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email, password })
      .expect(201);
    return res.body.accessToken as string;
  }

  function checkout(email: string, name: string, productSlug: string, token?: string) {
    const req = request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/checkout`)
      .send({
        productSlug,
        name,
        email,
        paymentMethodId: virId,
        renewalConsent: true,
        ...(acceptanceFor(productSlug, virId) ?? {}),
      });
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  function confirm(orderId: string, token = adminToken) {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/orders/${orderId}/confirm-payment`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reference: `P2-RECETTE-${stamp}` });
  }

  /** Déclencheur : un passage complet du scheduler (admin). */
  function sweep(token = adminToken) {
    const req = request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/renewal/sweep`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  /** Révocation/activation du renouvellement sur une commande du client. */
  function toggleRenewal(orderId: string, enabled: boolean, token: string) {
    return request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/client/orders/${orderId}/renewal`)
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled });
  }

  /** Vrai parcours de fonds : recharge (justificatif) + validation admin. */
  async function fundWallet(token: string, amountCents: number): Promise<void> {
    const created = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/wallet/recharges`)
      .set('Authorization', `Bearer ${token}`)
      .field('amountCents', String(amountCents))
      .attach('proof', PNG_1PX, { filename: 'proof.png', contentType: 'image/png' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/wallet/recharges/${created.body.id}/validate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ bankRef: `BANK-P2-FUND-${created.body.id}` })
      .expect(201);
  }

  /** Fille de renouvellement impayée (fixture dédiée, jamais un compte réel). */
  async function makeDaughter(
    headOrderId: string,
    userId: string,
    opts: { autoRenew: boolean; amountTtcCents: number },
  ): Promise<{ orderId: string; invoiceId: string }> {
    daughterSeq += 1;
    const customer = await prisma.customer.findUniqueOrThrow({ where: { userId } });
    const account = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        customerName: account.name ?? account.email,
        customerEmail: account.email,
        productId: monthlyProductId,
        productName: monthlyName,
        packId,
        status: OrderStatus.PENDING_PAYMENT,
        billingCycle: BillingCycle.MONTHLY,
        currency: 'USD',
        taxRatePercent: 0,
        amountHtCents: opts.amountTtcCents,
        taxAmountCents: 0,
        amountTtcCents: opts.amountTtcCents,
        paymentMethodId: virId,
        paymentMethodName: 'Virement bancaire',
        idempotencyKey: `p2-daughter-${stamp}-${daughterSeq}`,
        renewsOrderId: headOrderId,
        renewalConsentAt: new Date(),
        autoRenew: opts.autoRenew,
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        number: `GOP2-${stamp}-${daughterSeq}`,
        orderId: order.id,
        customerId: customer.id,
        status: InvoiceStatus.UNPAID,
        currency: 'USD',
        taxRatePercent: 0,
        amountHtCents: opts.amountTtcCents,
        taxAmountCents: 0,
        amountTtcCents: opts.amountTtcCents,
        issuedAt: new Date(),
        // Échéance future : ni dunning ni suspension pendant les passages.
        dueDate: inDays(7),
      },
    });
    orderIds.push(order.id);
    return { orderId: order.id, invoiceId: invoice.id };
  }

  /** Horloge accélérée : échéance rétrogradée en base (jamais de fausse date). */
  async function makeDue(orderId: string, when: Date) {
    await prisma.order.update({
      where: { id: orderId },
      data: { autoRenew: true, nextBillingDate: when },
    });
  }

  /** Mère de chaîne SYNTHÉTIQUE + abonnement rattaché directement :
   *  `renewsOrderId` est unique (une seule fille par mère) et chaque
   *  confirmation pack REPOINTE l'abonnement actif du compte sur la dernière
   *  commande — donner à chaque test SA mère + SON abonnement évite tout
   *  croisement (et un second checkout qui dépendrait du flag C3). */
  async function makeMother(
    userId: string,
  ): Promise<{ orderId: string; subId: string }> {
    motherSeq += 1;
    const customer = await prisma.customer.findUniqueOrThrow({ where: { userId } });
    const account = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const mother = await prisma.order.create({
      data: {
        customerId: customer.id,
        customerName: account.name ?? account.email,
        customerEmail: account.email,
        productId: monthlyProductId,
        productName: monthlyName,
        packId,
        status: OrderStatus.PAID,
        billingCycle: BillingCycle.MONTHLY,
        currency: 'USD',
        taxRatePercent: 0,
        amountHtCents: 5_000,
        taxAmountCents: 0,
        amountTtcCents: 5_000,
        paymentMethodId: virId,
        paymentMethodName: 'Virement bancaire',
        idempotencyKey: `p2-mother-${stamp}-${motherSeq}`,
        renewalConsentAt: new Date(),
        // Mère JAMAIS due (ni head de sweep) : la course porte sur la fille.
        autoRenew: false,
        paidAt: daysAgo(1),
      },
    });
    const sub = await prisma.subscription.create({
      data: {
        userId,
        productId: monthlyProductId,
        status: SubscriptionStatus.ACTIVE,
        orderId: mother.id,
      },
    });
    orderIds.push(mother.id);
    return { orderId: mother.id, subId: sub.id };
  }

  // ── Boot + fixtures ────────────────────────────────────────────────────────
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
    checkoutSvc = moduleRef.get(CheckoutService);
    limiter.reset();

    const mkUser = async (email: string, role: Role, name: string) => {
      await prisma.user.create({
        data: { email, name, passwordHash: await bcrypt.hash(password, 10), role },
      });
    };
    await mkUser(adminEmail, Role.ADMIN, 'Admin P2');
    await mkUser(daveEmail, Role.USER, 'Dave P2');
    await mkUser(eveEmail, Role.USER, 'Eve P2');
    adminToken = await login(adminEmail);
    daveToken = await login(daveEmail);
    eveToken = await login(eveEmail);

    const dave = await prisma.user.findUniqueOrThrow({
      where: { email: daveEmail },
      select: { id: true, name: true },
    });
    daveUserId = dave.id;
    daveName = dave.name ?? 'Dave P2';

    const pack = await prisma.hostingPack.create({
      data: { name: `p2-pack-${stamp}`, ramMb: 512 },
    });
    packId = pack.id;

    const monthly = await prisma.product.create({
      data: {
        name: `p2-monthly-${stamp}`,
        slug: `p2-monthly-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 5000,
        billingCycle: BillingCycle.MONTHLY,
        packId,
      },
    });
    monthlyProductId = monthly.id;
    monthlySlug = monthly.slug!;
    monthlyName = monthly.name ?? `p2-monthly-${stamp}`;

    // Autre produit (T5) : bascule d'éligibilité « produit changé ».
    const other = await prisma.product.create({
      data: {
        name: `p2-other-${stamp}`,
        slug: `p2-other-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 9000,
        billingCycle: BillingCycle.MONTHLY,
      },
    });
    otherProductId = other.id;

    const vir = await prisma.paymentMethod.create({
      data: { name: `VIR-P2-${stamp}`, type: PaymentMethodType.BANK_TRANSFER, isActive: true },
    });
    virId = vir.id;

    const priorMail = await prisma.mailSetting.findFirst();
    if (!priorMail || !priorMail.host || !priorMail.fromEmail) {
      createdMailId = (
        await prisma.mailSetting.create({
          data: {
            host: 'smtp.test.local',
            fromEmail: `noreply-${stamp}@test.local`,
            fromName: 'Code Diali P2',
          },
        })
      ).id;
    }

    await preloadAcceptance(app.getHttpServer(), monthlySlug, virId);
  });

  beforeEach(() => {
    limiter.reset();
  });

  afterAll(async () => {
    const customers = await prisma.customer
      .findMany({
        where: { email: { in: [daveEmail, eveEmail] } },
        select: { id: true },
      })
      .catch(() => [] as { id: string }[]);
    try {
      const txs = await prisma.walletTransaction.findMany({
        where: { customerId: { in: customers.map((c) => c.id) } },
        select: { proofPath: true },
      });
      for (const t of txs) {
        if (t.proofPath) {
          try {
            const { unlinkSync } = await import('node:fs');
            const { resolve } = await import('node:path');
            unlinkSync(resolve(process.cwd(), 'public', 'wallet-proofs', t.proofPath.replace(/^.*[\\/]/, '')));
          } catch {
            /* déjà parti */
          }
        }
      }
    } catch {
      /* best-effort */
    }

    const allEmails = [adminEmail, daveEmail, eveEmail];
    const users = await prisma.user.findMany({
      where: { email: { in: allEmails } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    const orders = await prisma.order.findMany({
      where: { OR: [{ customerEmail: { in: allEmails } }, { id: { in: orderIds } }] },
      select: { id: true },
    });
    const ids = orders.map((o) => o.id);
    const subs = await prisma.subscription.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    });

    await prisma.auditLog
      .deleteMany({ where: { resourceId: { in: [...ids, ...subs.map((s) => s.id)] } } })
      .catch(() => {});
    await prisma.walletTransaction
      .deleteMany({ where: { customerId: { in: customers.map((c) => c.id) } } })
      .catch(() => {});
    await prisma.invoice.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.subscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { email: { in: allEmails } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: allEmails } } }).catch(() => {});
    await prisma.product
      .deleteMany({ where: { id: { in: [monthlyProductId, otherProductId] } } })
      .catch(() => {});
    await prisma.hostingPack.deleteMany({ where: { id: packId } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: virId } }).catch(() => {});
    if (createdMailId) {
      await prisma.mailSetting.delete({ where: { id: createdMailId } }).catch(() => {});
    }
    await app?.close();
  });

  // ── (1) révocation committée AVANT la décision de débit ────────────────────
  it('1 — révocation committée AVANT la décision → zéro débit/confirmation, puis règlement manuel ouvert', async () => {
    const res = await checkout(daveEmail, daveName, monthlySlug, daveToken).expect(201);
    motherId = (res.body as { orderId: string }).orderId;
    orderIds.push(motherId);
    await confirm(motherId).expect(201);
    await fundWallet(daveToken, 50_000);
    const daughter = await makeDaughter(motherId, daveUserId, {
      autoRenew: true,
      amountTtcCents: 5_000,
    });

    const lock = await holdOrderLock(daughter.orderId);
    // (a) la révocation part la première et se heurte au verrou de la fille.
    const rev = track(toggleRenewal(daughter.orderId, false, daveToken).expect(200));
    await sleep(400);
    expect(rev.flag.settled).toBe(false); // bloquée sur `FOR UPDATE`

    // (b) le sweep passe la passe rapide (lu `autoRenew=true` committé) puis
    //     la TX de débit se heurte au MÊME verrou, DERRIÈRE la révocation.
    const sw = track(sweep().expect(201));
    await sleep(400);
    expect(sw.flag.settled).toBe(false); // décision de débit encore en vol

    await lock.release();
    const [revRes, swRes] = await Promise.all([rev.promise, sw.promise]);

    expect(swRes.body).toMatchObject({ paid: 0 });
    expect(swRes.body.pending).toBeGreaterThanOrEqual(1);
    expect(revRes.body.autoRenew).toBe(false);

    // L'AUTORITÉ (dans la TX, sous verrou) refuse : AUCUN mouvement.
    expect(await prisma.walletTransaction.count({ where: { orderId: daughter.orderId } })).toBe(0);
    const d1 = await prisma.order.findUniqueOrThrow({ where: { id: daughter.orderId } });
    expect(d1.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(d1.autoRenew).toBe(false);
    expect(d1.paidAt).toBeNull();
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: daughter.invoiceId } })).status,
    ).toBe(InvoiceStatus.UNPAID);
    expect(
      await prisma.orderStatusHistory.count({
        where: { orderId: daughter.orderId, status: OrderStatus.PAID },
      }),
    ).toBe(0);
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { userId: daveUserId } }))
        .walletBalanceCents,
    ).toBe(50_000);

    // DISTINCTION auto/manuel : le règlement VOLONTAIRE reste ouvert malgré
    // la révocation — et ne réarme JAMAIS la chaîne.
    const manual = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/orders/${daughter.orderId}/pay-with-wallet`)
      .set('Authorization', `Bearer ${daveToken}`)
      .expect(201);
    expect(manual.body.status).toBe(OrderStatus.ACTIVE);
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: daughter.invoiceId } })).status,
    ).toBe(InvoiceStatus.PAID);
    const manualDebits = await prisma.walletTransaction.findMany({
      where: { orderId: daughter.orderId, type: 'DEBIT' },
    });
    expect(manualDebits).toHaveLength(1);
    expect(manualDebits[0].idempotencyKey).toBe(`wallet-pay:${daughter.orderId}`);
    const d1After = await prisma.order.findUniqueOrThrow({ where: { id: daughter.orderId } });
    expect(d1After.status).toBe(OrderStatus.ACTIVE);
    expect(d1After.autoRenew).toBe(false); // JAMAIS réarmé par un règlement manuel
    expect(d1After.nextBillingDate).toBeNull();
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { userId: daveUserId } }))
        .walletBalanceCents,
    ).toBe(45_000);
  });

  // ── (2) paiement gagnant le verrou avant révocation ────────────────────────
  it('2 — paiement gagnant le verrou AVANT révocation → un seul paiement, révocation effective ensuite', async () => {
    const m2 = await makeMother(daveUserId);
    const daughter = await makeDaughter(m2.orderId, daveUserId, {
      autoRenew: true,
      amountTtcCents: 4_000,
    });
    const user: JwtPayload = { sub: daveUserId, email: daveEmail, role: Role.USER };

    const lock = await holdOrderLock(daughter.orderId);
    // (a) le paiement AUTOMATIQUE part le premier (verrou de ligne détenu).
    const pay = track(
      checkoutSvc.payOrderWithWallet(daughter.orderId, user, { requireRenewalConsent: true }),
    );
    await sleep(400);
    expect(pay.flag.settled).toBe(false); // attend le verrou de la barrière

    // (b) la révocation arrive ensuite : elle ne s'appliquera qu'APRÈS le
    //     commit gagnant (FIFO du verrouillage PG).
    const rev = track(toggleRenewal(daughter.orderId, false, daveToken).expect(200));
    await sleep(400);
    expect(rev.flag.settled).toBe(false);

    await lock.release();
    const [payRes, revRes] = await Promise.all([pay.promise, rev.promise]);

    // UN seul paiement (clé idempotente, montant exact, solde débité une fois).
    const debits = await prisma.walletTransaction.findMany({
      where: { orderId: daughter.orderId, type: 'DEBIT' },
    });
    expect(debits).toHaveLength(1);
    expect(debits[0].amountCents).toBe(4_000);
    expect(debits[0].idempotencyKey).toBe(`wallet-pay:${daughter.orderId}`);
    expect(payRes.status).toBe(OrderStatus.ACTIVE);
    expect(payRes.replayed).toBe(false);
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: daughter.invoiceId } })).status,
    ).toBe(InvoiceStatus.PAID);
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { userId: daveUserId } }))
        .walletBalanceCents,
    ).toBe(41_000);

    // …puis la révocation s'applique EFFECTIVEMENT après le commit gagnant.
    expect(revRes.body.autoRenew).toBe(false);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: daughter.orderId } });
    expect(after.status).toBe(OrderStatus.ACTIVE);
    expect(after.autoRenew).toBe(false);

    // Rejeu neutre (déjà réglé) : aucun second effet, consentement révoqué ou non.
    const again = await checkoutSvc.payOrderWithWallet(daughter.orderId, user, {
      requireRenewalConsent: true,
    });
    expect(again.replayed).toBe(true);
    expect(await prisma.walletTransaction.count({ where: { orderId: daughter.orderId } })).toBe(1);
  });

  // ── (3) renouvellement GRATUIT : même règle ────────────────────────────────
  it('3 — renouvellement GRATUIT : refus sous verrou si révoqué, confirmation free autorisée si consenti', async () => {
    const m3a = await makeMother(daveUserId);
    const free = await makeDaughter(m3a.orderId, daveUserId, {
      autoRenew: true,
      amountTtcCents: 0,
    });

    const lock = await holdOrderLock(free.orderId);
    const rev = track(toggleRenewal(free.orderId, false, daveToken).expect(200));
    await sleep(400);
    expect(rev.flag.settled).toBe(false);

    // La passe rapide lit `autoRenew=true` (committé) : la décision GRATUITE
    // part — `confirmOrderPaid` (sous garde) se heurte au verrou de la fille.
    const sw = track(sweep().expect(201));
    await sleep(400);
    expect(sw.flag.settled).toBe(false);

    await lock.release();
    const [revRes, swRes] = await Promise.all([rev.promise, sw.promise]);

    // Révoqué sous verrou → REFUS : ni confirmation, ni droit, ni mouvement.
    expect(swRes.body).toMatchObject({ paid: 0 });
    expect(revRes.body.autoRenew).toBe(false);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: free.orderId } });
    expect(after.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(after.autoRenew).toBe(false);
    expect(after.paidAt).toBeNull();
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: free.invoiceId } })).status,
    ).toBe(InvoiceStatus.UNPAID);
    expect(await prisma.walletTransaction.count({ where: { orderId: free.orderId } })).toBe(0);
    expect(
      await prisma.orderStatusHistory.count({
        where: { orderId: free.orderId, status: OrderStatus.PAID },
      }),
    ).toBe(0);

    // Contrôle : la MÊME confirmation free, consentement présent → autorisée
    // (la garde tranche dans LA transaction qui ouvre les droits).
    const m3b = await makeMother(daveUserId);
    const freeOk = await makeDaughter(m3b.orderId, daveUserId, {
      autoRenew: true,
      amountTtcCents: 0,
    });
    const ok = await checkoutSvc.confirmOrderPaid(
      freeOk.orderId,
      { source: 'free' },
      { requireRenewalConsent: true },
    );
    expect(ok.status).toBe(OrderStatus.ACTIVE);
    expect(ok.alreadyConfirmed).toBe(false);
    const okOrder = await prisma.order.findUniqueOrThrow({ where: { id: freeOk.orderId } });
    expect(okOrder.status).toBe(OrderStatus.ACTIVE);
    expect(okOrder.autoRenew).toBe(true); // chaîne reconduite (consentement présent)
    expect(okOrder.nextBillingDate).not.toBeNull();
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: freeOk.invoiceId } })).status,
    ).toBe(InvoiceStatus.PAID);
    expect(await prisma.walletTransaction.count({ where: { orderId: freeOk.orderId } })).toBe(0);
  });

  // ── (4) révocation + création concurrente ──────────────────────────────────
  it('4 — révocation + création concurrente d’une fille → aucune descendance armée', async () => {
    const res = await checkout(eveEmail, 'Eve P2', monthlySlug, eveToken).expect(201);
    const eveMotherId = (res.body as { orderId: string }).orderId;
    orderIds.push(eveMotherId);
    await confirm(eveMotherId).expect(201);
    await makeDue(eveMotherId, daysAgo(1));

    const [rev, sw] = await Promise.all([
      Promise.resolve(toggleRenewal(eveMotherId, false, eveToken).expect(200)),
      Promise.resolve(sweep().expect(201)),
    ]);

    // INVARIANT — quel que soit le gagnant de la course : plus AUCUNE commande
    // de la chaîne n'est ARMÉE (mère ni fille).
    const eveOrders = await prisma.order.findMany({ where: { customerEmail: eveEmail } });
    expect(eveOrders.filter((o) => o.autoRenew)).toHaveLength(0);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: eveMotherId } })).autoRenew,
    ).toBe(false);
    expect(rev.body.autoRenew).toBe(false);
    expect(sw.body.paid).toBe(0);
    expect(sw.body.stopped).toBe(0);

    // Toute fille née pendant la course est DÉSARMÉE, impayée, sans débit
    // (Eve n'a aucun solde : aucun prélèvement ne peut aboutir).
    const daughters = eveOrders.filter((o) => o.renewsOrderId === eveMotherId);
    expect(daughters.length).toBeLessThanOrEqual(1);
    for (const d of daughters) {
      expect(d.autoRenew).toBe(false);
      expect(d.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect((await prisma.invoice.findUnique({ where: { orderId: d.id } }))?.status).toBe(
        InvoiceStatus.UNPAID,
      );
      expect(await prisma.walletTransaction.count({ where: { orderId: d.id } })).toBe(0);
    }
  });

  // ── (5) éligibilité sous verrou ────────────────────────────────────────────
  it('5 — éligibilité SOUS VERROU : produit changé / abonnement non ACTIVE → refus dans la transaction', async () => {
    const m5 = await makeMother(daveUserId);
    const d = await makeDaughter(m5.orderId, daveUserId, {
      autoRenew: true,
      amountTtcCents: 0,
    });
    const subId = m5.subId;
    const originalProductId = monthlyProductId;
    try {
      // (a) produit de la chaîne changé (upgrade) → refus sous verrou.
      await prisma.subscription.update({
        where: { id: subId },
        data: { productId: otherProductId },
      });
      await expect(
        checkoutSvc.confirmOrderPaid(d.orderId, { source: 'free' }, { requireRenewalConsent: true }),
      ).rejects.toThrow(ConflictException);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: d.orderId } })).status,
      ).toBe(OrderStatus.PENDING_PAYMENT);

      // (b) abonnement non ACTIVE → refus sous verrou (jamais de mouvement).
      await prisma.subscription.update({
        where: { id: subId },
        data: { productId: originalProductId, status: SubscriptionStatus.SUSPENDED },
      });
      await expect(
        checkoutSvc.confirmOrderPaid(d.orderId, { source: 'free' }, { requireRenewalConsent: true }),
      ).rejects.toThrow(ConflictException);
      expect(
        (await prisma.invoice.findUniqueOrThrow({ where: { id: d.invoiceId } })).status,
      ).toBe(InvoiceStatus.UNPAID);
      expect(await prisma.walletTransaction.count({ where: { orderId: d.orderId } })).toBe(0);
      expect(
        await prisma.orderStatusHistory.count({
          where: { orderId: d.orderId, status: OrderStatus.PAID },
        }),
      ).toBe(0);
    } finally {
      await prisma.subscription.update({
        where: { id: subId },
        data: { productId: originalProductId, status: SubscriptionStatus.ACTIVE },
      });
    }
  });
});
