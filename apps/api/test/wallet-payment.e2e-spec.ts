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
  WalletTransactionType,
  WalletTxStatus,
} from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import {
  PanelTransport,
  PanelTransportFactory,
} from './../src/servers/panel-transport.factory';
import { CheckoutService } from '../src/store/checkout.service';

// Sweeps (timers) OFF : aucune exécution fantôme pendant les assertions.
process.env.ORDER_SWEEP_ENABLED = 'false';
process.env.RENEWAL_SWEEP_ENABLED = 'false';

/**
 * Q-A (GO item 1+2+4) — Règlement par SOLDE portefeuille (e2e) :
 *
 *  A. Solde insuffisant / anonyme → 409/401 honnêtes, AUCUNE écriture
 *     (0 débit, commande PENDING, facture UNPAID, solde inchangé) ;
 *  B. Solde suffisant → UNE transaction : 1 débit exact `wallet-pay:<id>` +
 *     commande réglée + facture PAID, solde diminué d'un montant exact ;
 *  C. Double-clic CONCURRENT → les deux réponses 201 (l'une rejeu),
 *     exactement UN seul débit ;
 *  D. Rejeu séquentiel → 201 `replayed:true`, solde et débits inchangés ;
 *  D2. Rejeu d'INTENTION au checkout : même contenu (avec ou sans clé
 *      client) → la MÊME commande, aucun second effet ;
 *  E. Commande annulée avant règlement → 409, aucun débit ;
 *  F. Échec AVANT commit (confirm échoue dans la tx) → rollback total :
 *     solde inchangé, 0 débit, commande PENDING, audit `payment.confirm_failed` ;
 *  G. Échec APRÈS commit (effets post-commit qui lèvent) → réponses 201 quand
 *     même : l'état committé est la vérité, jamais de re-crédit ni d'erreur
 *     retour après commit ;
 *  H. Débit legacy NON compensé déjà présent → confirmation SEULE (jamais un
 *     2e débit pour le même règlement, clé `wallet-pay` absente) ;
 *  I. Devise ≠ USD → 409 explicite (portefeuille USD uniquement) ;
 *  J. Propriété stricte : 401 anonyme / 404 autre compte (jamais 403) ;
 *  K. Facture : règlement par facture (201 + mêmes effets), autre compte 404,
 *     facture déjà réglée 409, facture sans commande 409 ;
 *  M. Clé client : rejeu même clé (séquentiel + concours) → même commande ;
 *     contenu DIVERGENT sous la même clé → 409 explicite ;
 *  L. Consentement renouvellement (item 4) : sans case → `autoRenew=false` ;
 *     PATCH armement = consentement DATÉ + échéance ; révocation CAS
 *     immédiate ; ONETIME → 409 ; autre compte → 404.
 *
 * Aucun réseau réel : MailTransportFactory + PanelTransportFactory stubbés,
 * PrismaService RÉEL sur la base dédiée (icode_host_pro_socle). Les fonds
 * passent par le vrai parcours recharge + validation admin.
 */
