import { INestApplication, ValidationPipe } from '@nestjs/common';
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
import { addBillingCycle } from '../src/store/billing-cycle';
import { OrderLifecycleService } from '../src/store/order-lifecycle.service';
import { WalletService } from '../src/wallet/wallet.service';

// Sweeps (timers) OFF : les passages sont déclenchés à la demande (horloge
// accélérée = échéances rétrogradées en base, jamais d'exécution fantôme).
process.env.ORDER_SWEEP_ENABLED = 'false';
process.env.RENEWAL_SWEEP_ENABLED = 'false';

/**
 * P8 — Abonnements récurrents (e2e, lot D2, GO socle) :
 *
 *  A. Échéance initiale : confirmation d'un cycle MONTHLY → `autoRenew=true`
 *     + `nextBillingDate = paidAt + 1 mois` (ms exactes via `addBillingCycle`,
 *     clamp jour) ; ONETIME → `nextBillingDate=null`, aucun renouvellement ;
 *  B. Renouvellement PAYÉ (solde C2) : échéance rétrogradée → sweep → NOUVELLE
 *     commande (`renewsOrderId`) + 2e facture (numéro distinct, montants
 *     figés = price-lock), débit solde UNIQUE, mère `autoRenew=false`,
 *     PAID→ACTIVE sans provisioning (aucune allocation, aucun statut
 *     PROVISIONING), idempotence, puis chaîne renewal2 ;
 *  C. Renouvellement IMPAYÉ (solde insuffisant) → facture UNPAID ; rappel
 *     unique (`dunningRemindedAt` + audit) ; au-delà du délai de grâce →
 *     suspension ACTIVE→SUSPENDED (audit, **statut seul : aucun appel infra,
 *     §6-4**) ; souscription suspendue = chaîne résumable (pas d'arrêt) ;
 *  D. Reprise de crash (débit committé, confirmation jamais exécutée) →
 *     sweep → re-confirmation SANS second débit (net des débits non
 *     compensés, clé legacy `renewal:<orderId>` conservée comme données) ;
 *  E. Expiration 48 h : un renouvellement PENDING n'est JAMAIS annulé par le
 *     sweep de reprise (son impayé vit le dunning), contrairement à une
 *     commande standard du même âge ;
 *  F. RBAC du point de déclenchement : 401 anonyme / 403 client / 200 admin.
 *
 * Aucun réseau réel : MailTransportFactory + PanelTransportFactory stubbés,
 * PrismaService RÉEL sur la base dédiée du chantier (icode_host_pro_socle).
 * Aucun solde n'est écrit en direct : les fonds passent par le vrai parcours
 * recharge (client) + validation (admin), et les débits par `WalletService`.
 */