describe('Règlement par solde portefeuille (e2e, Q-A)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;
  let checkoutSvc: CheckoutService;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const adminEmail = `waadmin_${stamp}@example.com`;
  const aliceEmail = `waalice_${stamp}@example.com`;
  const bobEmail = `wabob_${stamp}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let aliceToken = '';
  let bobToken = '';

  // Fixtures.
  let packId = '';
  let monthlyProductId = '';
  let monthlySlug = '';
  let onetimeProductId = '';
  let onetimeSlug = '';
  /** Moyens « virement » : UN par scénario = intention d'achat distincte (§7). */
  const virIds: string[] = [];
  let createdMailId: string | null = null;
  const orderIds: string[] = [];

  // Scénario.
  let aliceUserId = '';
  let aliceCustomerId = '';
  let bobUserId = '';
  let orderB = ''; // commande réglée du scénario B
  let orderC = ''; // commande réglée (concurrence) du scénario C
  let orderJ = // commande restée PENDING du scénario J (réglée en K)
    '';
  let methodOfB = ''; // moyen utilisé par B (rejeu d'intention en D2/M)

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

  /**
   * Checkout (commande PENDING). Consentement sauf test « sans case ».
   *
   * §7 : sans variation de contenu, tout checkout identique REJOUE la même
   * intention (même commande). Chaque scénario a besoin d'une VRAIE commande
   * neuve → contenu distinct via son propre moyen de paiement (le moyen entre
   * dans le hash d'intention). Les tests de REJEU explicites (D2/M) passent
   * par `opts.methodId` (même contenu) et/ou `opts.clientKey` (clé client).
   */
  let checkoutSeq = 0;
  let lastUsedMethodId = '';
  function checkout(
    email: string,
    name: string,
    productSlug: string,
    token: string,
    renewalConsent = true,
    opts?: { methodId?: string; clientKey?: string },
  ) {
    const methodId = opts?.methodId ?? virIds[checkoutSeq++];
    lastUsedMethodId = methodId;
    const req = request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/checkout`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productSlug, name, email, paymentMethodId: methodId, renewalConsent });
    if (opts?.clientKey) req.set('Idempotency-Key', opts.clientKey);
    return req;
  }

  function confirm(orderId: string, token = adminToken) {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/orders/${orderId}/confirm-payment`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reference: `WA-RECETTE-${stamp}` });
  }

  function pay(orderId: string, token: string) {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/orders/${orderId}/pay-with-wallet`)
      .set('Authorization', `Bearer ${token}`);
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

  const debitsOf = (orderId: string) =>
    prisma.walletTransaction.findMany({
      where: { orderId, type: WalletTransactionType.DEBIT },
    });

  const balanceOf = async (customerId: string) =>
    (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } }))
      .walletBalanceCents;

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
    checkoutSvc = app.get(CheckoutService);
    limiter.reset();

    const mkUser = async (email: string, role: Role, name: string) => {
      await prisma.user.create({
        data: { email, name, passwordHash: await bcrypt.hash(password, 10), role },
      });
    };
    await mkUser(adminEmail, Role.ADMIN, 'Admin WA');
    await mkUser(aliceEmail, Role.USER, 'Alice WA');
    await mkUser(bobEmail, Role.USER, 'Bob WA');
    adminToken = await login(adminEmail);
    aliceToken = await login(aliceEmail);
    bobToken = await login(bobEmail);

    const users = await prisma.user.findMany({
      where: { email: { in: [aliceEmail, bobEmail] } },
      select: { id: true, email: true },
    });
    aliceUserId = users.find((u) => u.email === aliceEmail)!.id;
    bobUserId = users.find((u) => u.email === bobEmail)!.id;

    const pack = await prisma.hostingPack.create({
      data: { name: `wa-pack-${stamp}`, ramMb: 512 },
    });
    packId = pack.id;

    const monthly = await prisma.product.create({
      data: {
        name: `wa-monthly-${stamp}`,
        slug: `wa-monthly-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 5000,
        billingCycle: BillingCycle.MONTHLY,
        packId,
      },
    });
    monthlyProductId = monthly.id;
    monthlySlug = monthly.slug!;

    const onetime = await prisma.product.create({
      data: {
        name: `wa-onetime-${stamp}`,
        slug: `wa-onetime-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 1000,
        billingCycle: BillingCycle.ONETIME,
      },
    });
    onetimeProductId = onetime.id;
    onetimeSlug = onetime.slug!;

    // Un moyen de paiement par scénario : contenu d'intention distinct (§7).
    for (let i = 0; i < 16; i += 1) {
      const m = await prisma.paymentMethod.create({
        data: {
          name: `VIR-WA-${stamp}-${i}`,
          type: PaymentMethodType.BANK_TRANSFER,
          isActive: true,
        },
      });
      virIds.push(m.id);
    }

    const priorMail = await prisma.mailSetting.findFirst();
    if (!priorMail || !priorMail.host || !priorMail.fromEmail) {
      createdMailId = (
        await prisma.mailSetting.create({
          data: {
            host: 'smtp.test.local',
            fromEmail: `noreply-${stamp}@test.local`,
            fromName: 'Code Diali WA',
          },
        })
      ).id;
    }
    // Le dossier client d'Alice n'existe qu'APRÈS son premier checkout
    // (création paresseuse) : `aliceCustomerId` est fixé au test A.
  });

  beforeEach(() => {
    limiter.reset();
  });

  afterAll(async () => {
    try {
      const customers = await prisma.customer.findMany({
        where: { email: { in: [aliceEmail, bobEmail] } },
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

    const allEmails = [adminEmail, aliceEmail, bobEmail];
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
      .deleteMany({
        where: {
          customerId: {
            in: (await prisma.customer.findMany({
              where: { email: { in: allEmails } },
              select: { id: true },
            })).map((c) => c.id),
          },
        },
      })
      .catch(() => {});
    await prisma.invoice.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.subscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { email: { in: allEmails } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: allEmails } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { id: { in: [monthlyProductId, onetimeProductId] } } }).catch(() => {});
    await prisma.hostingPack.deleteMany({ where: { id: packId } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: { in: virIds } } }).catch(() => {});
    if (createdMailId) {
      await prisma.mailSetting.delete({ where: { id: createdMailId } }).catch(() => {});
    }
    await app?.close();
  });

  // ── A. Solde insuffisant / anonyme → rien n'écrit ─────────────────────────
  it('A — 401 anonyme ; solde insuffisant → 409 sans AUCUNE écriture', async () => {
    const res = await checkout(aliceEmail, 'Alice WA', monthlySlug, aliceToken).expect(201);
    const orderId = res.body.orderId as string;
    orderIds.push(orderId);

    await pay(orderId, '').expect(401);

    const r = await pay(orderId, aliceToken).expect(409);
    expect(String(r.body.message)).toContain('Solde insuffisant');
    // `ensureOwnedCustomer` (appelé avant le règlement) a rattaché le dossier.
    aliceCustomerId = (
      await prisma.customer.findFirstOrThrow({
        where: { userId: aliceUserId },
        select: { id: true },
      })
    ).id;

    expect(await debitsOf(orderId)).toHaveLength(0);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order.paidAt).toBeNull();
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId } });
    expect(invoice.status).toBe(InvoiceStatus.UNPAID);
    expect(await balanceOf(aliceCustomerId)).toBe(0);
  });

  // ── B. Solde suffisant → atomique, montant exact ──────────────────────────
  it('B — solde suffisant → 1 débit exact wallet-pay + commande réglée + facture PAID', async () => {
    await fundWallet(aliceToken, 20_000);
    expect(await balanceOf(aliceCustomerId)).toBe(20_000);

    const res = await checkout(aliceEmail, 'Alice WA', monthlySlug, aliceToken).expect(201);
    const orderId = res.body.orderId as string;
    orderIds.push(orderId);
    orderB = orderId;
    methodOfB = lastUsedMethodId;
    const orderBefore = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(orderBefore.amountTtcCents).toBe(5000);

    const r = await pay(orderId, aliceToken).expect(201);
    expect(r.body).toMatchObject({ orderId, status: 'PAID', replayed: false });
    expect(r.body.balanceCents).toBe(15_000);

    const debits = await debitsOf(orderId);
    expect(debits).toHaveLength(1);
    expect(debits[0].idempotencyKey).toBe(`wallet-pay:${orderId}`);
    expect(debits[0].amountCents).toBe(5000);
    expect(debits[0].status).toBe(WalletTxStatus.SUCCEEDED);
    expect(await balanceOf(aliceCustomerId)).toBe(15_000);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paidAt).not.toBeNull();
    expect(order.status).not.toBe(OrderStatus.PENDING_PAYMENT);
    expect(order.status).not.toBe(OrderStatus.CANCELLED);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId } });
    expect(invoice.status).toBe(InvoiceStatus.PAID);
    expect(invoice.paidAt).not.toBeNull();

    // Un abonnement mensuel consenti est bien créé (au même instant, tx).
    const sub = await prisma.subscription.findFirst({ where: { orderId } });
    expect(sub).not.toBeNull();
    expect(sub!.status).toBe('ACTIVE');
  });

  // ── C. Double-clic concurrent ─────────────────────────────────────────────
  it('C — double-clic CONCURRENT → deux 201 (l\u2019un rejeu), UN seul débit', async () => {
    const res = await checkout(aliceEmail, 'Alice WA', monthlySlug, aliceToken).expect(201);
    const orderId = res.body.orderId as string;
    orderIds.push(orderId);
    orderC = orderId;

    const [a, b] = await Promise.all([
      pay(orderId, aliceToken),
      pay(orderId, aliceToken),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(
      [a.body.replayed, b.body.replayed].filter((x: boolean) => x === false),
    ).toHaveLength(1);

    const debits = await debitsOf(orderId);
    expect(debits).toHaveLength(1);
    expect(debits[0].idempotencyKey).toBe(`wallet-pay:${orderId}`);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).not.toBe(OrderStatus.PENDING_PAYMENT);
    const balance = await balanceOf(aliceCustomerId);
    expect(balance).toBe(15_000 - 5000);
  });

  // ── D. Rejeu séquentiel (retry client) ────────────────────────────────────
  it('D — rejeu séquentiel → 201 replayed:true, solde et débits inchangés', async () => {
    // La commande de C est déjà réglée : un retry ne doit rien répéter.
    const before = await balanceOf(aliceCustomerId);

    const r = await pay(orderC, aliceToken).expect(201);
    expect(r.body).toMatchObject({ replayed: true, alreadyConfirmed: true });
    expect(await balanceOf(aliceCustomerId)).toBe(before);
    expect(await debitsOf(orderC)).toHaveLength(1);
  });

  // ── D2. Rejeu d'INTENTION au checkout (même contenu, même clé) ────────────
  it('D2 — même contenu au checkout → la MÊME commande (rejeu §7 honnête)', async () => {
    // Sans clé client : dernière commande de Même intention → replay.
    const same = await checkout(
      aliceEmail,
      'Alice WA',
      monthlySlug,
      aliceToken,
      true,
      { methodId: methodOfB },
    ).expect(201);
    expect(same.body.orderId).toBe(orderB);

    // Avec clé client JAMAIS vue + contenu identique → rejeu honnête de
    // l'intention existante (jamais un refus au message trompeur, jamais de
    // seconde commande fantôme).
    const withKey = await checkout(
      aliceEmail,
      'Alice WA',
      monthlySlug,
      aliceToken,
      true,
      { methodId: methodOfB, clientKey: `${stamp}-replay` },
    ).expect(201);
    expect(withKey.body.orderId).toBe(orderB);

    // La commande réglée n'a subi AUCUN second effet.
    expect(await debitsOf(orderB)).toHaveLength(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderB } });
    expect(order.status).not.toBe(OrderStatus.PENDING_PAYMENT);
  });

  // ── E. Commande annulée avant règlement ───────────────────────────────────
  it('E — commande CANCELLED → 409, aucun débit', async () => {
    const res = await checkout(aliceEmail, 'Alice WA', monthlySlug, aliceToken).expect(201);
    const orderId = res.body.orderId as string;
    orderIds.push(orderId);
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED },
    });

    const r = await pay(orderId, aliceToken).expect(409);
    expect(String(r.body.message)).toContain('CANCELLED');
    expect(await debitsOf(orderId)).toHaveLength(0);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId } });
    expect(invoice.status).toBe(InvoiceStatus.UNPAID);
  });

  // ── F. Échec AVANT commit → rollback total ────────────────────────────────
  it('F — confirm échoue DANS la tx → rollback total (0 débit, solde intact, PENDING)', async () => {
    const res = await checkout(aliceEmail, 'Alice WA', monthlySlug, aliceToken).expect(201);
    const orderId = res.body.orderId as string;
    orderIds.push(orderId);
    const balanceBefore = await balanceOf(aliceCustomerId);
    expect(balanceBefore).toBeGreaterThanOrEqual(5000);

    const svc = checkoutSvc as unknown as {
      confirmOrderInTx: (...args: unknown[]) => Promise<unknown>;
    };
    const spy = jest.spyOn(svc, 'confirmOrderInTx').mockRejectedValueOnce(
      new ConflictException('Boom simulé avant commit.'),
    );
    try {
      const r = await pay(orderId, aliceToken).expect(409);
      expect(String(r.body.message)).toContain('Boom simulé');
    } finally {
      spy.mockRestore();
    }

    expect(await debitsOf(orderId)).toHaveLength(0); // le débit a ROLLBACK
    expect(await balanceOf(aliceCustomerId)).toBe(balanceBefore);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order.paidAt).toBeNull();
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId } });
    expect(invoice.status).toBe(InvoiceStatus.UNPAID);
    const failed = await prisma.auditLog.findFirst({
      where: { action: 'payment.confirm_failed', resourceId: orderId },
    });
    expect(failed).not.toBeNull();
  });

  // ── G. Échec APRÈS commit → jamais d'erreur retour ────────────────────────
  it('G — effets post-commit qui lèvent → 201 quand même, état committé intact', async () => {
    const res = await checkout(aliceEmail, 'Alice WA', monthlySlug, aliceToken).expect(201);
    const orderId = res.body.orderId as string;
    orderIds.push(orderId);
    const balanceBefore = await balanceOf(aliceCustomerId);

    const svc = checkoutSvc as unknown as {
      postConfirmEffects: (...args: unknown[]) => Promise<void>;
    };
    const spy = jest.spyOn(svc, 'postConfirmEffects').mockRejectedValueOnce(
      new Error('mail/panneau en panne après commit'),
    );
    try {
      const r = await pay(orderId, aliceToken).expect(201);
      expect(r.body.status).toBe('PAID');
      expect(r.body.replayed).toBe(false);
    } finally {
      spy.mockRestore();
    }

    // L'état committé est la vérité : débit + règlement présents, pas de
    // re-crédit compensatoire.
    const debits = await debitsOf(orderId);
    expect(debits).toHaveLength(1);
    expect(debits[0].idempotencyKey).toBe(`wallet-pay:${orderId}`);
    expect(await balanceOf(aliceCustomerId)).toBe(balanceBefore - 5000);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).not.toBe(OrderStatus.PENDING_PAYMENT);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId } });
    expect(invoice.status).toBe(InvoiceStatus.PAID);
  });

  // ── H. Débit legacy non compensé → confirmation seule ─────────────────────
  it('H — débit legacy NON compensé présent → confirmation SANS 2e débit', async () => {
    const res = await checkout(aliceEmail, 'Alice WA', monthlySlug, aliceToken).expect(201);
    const orderId = res.body.orderId as string;
    orderIds.push(orderId);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const balanceBefore = await balanceOf(aliceCustomerId);

    // Bug ancien reproduit : débit abouti SANS confirmation atomique (clé
    // historique, hors schéma wallet-pay), compensation absente.
    await prisma.walletTransaction.create({
      data: {
        customerId: aliceCustomerId,
        type: WalletTransactionType.DEBIT,
        amountCents: order.amountTtcCents,
        currency: 'USD',
        status: WalletTxStatus.SUCCEEDED,
        idempotencyKey: `legacy-split:${orderId}`,
        orderId,
        note: 'Simulation du split legacy (débit sans confirmation).',
      },
    });

    const r = await pay(orderId, aliceToken).expect(201);
    expect(r.body.status).toBe('PAID');

    const debits = await debitsOf(orderId);
    expect(debits).toHaveLength(1); // JAMAIS deux fois le même règlement
    expect(debits[0].idempotencyKey).toBe(`legacy-split:${orderId}`);
    // Aucun débit frais : la clé wallet-pay n'existe pas pour cette commande.
    expect(
      await prisma.walletTransaction.findUnique({
        where: { idempotencyKey: `wallet-pay:${orderId}` },
      }),
    ).toBeNull();
    expect(await balanceOf(aliceCustomerId)).toBe(balanceBefore);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId } });
    expect(invoice.status).toBe(InvoiceStatus.PAID);
  });

  // ── I. Devise ≠ USD → refus explicite ─────────────────────────────────────
  it('I — commande en EUR → 409 (portefeuille USD uniquement)', async () => {
    const eur = await prisma.order.create({
      data: {
        customerId: aliceCustomerId,
        customerName: 'Alice WA',
        customerEmail: `waeur_${stamp}@example.com`,
        productId: monthlyProductId,
        productName: `wa-monthly-${stamp}`,
        packId,
        status: OrderStatus.PENDING_PAYMENT,
        billingCycle: BillingCycle.MONTHLY,
        currency: 'EUR',
        taxRatePercent: 0,
        amountHtCents: 5000,
        taxAmountCents: 0,
        amountTtcCents: 5000,
        paymentMethodId: virIds[0],
        paymentMethodName: 'Virement bancaire',
        idempotencyKey: `wa-eur-${stamp}`,
      },
    });
    orderIds.push(eur.id);

    const r = await pay(eur.id, aliceToken).expect(409);
    expect(String(r.body.message)).toContain('EUR');
    expect(await debitsOf(eur.id)).toHaveLength(0);
  });

  // ── J. Propriété stricte ──────────────────────────────────────────────────
  it('J — autre compte sur ma commande → 404 (jamais 403, aucune fuite)', async () => {
    const res = await checkout(aliceEmail, 'Alice WA', monthlySlug, aliceToken).expect(201);
    const orderId = res.body.orderId as string;
    orderIds.push(orderId);
    orderJ = orderId;

    await pay(orderId, bobToken).expect(404);
    await pay(orderId, '').expect(401);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(await debitsOf(orderId)).toHaveLength(0);
  });

  // ── K. Règlement par facture ──────────────────────────────────────────────
  it('K — facture : 201 (mêmes effets) / autre compte 404 / déjà réglée 409 / sans commande 409', async () => {
    // (a) La commande « J » reste PENDING : réglée via sa facture.
    const order = await prisma.order.findFirstOrThrow({
      where: { id: orderJ, status: OrderStatus.PENDING_PAYMENT },
      select: { id: true, amountTtcCents: true },
    });
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId: order.id } });
    const balanceBefore = await balanceOf(aliceCustomerId);
    expect(balanceBefore).toBeGreaterThanOrEqual(order.amountTtcCents);

    const r = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/invoices/${invoice.id}/pay-with-wallet`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(201);
    expect(r.body.orderId).toBe(order.id);
    expect(await balanceOf(aliceCustomerId)).toBe(balanceBefore - order.amountTtcCents);
    expect(await debitsOf(order.id)).toHaveLength(1);
    const invoicePaid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(invoicePaid.status).toBe(InvoiceStatus.PAID);

    // (b) Facture DÉJÀ réglée → 409 honnête (l'anti-doublon vit au niveau
    //     facture ; le rejeu propre du RÈGLEMENT est couvert par le test D).
    const again = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/invoices/${invoice.id}/pay-with-wallet`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(409);
    expect(String(again.body.message)).toContain('PAID');
    expect(await debitsOf(order.id)).toHaveLength(1);

    // (c) Facture d'un AUTRE compte → 404.
    const bobRes = await checkout(bobEmail, 'Bob WA', monthlySlug, bobToken).expect(201);
    orderIds.push(bobRes.body.orderId as string);
    const bobInvoice = await prisma.invoice.findUniqueOrThrow({
      where: { orderId: bobRes.body.orderId as string },
    });
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/invoices/${bobInvoice.id}/pay-with-wallet`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(404);

    // (d) Facture sans commande (ad hoc admin) → 409 honnête.
    const adhoc = await prisma.invoice.create({
      data: {
        number: `WA-ADHOC-${stamp}`,
        customerId: aliceCustomerId,
        amountHtCents: 1000,
        taxAmountCents: 0,
        amountTtcCents: 1000,
      },
    });
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/invoices/${adhoc.id}/pay-with-wallet`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(409);
    await prisma.invoice.delete({ where: { id: adhoc.id } }).catch(() => {});
  });

  // ── M. Clé client : rejeu même clé + concurrence + contenu divergent ──────
  it('M — clé client : rejeu (séquentiel + concours) et contenu divergent → 409', async () => {
    const key = `${stamp}-m-key`;
    const methodM = virIds[checkoutSeq++];

    // (a) Séquentiel : même clé + même contenu → la MÊME commande.
    const m1 = await checkout(aliceEmail, 'Alice WA', monthlySlug, aliceToken, true, {
      methodId: methodM,
      clientKey: key,
    }).expect(201);
    orderIds.push(m1.body.orderId as string);
    const m2 = await checkout(aliceEmail, 'Alice WA', monthlySlug, aliceToken, true, {
      methodId: methodM,
      clientKey: key,
    }).expect(201);
    expect(m2.body.orderId).toBe(m1.body.orderId);

    // (b) Concours : double-clic checkout avec UNE même clé → deux 201 sur la
    //     même commande (création sérialisée, rejeu pour le perdant).
    const key2 = `${stamp}-m-key2`;
    const methodK = virIds[checkoutSeq++];
    const [c1, c2] = await Promise.all([
      checkout(aliceEmail, 'Alice WA', monthlySlug, aliceToken, true, {
        methodId: methodK,
        clientKey: key2,
      }),
      checkout(aliceEmail, 'Alice WA', monthlySlug, aliceToken, true, {
        methodId: methodK,
        clientKey: key2,
      }),
    ]);
    expect(c1.status).toBe(201);
    expect(c2.status).toBe(201);
    expect(c1.body.orderId).toBe(c2.body.orderId);
    orderIds.push(c1.body.orderId as string);

    // (c) Contenu DIVERGENT sous la même clé → 409 explicite (jamais de
    //     création silencieuse avec une intention étrangère).
    const div = await checkout(aliceEmail, 'Alice WA', monthlySlug, aliceToken, true, {
      methodId: methodOfB,
      clientKey: key,
    }).expect(409);
    expect(String(div.body.message)).toContain('contenu différent');

    // Aucune commande fantôme : une seule pour la clé (a), une pour (b).
    expect(
      await prisma.order.count({ where: { clientKey: key } }),
    ).toBe(1);
    expect(
      await prisma.order.count({ where: { clientKey: key2 } }),
    ).toBe(1);
  });

  // ── L. Consentement renouvellement : armement + révocation ────────────────
  it('L — sans case : autoRenew=false ; PATCH arme (consentement daté) puis RÉVOQUE', async () => {
    // (a) Checkout SANS consentement → confirm admin → aucun prélèvement armé.
    const res = await checkout(
      aliceEmail,
      'Alice WA',
      monthlySlug,
      aliceToken,
      false,
    ).expect(201);
    const orderId = res.body.orderId as string;
    orderIds.push(orderId);
    await confirm(orderId).expect(201);

    let order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.autoRenew).toBe(false);
    expect(order.renewalConsentAt).toBeNull();
    expect(order.nextBillingDate).toBeNull();

    // (b) Armement par le propriétaire : consentement daté + échéance.
    const on = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/client/orders/${orderId}/renewal`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ enabled: true })
      .expect(200);
    expect(on.body.autoRenew).toBe(true);
    expect(on.body.renewalConsentAt).not.toBeNull();
    expect(on.body.nextBillingDate).not.toBeNull();
    order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.autoRenew).toBe(true);
    const toggleAudit = await prisma.auditLog.findFirst({
      where: { action: 'subscription.renewal_toggled', resourceId: orderId },
    });
    expect(toggleAudit).not.toBeNull();

    // (c) Révocation immédiate (CAS) — le consentement HISTORIQUE reste daté.
    const off = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/client/orders/${orderId}/renewal`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ enabled: false })
      .expect(200);
    expect(off.body.autoRenew).toBe(false);
    expect(off.body.renewalConsentAt).not.toBeNull();
    order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.autoRenew).toBe(false);

    // (d) ONETIME → 409 (aucun abonnement à gérer).
    const ot = await checkout(aliceEmail, 'Alice WA', onetimeSlug, aliceToken).expect(201);
    orderIds.push(ot.body.orderId as string);
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/client/orders/${ot.body.orderId as string}/renewal`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ enabled: true })
      .expect(409);

    // (e) Autre compte → 404 (propriété stricte).
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/client/orders/${orderId}/renewal`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ enabled: true })
      .expect(404);
  });
});