describe('Abonnements récurrents (e2e, P8)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;
  let walletSvc: WalletService;
  let lifecycle: OrderLifecycleService;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const adminEmail = `p8admin_${stamp}@example.com`;
  const aliceEmail = `p8alice_${stamp}@example.com`;
  const bobEmail = `p8bob_${stamp}@example.com`;
  const carolEmail = `p8carol_${stamp}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let aliceToken = '';
  let bobToken = '';
  let carolToken = '';

  // Fixtures.
  let packId = '';
  let monthlyProductId = '';
  let monthlySlug = '';
  let onetimeProductId = '';
  let onetimeSlug = '';
  let virId = '';
  let createdMailId: string | null = null;
  const orderIds: string[] = [];

  // Scénario.
  let aliceUserId = '';
  let bobUserId = '';
  let carolUserId = '';
  let aliceCustomerId = '';
  let carolCustomerId = '';
  let mother1Id = ''; // Alice MONTHLY (A/B)
  let onetimeOrderId = ''; // Alice ONETIME (A2)
  let renewal1Id = ''; // 1er renouvellement payé (B)
  let renewal2Id = ''; // 2e renouvellement payé (chaîne B)
  let bobMotherId = ''; // Bob MONTHLY (C)
  let bobRenewalId = ''; // renouvellement impayé de Bob (C/D/E)
  let carolMotherId = ''; // Carol MONTHLY (D)
  let carolRenewalId = ''; // renouvellement repris après crash (D)
  let staleOrderId = ''; // commande standard périmée (E, contraste)

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };
  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({}) as PanelTransport,
  } as unknown as PanelTransportFactory;

  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

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
      // Q-A (item 4) : consentement EXPLICITE au renouvellement (case du
      // checkout) — sans lui, aucun prélèvement automatique n'est planifié.
      // P7 : preuve d'acceptation tarifaire obligatoire (préchargée).
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
      .send({ reference: `P8-RECETTE-${stamp}` });
  }

  /** Déclencheur P8 : un passage complet du scheduler (admin). */
  function sweep(token = adminToken) {
    const req = request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/renewal/sweep`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
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
      .send({ bankRef: `BANK-Q8-FUND-${created.body.id}` })
      .expect(201);
  }

  /** Horloge accélérée : échéance rétrogradée en base (jamais de fausse date). */
  async function makeDue(orderId: string, when: Date) {
    await prisma.order.update({
      where: { id: orderId },
      data: { autoRenew: true, nextBillingDate: when },
    });
  }

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

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
    walletSvc = moduleRef.get(WalletService);
    lifecycle = moduleRef.get(OrderLifecycleService);
    limiter.reset();

    const mkUser = async (email: string, role: Role, name: string) => {
      await prisma.user.create({
        data: { email, name, passwordHash: await bcrypt.hash(password, 10), role },
      });
    };
    await mkUser(adminEmail, Role.ADMIN, 'Admin P8');
    await mkUser(aliceEmail, Role.USER, 'Alice P8');
    await mkUser(bobEmail, Role.USER, 'Bob P8');
    await mkUser(carolEmail, Role.USER, 'Carol P8');
    adminToken = await login(adminEmail);
    aliceToken = await login(aliceEmail);
    bobToken = await login(bobEmail);
    carolToken = await login(carolEmail);

    const users = await prisma.user.findMany({
      where: { email: { in: [aliceEmail, bobEmail, carolEmail] } },
      select: { id: true, email: true },
    });
    aliceUserId = users.find((u) => u.email === aliceEmail)!.id;
    bobUserId = users.find((u) => u.email === bobEmail)!.id;
    carolUserId = users.find((u) => u.email === carolEmail)!.id;

    const pack = await prisma.hostingPack.create({
      data: { name: `p8-pack-${stamp}`, ramMb: 512 },
    });
    packId = pack.id;

    const monthly = await prisma.product.create({
      data: {
        name: `p8-monthly-${stamp}`,
        slug: `p8-monthly-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 5000,
        billingCycle: BillingCycle.MONTHLY,
        packId,
      },
    });
    monthlyProductId = monthly.id;
    monthlySlug = monthly.slug!;

    // ONETIME sans pack : aucune interaction d'abonnement (isolation A2).
    const onetime = await prisma.product.create({
      data: {
        name: `p8-onetime-${stamp}`,
        slug: `p8-onetime-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 1000,
        billingCycle: BillingCycle.ONETIME,
      },
    });
    onetimeProductId = onetime.id;
    onetimeSlug = onetime.slug!;

    const vir = await prisma.paymentMethod.create({
      data: { name: `VIR-P8-${stamp}`, type: PaymentMethodType.BANK_TRANSFER, isActive: true },
    });
    virId = vir.id;

    const priorMail = await prisma.mailSetting.findFirst();
    if (!priorMail || !priorMail.host || !priorMail.fromEmail) {
      createdMailId = (
        await prisma.mailSetting.create({
          data: {
            host: 'smtp.test.local',
            fromEmail: `noreply-${stamp}@test.local`,
            fromName: 'Code Diali P8',
          },
        })
      ).id;
    }

    // P7 : preuves d'acceptation pour les 2 produits × VIR unique.
    await preloadAcceptance(app.getHttpServer(), monthlySlug, virId);
    await preloadAcceptance(app.getHttpServer(), onetimeSlug, virId);
  });

  beforeEach(() => {
    limiter.reset();
  });

  afterAll(async () => {
    try {
      // Justificatifs de recharge sur disque.
      const customers = await prisma.customer.findMany({
        where: { email: { in: [aliceEmail, bobEmail, carolEmail] } },
        select: { id: true },
      });
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

    const allEmails = [adminEmail, aliceEmail, bobEmail, carolEmail];
    const users = await prisma.user.findMany({
      where: { email: { in: allEmails } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    const orders = await prisma.order.findMany({
      where: {
        OR: [
          { customerEmail: { in: allEmails } },
          { id: { in: orderIds } },
        ],
      },
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
      .deleteMany({ where: { customerId: { in: (await prisma.customer.findMany({ where: { email: { in: allEmails } }, select: { id: true } })).map((c) => c.id) } } })
      .catch(() => {});
    await prisma.invoice.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.subscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { email: { in: allEmails } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: allEmails } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { id: { in: [monthlyProductId, onetimeProductId] } } }).catch(() => {});
    await prisma.hostingPack.deleteMany({ where: { id: packId } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: virId } }).catch(() => {});
    if (createdMailId) {
      await prisma.mailSetting.delete({ where: { id: createdMailId } }).catch(() => {});
    }
    await app?.close();
  });

  // ── A. Échéances initiales ────────────────────────────────────────────────
  it('A — confirmation MONTHLY pose autoRenew + échéance ms exactes ; ONETIME reste vide', async () => {
    const res = await checkout(aliceEmail, 'Alice P8', monthlySlug, aliceToken).expect(201);
    mother1Id = (res.body as { orderId: string }).orderId;
    orderIds.push(mother1Id);

    await confirm(mother1Id).expect(201);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: mother1Id } });
    expect(order.billingCycle).toBe(BillingCycle.MONTHLY);
    expect(order.autoRenew).toBe(true);
    expect(order.paidAt).not.toBeNull();
    expect(order.nextBillingDate).not.toBeNull();
    // Même jour le mois suivant, ms exactes (détérministe = addBillingCycle).
    expect(order.nextBillingDate!.getTime()).toBe(
      addBillingCycle(order.paidAt!, BillingCycle.MONTHLY)!.getTime(),
    );

    // Souscription ACTIVE order-driven créée à la confirmation (pack présent).
    const sub = await prisma.subscription.findFirst({
      where: { userId: aliceUserId, status: SubscriptionStatus.ACTIVE },
    });
    expect(sub).not.toBeNull();
    expect(sub!.productId).toBe(monthlyProductId);
    expect(sub!.orderId).toBe(mother1Id);

    // ONETIME : aucun droit ouvert, aucune échéance, aucun renouvellement.
    const res2 = await checkout(aliceEmail, 'Alice P8', onetimeSlug, aliceToken).expect(201);
    onetimeOrderId = (res2.body as { orderId: string }).orderId;
    orderIds.push(onetimeOrderId);
    await confirm(onetimeOrderId).expect(201);
    const once = await prisma.order.findUniqueOrThrow({ where: { id: onetimeOrderId } });
    expect(once.billingCycle).toBe(BillingCycle.ONETIME);
    expect(once.autoRenew).toBe(false);
    expect(once.nextBillingDate).toBeNull();
    expect(
      await prisma.order.count({ where: { renewsOrderId: onetimeOrderId } }),
    ).toBe(0);
  });

  // ── B. Renouvellement payé par solde ──────────────────────────────────────
  it('B — échu + solde suffisant → 2e commande + 2e facture + débit unique, sans provisioning', async () => {
    await fundWallet(aliceToken, 50_000);
    const aliceCustomer = await prisma.customer.findUniqueOrThrow({
      where: { userId: aliceUserId },
    });
    aliceCustomerId = aliceCustomer.id;
    const balanceBefore = aliceCustomer.walletBalanceCents;
    const mother = await prisma.order.findUniqueOrThrow({ where: { id: mother1Id } });
    const motherInvoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId: mother1Id } });

    // Horloge accélérée : l'échéance est déjà passée.
    await makeDue(mother1Id, daysAgo(1));
    const r = await sweep().expect(201);
    expect(r.body).toMatchObject({ created: 1, paid: 1, pending: 0, stopped: 0 });

    const renewal1 = await prisma.order.findUniqueOrThrow({
      where: { renewsOrderId: mother1Id },
    });
    renewal1Id = renewal1.id;
    orderIds.push(renewal1Id);

    // Commande + facture NOUVELLES, montants figés (price-lock de la mère).
    expect(renewal1.id).not.toBe(mother1Id);
    expect(renewal1.billingCycle).toBe(BillingCycle.MONTHLY);
    expect(renewal1.amountTtcCents).toBe(mother.amountTtcCents);
    expect(renewal1.autoRenew).toBe(true); // la chaîne se poursuit
    const renewal1Invoice = await prisma.invoice.findUniqueOrThrow({
      where: { orderId: renewal1Id },
    });
    expect(renewal1Invoice.number).not.toBe(motherInvoice.number);
    expect(renewal1Invoice.number).toMatch(/^\d{4}-\d{4}$/);
    expect(renewal1Invoice.status).toBe(InvoiceStatus.PAID);
    expect(renewal1Invoice.amountTtcCents).toBe(mother.amountTtcCents);
    expect(renewal1Invoice.dueDate).not.toBeNull();

    // La mère cesse d'être le chef de file (une seule tentative à la fois).
    const motherAfter = await prisma.order.findUniqueOrThrow({ where: { id: mother1Id } });
    expect(motherAfter.autoRenew).toBe(false);
    expect(motherAfter.nextBillingDate).not.toBeNull(); // traçabilité de l'échéance manquée

    // Débit solde UNIQUE et exact.
    const debits = await prisma.walletTransaction.findMany({
      where: { orderId: renewal1Id, type: 'DEBIT' },
    });
    expect(debits).toHaveLength(1);
    expect(debits[0].amountCents).toBe(mother.amountTtcCents);
    expect(debits[0].status).toBe('SUCCEEDED');
    // Q-A (item 1) : débit + confirmation sont ATOMIQUES (clé wallet-pay).
    expect(debits[0].idempotencyKey).toBe(`wallet-pay:${renewal1Id}`);
    const aliceAfter = await prisma.customer.findUniqueOrThrow({ where: { id: aliceCustomerId } });
    expect(aliceAfter.walletBalanceCents).toBe(balanceBefore - mother.amountTtcCents);

    // PAID → ACTIVE dans la même transaction : JAMAIS de provisioning.
    expect(renewal1.status).toBe(OrderStatus.ACTIVE);
    const hist = await prisma.orderStatusHistory.findMany({
      where: { orderId: renewal1Id },
      select: { status: true },
    });
    expect(hist.map((h) => h.status)).not.toContain(OrderStatus.PROVISIONING);
    // Aucun déploiement ni allocation d'infrastructure n'est porté par la
    // commande de renouvellement (1 app par commande — Deployment.orderId).
    expect(
      await prisma.deployment.count({ where: { orderId: renewal1Id } }),
    ).toBe(0);

    // Audit de création.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'subscription.renewal_created', resourceId: renewal1Id },
    });
    expect(audit).not.toBeNull();

    // Idempotence : un second sweep ne recrée RIEN.
    const r2 = await sweep().expect(201);
    expect(r2.body).toMatchObject({ created: 0, paid: 0, pending: 0 });
    expect(await prisma.order.count({ where: { renewsOrderId: mother1Id } })).toBe(1);
  });

  it('B2 — chaîne : le renouvellement payé devient à son tour le chef de file', async () => {
    await makeDue(renewal1Id, daysAgo(1));
    const balanceBefore = (
      await prisma.customer.findUniqueOrThrow({ where: { id: aliceCustomerId } })
    ).walletBalanceCents;

    const r = await sweep().expect(201);
    expect(r.body).toMatchObject({ created: 1, paid: 1 });

    const renewal2 = await prisma.order.findUniqueOrThrow({
      where: { renewsOrderId: renewal1Id },
    });
    renewal2Id = renewal2.id;
    orderIds.push(renewal2Id);
    expect(renewal2.status).toBe(OrderStatus.ACTIVE);
    const renewal1After = await prisma.order.findUniqueOrThrow({ where: { id: renewal1Id } });
    expect(renewal1After.autoRenew).toBe(false);

    const invoice2 = await prisma.invoice.findUniqueOrThrow({ where: { orderId: renewal2Id } });
    expect(invoice2.status).toBe(InvoiceStatus.PAID);
    const alice = await prisma.customer.findUniqueOrThrow({ where: { id: aliceCustomerId } });
    expect(alice.walletBalanceCents).toBe(
      balanceBefore - (await prisma.order.findUniqueOrThrow({ where: { id: renewal2Id } })).amountTtcCents,
    );
  });

  // ── C. Impayé : dunning puis suspension ───────────────────────────────────
  it('C — solde insuffisant → renouvellement PENDING + facture UNPAID, mère fermée', async () => {
    // Bob : aucun portefeuille → le débit échoue (409), rien n'est fabriqué.
    const res = await checkout(bobEmail, 'Bob P8', monthlySlug, bobToken).expect(201);
    bobMotherId = (res.body as { orderId: string }).orderId;
    orderIds.push(bobMotherId);
    await confirm(bobMotherId).expect(201);
    const bobCustomer = await prisma.customer.findUniqueOrThrow({ where: { userId: bobUserId } });
    expect(bobCustomer.walletBalanceCents).toBe(0);

    await makeDue(bobMotherId, daysAgo(1));
    const r = await sweep().expect(201);
    expect(r.body).toMatchObject({ created: 1, paid: 0 });
    // `pending` ≥ 1 : création + rejeu de la passe de paiement sur le même
    // renouvellement (débit re-tenté idempotamment, jamais fabriqué).
    expect(r.body.pending).toBeGreaterThanOrEqual(1);

    const renewal = await prisma.order.findUniqueOrThrow({ where: { renewsOrderId: bobMotherId } });
    bobRenewalId = renewal.id;
    orderIds.push(bobRenewalId);
    expect(renewal.status).toBe(OrderStatus.PENDING_PAYMENT);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { orderId: bobRenewalId } });
    expect(inv.status).toBe(InvoiceStatus.UNPAID);
    expect(inv.dunningRemindedAt).toBeNull();
    const mother = await prisma.order.findUniqueOrThrow({ where: { id: bobMotherId } });
    expect(mother.autoRenew).toBe(false);
    // Aucun débit ni crédit ne doit avoir été fabriqué.
    expect(
      await prisma.walletTransaction.count({ where: { orderId: bobRenewalId } }),
    ).toBe(0);
  });

  it('C1 — Q12-P2 : révocation sur la MÈRE (cascade vers la fille) → recharge → sweep SANS débit', async () => {
    // La fille porte le consentement copié : avant la révocation, elle est
    // bien armée (autoRenew=true) — c'est cette signature que la reprise CAS.
    const daughterBefore = await prisma.order.findUniqueOrThrow({
      where: { id: bobRenewalId },
    });
    expect(daughterBefore.autoRenew).toBe(true);

    // Bob révoque sur LA COMMANDE QU'IL VOIT (la mère, déjà autoRenew=false
    // depuis la création) : sans cascade, ce serait un no-op silencieux.
    const off = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/client/orders/${bobMotherId}/renewal`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ enabled: false })
      .expect(200);
    expect(off.body.autoRenew).toBe(false);

    // Cascade : la fille est basculée — plus aucun prélèvement possible.
    const daughterAfter = await prisma.order.findUniqueOrThrow({
      where: { id: bobRenewalId },
    });
    expect(daughterAfter.autoRenew).toBe(false);
    expect(
      await prisma.auditLog.findFirst({
        where: { action: 'subscription.renewal_toggled', resourceId: bobMotherId },
      }),
    ).not.toBeNull();

    // Bob recharge (vrai parcours : preuve + validation admin).
    await fundWallet(bobToken, 100_000);
    const balanceAfterFund = (
      await prisma.customer.findUniqueOrThrow({ where: { userId: bobUserId } })
    ).walletBalanceCents;
    expect(balanceAfterFund).toBeGreaterThanOrEqual(100_000);

    // Sweep : la reprise voit la révocation → SANS débit, facture toujours
    // UNPAID (dunning garde son droit), solde intact.
    const r = await sweep().expect(201);
    expect(r.body.paid).toBe(0);
    expect(
      await prisma.walletTransaction.count({ where: { orderId: bobRenewalId } }),
    ).toBe(0);
    const stillPending = await prisma.order.findUniqueOrThrow({
      where: { id: bobRenewalId },
    });
    expect(stillPending.status).toBe(OrderStatus.PENDING_PAYMENT);
    const inv = await prisma.invoice.findUniqueOrThrow({
      where: { orderId: bobRenewalId },
    });
    expect(inv.status).toBe(InvoiceStatus.UNPAID);
    const balanceAfterSweep = (
      await prisma.customer.findUniqueOrThrow({ where: { userId: bobUserId } })
    ).walletBalanceCents;
    expect(balanceAfterSweep).toBe(balanceAfterFund); // AUCUN débit malgré la recharge
  });

  it('C2 — rappel d\u2019impayé UNE seule fois (marqueur + audit), suspension au-delà du grâce, statut SEUL', async () => {
    const settings = await prisma.billingSetting.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const invBefore = await prisma.invoice.findUniqueOrThrow({ where: { orderId: bobRenewalId } });

    // Échéance déjà passée au-delà de la fenêtre de rappel (J-3 par défaut).
    await prisma.invoice.update({
      where: { id: invBefore.id },
      data: { dueDate: daysAgo(settings.dunningReminderDays + 2) },
    });
    const r1 = await sweep().expect(201);
    expect(r1.body.reminded).toBeGreaterThanOrEqual(1);
    const inv1 = await prisma.invoice.findUniqueOrThrow({ where: { id: invBefore.id } });
    expect(inv1.dunningRemindedAt).not.toBeNull();
    expect(
      await prisma.auditLog.findFirst({
        where: { action: 'billing.dunning_reminder', resourceId: invBefore.id },
      }),
    ).not.toBeNull();
    expect(
      mailTransportStub.sendMail.mock.calls.some((c) =>
        (c as unknown[]).some((a) =>
          String((a as { subject?: string } | undefined)?.subject ?? '').includes(inv1.number),
        ),
      ),
    ).toBe(true);

    // Idempotence du rappel.
    const r2 = await sweep().expect(201);
    expect(r2.body.reminded).toBe(0);

    // Au-delà du délai de grâce → suspension de la souscription (CAS, statut seul).
    await prisma.invoice.update({
      where: { id: invBefore.id },
      data: { dueDate: daysAgo(settings.dunningGraceDays + 1) },
    });
    const r3 = await sweep().expect(201);
    expect(r3.body.suspended).toBeGreaterThanOrEqual(1);
    const bobSub = await prisma.subscription.findFirstOrThrow({
      where: { userId: bobUserId },
      orderBy: { createdAt: 'desc' },
    });
    expect(bobSub.status).toBe(SubscriptionStatus.SUSPENDED);
    expect(
      await prisma.auditLog.findFirst({
        where: { action: 'subscription.auto_suspend', resourceId: bobSub.id },
      }),
    ).not.toBeNull();

    // §6-4 : la suspension est PUREMENT STATUTAIRE — ni allocation, ni statut
    // de provisioning, ni écriture d'infrastructure sur le renouvellement.
    const renewal = await prisma.order.findUniqueOrThrow({ where: { id: bobRenewalId } });
    expect(renewal.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(
      await prisma.deployment.count({ where: { orderId: bobRenewalId } }),
    ).toBe(0);
    expect(
      await prisma.orderStatusHistory.count({ where: { orderId: bobRenewalId, status: 'PROVISIONING' } }),
    ).toBe(0);
  });

  it('C3 — souscription suspendue → chaîne RÉSUMABLE : on n\u2019arrête jamais autoRenew', async () => {
    // L'admin peut réactiver plus tard : le chef de file garde son échéance.
    await makeDue(bobMotherId, daysAgo(1));
    const r = await sweep().expect(201);
    expect(r.body.created).toBe(0);
    expect(r.body.stopped).toBe(0);
    const mother = await prisma.order.findUniqueOrThrow({ where: { id: bobMotherId } });
    expect(mother.autoRenew).toBe(true); // intact
    expect(
      await prisma.order.count({ where: { renewsOrderId: bobMotherId } }),
    ).toBe(1); // toujours le seul
    expect(
      await prisma.auditLog.findFirst({
        where: { action: 'renewal.chain_stopped', resourceId: bobMotherId },
      }),
    ).toBeNull();
  });

  // ── D. Reprise de crash (débit committé, confirmation perdue) ─────────────
  it('D — crash entre débit et confirmation → reprise sans second débit', async () => {
    // Carol : aucun solde → son premier renouvellement reste PENDING.
    const res = await checkout(carolEmail, 'Carol P8', monthlySlug, carolToken).expect(201);
    carolMotherId = (res.body as { orderId: string }).orderId;
    orderIds.push(carolMotherId);
    await confirm(carolMotherId).expect(201);
    carolUserId = (await prisma.user.findUniqueOrThrow({ where: { email: carolEmail } })).id;
    carolCustomerId = (await prisma.customer.findUniqueOrThrow({ where: { userId: carolUserId } })).id;

    await makeDue(carolMotherId, daysAgo(1));
    const r1 = await sweep().expect(201);
    expect(r1.body).toMatchObject({ created: 1, paid: 0 });
    expect(r1.body.pending).toBeGreaterThanOrEqual(1);
    const renewal = await prisma.order.findUniqueOrThrow({
      where: { renewsOrderId: carolMotherId },
    });
    carolRenewalId = renewal.id;
    orderIds.push(carolRenewalId);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { orderId: carolRenewalId } });
    expect(inv.status).toBe(InvoiceStatus.UNPAID);

    // La cliente recharge ensuite (vrai parcours), puis le process CRASHE
    // APRÈS le débit et AVANT la confirmation : on appelle le vrai service de
    // débit sans jamais confirmer (clé idempotente exacte du scheduler).
    await fundWallet(carolToken, 50_000);
    await walletSvc.debit(carolCustomerId, {
      amountCents: inv.amountTtcCents,
      idempotencyKey: `renewal:${carolRenewalId}`,
      orderId: carolRenewalId,
      invoiceId: inv.id,
      note: 'Simulation crash : débit committé, confirmation perdue.',
    });
    const stillPending = await prisma.order.findUniqueOrThrow({ where: { id: carolRenewalId } });
    expect(stillPending.status).toBe(OrderStatus.PENDING_PAYMENT);

    // Reprise : le sweep RE-CONFIRME sur le débit existant, sans re-débiter.
    const r2 = await sweep().expect(201);
    expect(r2.body.paid).toBeGreaterThanOrEqual(1);
    const paid = await prisma.order.findUniqueOrThrow({ where: { id: carolRenewalId } });
    expect(paid.status).toBe(OrderStatus.ACTIVE);
    const invPaid = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(invPaid.status).toBe(InvoiceStatus.PAID);

    const debits = await prisma.walletTransaction.findMany({
      where: { orderId: carolRenewalId, type: 'DEBIT' },
    });
    expect(debits).toHaveLength(1); // JAMAIS deux fois
    const carol = await prisma.customer.findUniqueOrThrow({ where: { id: carolCustomerId } });
    expect(carol.walletBalanceCents).toBe(50_000 - inv.amountTtcCents);
  });

  // ── E. Expiration 48 h : le renouvellement est EXCLU ──────────────────────
  it('E — le sweep de reprise n\u2019annule JAMAIS un renouvellement périmé (dunning intact), si une commande standard si', async () => {
    // Le renouvellement impayé de Bob est « vieux » de 49 h.
    await prisma.order.update({
      where: { id: bobRenewalId },
      data: { createdAt: daysAgo(49) },
    });

    // Contraste : une commande STANDARD (sans renewsOrderId) du même âge.
    const stale = await prisma.order.create({
      data: {
        customerId: (await prisma.customer.findUniqueOrThrow({ where: { userId: aliceUserId } })).id,
        customerName: 'Stale P8',
        customerEmail: `p8stale_${stamp}@example.com`,
        productId: monthlyProductId,
        productName: `p8-monthly-${stamp}`,
        packId,
        status: OrderStatus.PENDING_PAYMENT,
        billingCycle: BillingCycle.MONTHLY,
        currency: 'USD',
        taxRatePercent: 0,
        amountHtCents: 5000,
        taxAmountCents: 0,
        amountTtcCents: 5000,
        paymentMethodId: virId,
        paymentMethodName: 'Virement bancaire',
        idempotencyKey: `p8-stale-${stamp}`,
        createdAt: daysAgo(49),
      },
    });
    staleOrderId = stale.id;
    orderIds.push(staleOrderId);

    // Empêche toute re-provisionation parallèle (panneau faux) : on ne teste
    // ici que l'expiration.
    await prisma.order.updateMany({
      where: { customerEmail: { in: [aliceEmail, bobEmail, carolEmail, `p8stale_${stamp}@example.com`] } },
      data: { updatedAt: new Date() },
    });

    await lifecycle.sweep();

    const renewal = await prisma.order.findUniqueOrThrow({ where: { id: bobRenewalId } });
    expect(renewal.status).toBe(OrderStatus.PENDING_PAYMENT); // EXCLU de l'expiration
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { orderId: bobRenewalId } });
    expect(inv.status).toBe(InvoiceStatus.UNPAID); // le dunning garde son droit

    const staleAfter = await prisma.order.findUniqueOrThrow({ where: { id: staleOrderId } });
    expect(staleAfter.status).toBe(OrderStatus.CANCELLED); // elle, oui
  });

  // ── F. RBAC du déclencheur ────────────────────────────────────────────────
  it('F — RBAC : 401 anonyme / 403 client / 200 admin sur renewal/sweep', async () => {
    await sweep('').expect(401);
    await sweep(bobToken).expect(403);
    const ok = await sweep(adminToken).expect(201);
    expect(ok.body).toHaveProperty('created');
    expect(ok.body).toHaveProperty('suspended');
  });
});
