import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import {
  InvoiceStatus,
  OrderStatus,
  PaymentMethodType,
  Role,
} from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { acceptanceFor, preloadAcceptance } from './pricing-acceptance.fixture';
import { PanelTransport, PanelTransportFactory } from './../src/servers/panel-transport.factory';
import { OrderLifecycleService } from './../src/store/order-lifecycle.service';

// Sweep à la tâche (timer) : OFF — le sweep est testé par appel DIRECT de
// `sweep()` (déterministe, aucune course avec les assertions de la suite).
process.env.ORDER_SWEEP_ENABLED = 'false';
// Parcours legacy ici (C3 hors sujet pour le paiement) + simulateur OFF par
// défaut : chaque test qui a besoin de l'activation la pose lui-même (restore).
delete process.env.HOSTING_C3_ENABLED;
delete process.env.PAYMENT_SIMULATOR_ENABLED;

/**
 * P2 — Confirmation de paiement (e2e) : la matrice « aucun droit avant
 * confirmation serveur » sur une base dédiée :
 *
 *  A. moyens de paiement publics (CARTe masquée sans simulateur) ;
 *  B. commande payante = PENDING_PAYMENT sans aucun droit ; confirmation ADMIN
 *     (RBAC 401/403/201, idempotence, facture, historique, audit) ;
 *  C. abonnement order-driven créé/upgradé UNIQUEMENT à la confirmation ;
 *  D. commande gratuite : confirmation immédiate, aucun mouvement de portefeuille,
 *     email d'accès envoyé ;
 *  E. simulateur de recette (refus sans activation, decline/timeout/success,
 *     refus en production, CARTe uniquement) ;
 *  F. idempotence (clé cliente : replay / conflit 409 / rejeu sans clé) ;
 *  G. reprise durable (expiration PENDING → CANCELLED + chaînage d'achat,
 *     relance d'une PAID figée) via `OrderLifecycleService.sweep()` direct.
 *
 * Coutures (AUCUN réseau réel) : MailTransportFactory (emails capturés),
 * PanelTransportFactory (jamais appelé : aucun produit avec méthode de
 * provisioning). PrismaService RÉEL — base dédiée du chantier.
 */
describe('Confirmation de paiement (e2e, P2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;
  let lifecycle: OrderLifecycleService;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const adminEmail = `p2admin_${stamp}@example.com`;
  const memberEmail = `p2member_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let memberToken = '';
  let memberUserId = '';

  let cardId = '';
  let virId = '';
  let packId = '';
  let paidSlug = '';
  let pack1Slug = '';
  let pack2Slug = '';
  let freeSlug = '';

  const allOrderIds: string[] = [];
  const guestEmails: string[] = [];
  let createdMailId: string | null = null;

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };
  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({}) as PanelTransport,
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
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Timeout (30s) waiting for ${label} — last=${JSON.stringify(last) ?? String(last)}`);
  }

  function checkoutBody(over: Record<string, unknown>, email: string = memberEmail) {
    const productSlug = String(over.productSlug ?? '');
    const paymentMethodId = (over.paymentMethodId as string | undefined) ?? virId;
    return {
      productSlug,
      paymentMethodId,
      name: 'Client P2',
      email,
      // P7 : preuve d'acceptation tarifaire obligatoire (préchargée ; absente
      // si combinaison inconnue → 409 explicite si le chemin est payant).
      ...(acceptanceFor(productSlug, paymentMethodId) ?? {}),
      ...over,
    };
  }

  function placeOrder(body: Record<string, unknown>, token?: string): request.Test {
    const req = request(app.getHttpServer()).post(`/${GlobalPrefix}/store/checkout`).send(body);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  /** Confirmation ADMIN du règlement. */
  function confirmOrder(
    orderId: string,
    token?: string,
  ): request.Test {
    const req = request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/orders/${orderId}/confirm-payment`)
      .send({ reference: 'RECETTE-P2' });
    req.set('Authorization', `Bearer ${token ?? adminToken}`);
    return req;
  }

  function simulate(orderId: string, outcome: string): request.Test {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/orders/${orderId}/simulate-payment`)
      .send({ outcome });
  }

  function mailSubjects(): string[] {
    return mailTransportStub.sendMail.mock.calls.map(
      (c: unknown[]) => ((c[0] as { subject?: string } | undefined)?.subject ?? ''),
    );
  }

  /** Texte du premier email dont le sujet commence par `prefix`. */
  function mailText(prefix: string): string {
    const call = mailTransportStub.sendMail.mock.calls.find((c: unknown[]) =>
      String((c[0] as { subject?: string } | undefined)?.subject ?? '').startsWith(prefix),
    );
    return String((call?.[0] as { text?: string } | undefined)?.text ?? '');
  }

  /** Commande directe (bypass checkout) pour la reprise — PAID « confirmée ». */
  async function seedPaidOrder(tag: string): Promise<string> {
    const order = await prisma.order.create({
      data: {
        customerId: (await prisma.customer.findUniqueOrThrow({ where: { userId: memberUserId } })).id,
        customerName: 'Membre P2',
        customerEmail: memberEmail,
        productId: (await prisma.product.findUniqueOrThrow({ where: { slug: paidSlug } })).id,
        productName: `p2-paid-${stamp}`,
        status: OrderStatus.PAID,
        amountHtCents: 1500,
        taxAmountCents: 0,
        amountTtcCents: 1500,
        paymentMethodId: virId,
        paymentMethodName: `VIR-${stamp}`,
        idempotencyKey: `seed-${tag}-${stamp}`,
        idempotencyBase: `seed-${tag}-${stamp}`,
      },
    });
    allOrderIds.push(order.id);
    return order.id;
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
    lifecycle = moduleRef.get(OrderLifecycleService);
    limiter.reset();

    await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Admin P2',
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
      },
    });
    await prisma.user.create({
      data: {
        email: memberEmail,
        name: 'Membre P2',
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.USER,
      },
    });
    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;
    memberToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: memberEmail, password })
        .expect(201)
    ).body.accessToken as string;
    expect(adminToken).toBeTruthy();
    expect(memberToken).toBeTruthy();
    memberUserId = (
      await prisma.user.findUniqueOrThrow({ where: { email: memberEmail } })
    ).id;

    const card = await prisma.paymentMethod.create({
      data: { name: `CB-${stamp}`, type: PaymentMethodType.CARD, isActive: true },
    });
    cardId = card.id;
    const vir = await prisma.paymentMethod.create({
      data: { name: `VIR-${stamp}`, type: PaymentMethodType.BANK_TRANSFER, isActive: true },
    });
    virId = vir.id;

    const pack = await prisma.hostingPack.create({
      data: { name: `pack-p2-${stamp}`, ramMb: 512, cpuCores: 1, maxApps: 5 },
    });
    packId = pack.id;

    const mk = async (slug: string, price: number, withPack: boolean): Promise<string> => {
      const p = await prisma.product.create({
        data: {
          name: `${slug}-${stamp}`,
          slug,
          status: 'ACTIVE',
          hidden: false,
          priceHtCents: price,
          ...(withPack ? { packId } : {}),
        },
      });
      return p.slug!;
    };
    paidSlug = await mk(`p2-paid-${stamp}`, 1500, false);
    pack1Slug = await mk(`p2-pack-${stamp}`, 2500, true);
    pack2Slug = await mk(`p2-pack2-${stamp}`, 3500, true);
    freeSlug = await mk(`p2-free-${stamp}`, 0, false);

    // P7 : preuves d'acceptation pour les 4 produits × VIR, + payant × CARTe.
    for (const s of [paidSlug, pack1Slug, pack2Slug, freeSlug]) {
      await preloadAcceptance(app.getHttpServer(), s, virId);
    }
    await preloadAcceptance(app.getHttpServer(), paidSlug, cardId);

    // Config mail minimale (host + fromEmail requis par getMailConfig) : le
    // transport est stubbé, aucun SMTP n'est jamais contacté. Snapshot/restore.
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
  });

  beforeEach(() => {
    limiter.reset();
    mailTransportStub.sendMail.mockClear();
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    delete process.env.PENDING_PAYMENT_TTL_HOURS;
  });

  afterAll(async () => {
    const orderIds = [...allOrderIds];
    await prisma.walletTransaction
      .deleteMany({ where: { orderId: { in: orderIds } } })
      .catch(() => {});
    await prisma.subscription
      .deleteMany({ where: { user: { email: { in: [memberEmail] } } } })
      .catch(() => {});
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await prisma.customer
      .deleteMany({ where: { email: { in: [...guestEmails, memberEmail] } } })
      .catch(() => {});
    await prisma.user
      .deleteMany({ where: { email: { in: [...guestEmails, memberEmail, adminEmail] } } })
      .catch(() => {});
    await prisma.product
      .deleteMany({ where: { slug: { in: [paidSlug, pack1Slug, pack2Slug, freeSlug] } } })
      .catch(() => {});
    await prisma.hostingPack.deleteMany({ where: { id: packId } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: { in: [cardId, virId] } } }).catch(() => {});
    if (createdMailId) {
      await prisma.mailSetting.delete({ where: { id: createdMailId } }).catch(() => {});
    }
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    delete process.env.PENDING_PAYMENT_TTL_HOURS;
    delete process.env.ORDER_SWEEP_ENABLED;
    await app.close();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // A — Moyens de paiement publics (CARTe honnête)
  // ═══════════════════════════════════════════════════════════════════════
  describe('A — moyens de paiement publics', () => {
    it('A1 — sans simulateur : la CARTe est MASQUÉE, le virement visible', async () => {
      const res = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/payment-methods`)
        .expect(200);
      const types = (res.body as { type: string }[]).map((m) => m.type);
      expect(types).not.toContain(PaymentMethodType.CARD);
      expect(types).toContain(PaymentMethodType.BANK_TRANSFER);
      // Jamais de secrets : configEnc absent de la vue publique.
      expect(JSON.stringify(res.body)).not.toContain('configEnc');
    });

    it('A2 — checkout CARTe sans simulateur → 400 honnête (aucun prestataire)', async () => {
      const email = `guest-a2-${stamp}@example.com`;
      guestEmails.push(email);
      const res = await placeOrder(
        checkoutBody({ productSlug: paidSlug, email, paymentMethodId: cardId }),
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('pas encore disponible');
      expect(await prisma.order.count({ where: { customerEmail: email } })).toBe(0);
    });

    it('A3 — simulateur activé : la CARTe réapparaît dans la liste publique', async () => {
      process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
      try {
        const res = await request(app.getHttpServer())
          .get(`/${GlobalPrefix}/store/payment-methods`)
          .expect(200);
        const types = (res.body as { type: string }[]).map((m) => m.type);
        expect(types).toContain(PaymentMethodType.CARD);
      } finally {
        delete process.env.PAYMENT_SIMULATOR_ENABLED;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // B — Commande payante sans droits + confirmation ADMIN
  // ═══════════════════════════════════════════════════════════════════════
  describe('B — payant sans droits, confirmation ADMIN', () => {
    let bOrderId = '';
    const bEmail = `guest-b1-${stamp}@example.com`;

    it('B1 — checkout virement → PENDING_PAYMENT, facture UNPAID, AUCUN droit', async () => {
      guestEmails.push(bEmail);
      const res = await placeOrder(
        checkoutBody({ productSlug: paidSlug, email: bEmail }),
      ).expect(201);
      bOrderId = res.body.orderId as string;
      allOrderIds.push(bOrderId);
      expect(res.body.nextStep).toBe('payment-pending');
      expect(res.body.invoiceNumber).toBeTruthy();

      const order = await prisma.order.findUniqueOrThrow({ where: { id: bOrderId } });
      expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(order.paidAt).toBeNull();
      expect(order.idempotencyBase).toBeTruthy();
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId: bOrderId } });
      expect(invoice.status).toBe(InvoiceStatus.UNPAID);
      const hist = await prisma.orderStatusHistory.findFirst({
        where: { orderId: bOrderId, status: OrderStatus.PENDING_PAYMENT },
      });
      expect(hist?.note).toContain('règlement en attente');
      // Compte invité créé (le compte n'est PAS un règlement).
      const guest = await prisma.user.findUnique({ where: { email: bEmail } });
      expect(guest).toBeTruthy();
      expect(guest!.passwordHash).toBeTruthy();
      // Email « en attente » envoyé dans la foulée : aucune promesse d'activation.
      expect(mailSubjects().some((s) => s.startsWith('Commande en attente de règlement'))).toBe(
        true,
      );
      expect(mailText('Commande en attente de règlement')).toContain(
        'n’est pas encore confirmé',
      );
      expect(mailSubjects().some((s) => s.startsWith('Vos accès'))).toBe(false);
    });

    it('B3 — RBAC : anonyme 401, USER 403 sur la confirmation', async () => {
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/orders/${bOrderId}/confirm-payment`)
        .send({})
        .expect(401);
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/orders/${bOrderId}/confirm-payment`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({})
        .expect(403);
      // Aucun côté-effect des tentatives refusées.
      const order = await prisma.order.findUniqueOrThrow({ where: { id: bOrderId } });
      expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(order.paidAt).toBeNull();
    });

    it('B4 — confirmation ADMIN → PAID + facture + historique + audit', async () => {
      const res = await confirmOrder(bOrderId).expect(201);
      expect(res.body.status).toBe(OrderStatus.PAID);
      expect(res.body.alreadyConfirmed).toBe(false);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: bOrderId } });
      expect(order.paidAt).toBeTruthy();
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId: bOrderId } });
      expect(invoice.status).toBe(InvoiceStatus.PAID);
      expect(invoice.paidAt).toBeTruthy();
      const hist = await prisma.orderStatusHistory.findFirst({
        where: { orderId: bOrderId, status: OrderStatus.PAID },
      });
      expect(hist?.note).toContain('validé par l’administration');
      expect(hist?.note).toContain('RECETTE-P2');
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'payment.confirmed', resourceId: bOrderId },
      });
      expect(audit).toBeTruthy();
      expect(JSON.stringify(audit!.details)).toContain('admin-transfer');
      expect(JSON.stringify(audit!.details)).toContain('RECETTE-P2');

      // Aucune méthode de provisioning configurée → ACTIVE déterministe.
      await waitFor(
        `order ${bOrderId} ACTIVE`,
        () => prisma.order.findUnique({ where: { id: bOrderId } }),
        (o) => o?.status === OrderStatus.ACTIVE,
      );
      // Email de confirmation (sans mot de passe — compte déjà connu côté invité).
      expect(mailSubjects().some((s) => s.startsWith('Vos accès Code Diali'))).toBe(true);
    });

    it('B5 — re-confirmation → alreadyConfirmed, AUCUNE réécriture', async () => {
      const beforeHist = await prisma.orderStatusHistory.count({
        where: { orderId: bOrderId, status: OrderStatus.PAID },
      });
      const beforeOrder = await prisma.order.findUniqueOrThrow({ where: { id: bOrderId } });
      const res = await confirmOrder(bOrderId).expect(201);
      expect(res.body.alreadyConfirmed).toBe(true);
      const afterHist = await prisma.orderStatusHistory.count({
        where: { orderId: bOrderId, status: OrderStatus.PAID },
      });
      expect(afterHist).toBe(beforeHist);
      const afterOrder = await prisma.order.findUniqueOrThrow({ where: { id: bOrderId } });
      expect(afterOrder.paidAt?.getTime()).toBe(beforeOrder.paidAt?.getTime());
    });

    it('B6 — commande inconnue → 404', async () => {
      const res = await confirmOrder('cm0000000000000000000000000').expect(404);
      expect(res.body.message).toContain('introuvable');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // C — Abonnement order-driven : créé/upgradé UNIQUEMENT à la confirmation
  // ═══════════════════════════════════════════════════════════════════════
  describe('C — abonnement pack (membre)', () => {
    let c1OrderId = '';
    let c3OrderId = '';

    it('C1 — checkout pack → AUCUN abonnement avant confirmation', async () => {
      const res = await placeOrder(
        checkoutBody({ productSlug: pack1Slug }),
        memberToken,
      ).expect(201);
      c1OrderId = res.body.orderId as string;
      allOrderIds.push(c1OrderId);
      expect(res.body.nextStep).toBe('payment-pending');
      expect(
        await prisma.subscription.count({ where: { userId: memberUserId } }),
      ).toBe(0);
    });

    it('C2 — confirmation → abonnement ACTIF créé + provisionné (ACTIVE)', async () => {
      const res = await confirmOrder(c1OrderId).expect(201);
      expect(res.body.subscriptionAction).toBe('created');

      const sub = await prisma.subscription.findFirstOrThrow({
        where: { userId: memberUserId },
      });
      expect(sub.status).toBe('ACTIVE');
      expect(sub.orderId).toBe(c1OrderId);
      const product1 = await prisma.product.findUniqueOrThrow({ where: { slug: pack1Slug } });
      expect(sub.productId).toBe(product1.id);

      await waitFor(
        `order ${c1OrderId} ACTIVE`,
        () => prisma.order.findUnique({ where: { id: c1OrderId } }),
        (o) => o?.status === OrderStatus.ACTIVE,
      );
    });

    it('C3 — upgrade pack2 : MÊME ligne d’abonnement mise à jour, pas de 2e ligne', async () => {
      const res = await placeOrder(
        checkoutBody({ productSlug: pack2Slug }),
        memberToken,
      ).expect(201);
      c3OrderId = res.body.orderId as string;
      allOrderIds.push(c3OrderId);
      expect(res.body.nextStep).toBe('payment-pending');
      expect(await prisma.subscription.count({ where: { userId: memberUserId } })).toBe(1);

      const conf = await confirmOrder(c3OrderId).expect(201);
      expect(conf.body.subscriptionAction).toBe('upgraded');
      expect(await prisma.subscription.count({ where: { userId: memberUserId } })).toBe(1);
      const sub = await prisma.subscription.findFirstOrThrow({
        where: { userId: memberUserId },
      });
      const product2 = await prisma.product.findUniqueOrThrow({ where: { slug: pack2Slug } });
      expect(sub.productId).toBe(product2.id);
      expect(sub.orderId).toBe(c3OrderId);

      // Upgrade sans sous-domaine : aucun lancement de provisioning → PAID stable.
      const order = await prisma.order.findUniqueOrThrow({ where: { id: c3OrderId } });
      expect(order.status).toBe(OrderStatus.PAID);
      expect(order.paidAt).toBeTruthy();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // D — Commande gratuite : règle explicite, aucun encaissement fabriqué
  // ═══════════════════════════════════════════════════════════════════════
  describe('D — commande gratuite (invité)', () => {
    it('D1 — total 0 → confirmation immédiate + accès envoyés + 0 mouvement wallet', async () => {
      const email = `guest-d1-${stamp}@example.com`;
      guestEmails.push(email);
      const res = await placeOrder(
        checkoutBody({ productSlug: freeSlug, email }),
      ).expect(201);
      const orderId = res.body.orderId as string;
      allOrderIds.push(orderId);
      expect(res.body.nextStep).toBe('provisioning-pending');

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.paidAt).toBeTruthy();
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId } });
      expect(invoice.status).toBe(InvoiceStatus.PAID);
      expect(invoice.amountTtcCents).toBe(0);

      const customer = await prisma.customer.findUniqueOrThrow({ where: { email } });
      const wallet = await prisma.walletTransaction.count({
        where: { customerId: customer.id },
      });
      expect(wallet).toBe(0);

      // Email d'accès complet (identifiants invité) — aucune attente de règlement.
      expect(mailSubjects().some((s) => s.startsWith('Vos accès Code Diali'))).toBe(true);
      expect(mailText('Vos accès Code Diali')).toContain('Mot de passe temporaire');

      await waitFor(
        `order ${orderId} ACTIVE`,
        () => prisma.order.findUnique({ where: { id: orderId } }),
        (o) => o?.status === OrderStatus.ACTIVE,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E — Simulateur de paiement (recette) : refus sans activation, puis 3 issues
  // ═══════════════════════════════════════════════════════════════════════
  describe('E — simulateur de paiement', () => {
    let virOrderId = '';

    it('E1 — simulateur SANS activation → 400 explicite', async () => {
      const res = await simulate('cm0000000000000000000000000', 'success');
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Simulateur de paiement désactivé');
    });

    it('E2 — activation : refus sur commande NON-CARTe (virement)', async () => {
      process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
      try {
        const email = `guest-e2-${stamp}@example.com`;
        guestEmails.push(email);
        const res = await placeOrder(
          checkoutBody({ productSlug: paidSlug, email }),
        ).expect(201);
        virOrderId = res.body.orderId as string;
        allOrderIds.push(virOrderId);

        const sim = await simulate(virOrderId, 'success');
        expect(sim.status).toBe(400);
        expect(sim.body.message).toContain('CARTe');
        const order = await prisma.order.findUniqueOrThrow({ where: { id: virOrderId } });
        expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
        expect(order.paidAt).toBeNull();
      } finally {
        delete process.env.PAYMENT_SIMULATOR_ENABLED;
      }
    });

    let declineOrderId = '';
    let timeoutOrderId = '';
    let successOrderId = '';

    it('E3 — checkout CARTe avec simulateur → PENDING (puis decline/timeout/success)', async () => {
      process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
      try {
        const mk = async (tag: string): Promise<string> => {
          const email = `guest-e3-${tag}-${stamp}@example.com`;
          guestEmails.push(email);
          const res = await placeOrder(
            checkoutBody({ productSlug: paidSlug, email, paymentMethodId: cardId }),
          ).expect(201);
          allOrderIds.push(res.body.orderId as string);
          expect(res.body.nextStep).toBe('payment-pending');
          return res.body.orderId as string;
        };
        declineOrderId = await mk('dec');
        timeoutOrderId = await mk('tmo');
        successOrderId = await mk('ok');
      } finally {
        delete process.env.PAYMENT_SIMULATOR_ENABLED;
      }
    });

    it('E4 — decline → refus honnête, commande TOUTE CELLE qui reste en attente', async () => {
      process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
      try {
        const res = await simulate(declineOrderId, 'decline').expect(201);
        expect(res.body.outcome).toBe('decline');
        expect(res.body.status).toBe(OrderStatus.PENDING_PAYMENT);
        const order = await prisma.order.findUniqueOrThrow({ where: { id: declineOrderId } });
        expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
        expect(order.paidAt).toBeNull();
        const hist = await prisma.orderStatusHistory.findFirst({
          where: { orderId: declineOrderId },
          orderBy: { createdAt: 'desc' },
        });
        expect(hist?.note).toContain('Paiement refusé (simulateur)');
        const audit = await prisma.auditLog.findFirst({
          where: { action: 'payment.simulate_decline', resourceId: declineOrderId },
        });
        expect(audit).toBeTruthy();
      } finally {
        delete process.env.PAYMENT_SIMULATOR_ENABLED;
      }
    });

    it('E5 — timeout → résultat INCERTAIN : protections conservées, AUCUN droit', async () => {
      process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
      try {
        const res = await simulate(timeoutOrderId, 'timeout').expect(201);
        expect(res.body.outcome).toBe('timeout');
        expect(res.body.status).toBe(OrderStatus.PENDING_PAYMENT);
        const order = await prisma.order.findUniqueOrThrow({ where: { id: timeoutOrderId } });
        expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
        expect(order.paidAt).toBeNull();
        const hist = await prisma.orderStatusHistory.findFirst({
          where: { orderId: timeoutOrderId },
          orderBy: { createdAt: 'desc' },
        });
        expect(hist?.note).toContain('Délai dépassé (simulateur)');
      } finally {
        delete process.env.PAYMENT_SIMULATOR_ENABLED;
      }
    });

    it('E6 — success → MÊME confirmation serveur que tout règlement, puis idempotent', async () => {
      process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
      try {
        const res = await simulate(successOrderId, 'success').expect(201);
        expect(res.body.outcome).toBe('confirmed');
        expect(res.body.status).toBe(OrderStatus.PAID);
        const order = await prisma.order.findUniqueOrThrow({ where: { id: successOrderId } });
        expect(order.paidAt).toBeTruthy();
        const audit = await prisma.auditLog.findFirst({
          where: { action: 'payment.confirmed', resourceId: successOrderId },
        });
        expect(JSON.stringify(audit!.details)).toContain('card-simulator');

        const again = await simulate(successOrderId, 'success').expect(201);
        expect(again.body.outcome).toBe('already-confirmed');

        await waitFor(
          `order ${successOrderId} ACTIVE`,
          () => prisma.order.findUnique({ where: { id: successOrderId } }),
          (o) => o?.status === OrderStatus.ACTIVE,
        );
      } finally {
        delete process.env.PAYMENT_SIMULATOR_ENABLED;
      }
    });

    it('E7 — outcome inconnu → 400 (validation stricte)', async () => {
      process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
      try {
        const res = await simulate(virOrderId, 'refund');
        expect(res.status).toBe(400);
      } finally {
        delete process.env.PAYMENT_SIMULATOR_ENABLED;
      }
    });

    it('E8 — TOUJOURS refusé en production, même avec l’env posée', async () => {
      process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
      const priorNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const res = await simulate(virOrderId, 'success');
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('Simulateur de paiement désactivé');
        const order = await prisma.order.findUniqueOrThrow({ where: { id: virOrderId } });
        expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
      } finally {
        process.env.NODE_ENV = priorNodeEnv;
        delete process.env.PAYMENT_SIMULATOR_ENABLED;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // F — Idempotence (clé cliente + rejeu d’intention)
  // ═══════════════════════════════════════════════════════════════════════
  describe('F — idempotence', () => {
    const fEmail = `guest-f-${stamp}@example.com`;

    it('F1 — même clé + contenu identique → MÊME commande, un seul compte', async () => {
      guestEmails.push(fEmail);
      const body = checkoutBody({ productSlug: paidSlug, email: fEmail });
      const first = await placeOrder(body).set('Idempotency-Key', 'f1-key').expect(201);
      allOrderIds.push(first.body.orderId as string);
      const second = await placeOrder(body).set('Idempotency-Key', 'f1-key').expect(201);
      expect(second.body.orderId).toBe(first.body.orderId);
      expect(await prisma.user.count({ where: { email: fEmail } })).toBe(1);
      expect(await prisma.order.count({ where: { customerEmail: fEmail } })).toBe(1);
    });

    it('F2 — même clé + contenu DIFFÉRENT → conflit 409, aucune écriture', async () => {
      const before = await prisma.order.count({});
      const res = await placeOrder(
        checkoutBody({ productSlug: paidSlug, email: `other-${fEmail}` }),
      ).set('Idempotency-Key', 'f1-key');
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('contenu différent');
      expect(await prisma.order.count({})).toBe(before);
      expect(await prisma.user.count({ where: { email: `other-${fEmail}` } })).toBe(0);
    });

    it('F3 — sans clé, deux soumissions identiques → rejeu (même commande)', async () => {
      const email = `guest-f3-${stamp}@example.com`;
      guestEmails.push(email);
      const body = checkoutBody({ productSlug: paidSlug, email });
      const first = await placeOrder(body).expect(201);
      allOrderIds.push(first.body.orderId as string);
      const second = await placeOrder(body).expect(201);
      expect(second.body.orderId).toBe(first.body.orderId);
      expect(await prisma.order.count({ where: { customerEmail: email } })).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // G — Reprise durable (OrderLifecycleService.sweep())
  // ═══════════════════════════════════════════════════════════════════════
  describe('G — sweep de reprise', () => {
    it('G1 — PENDING trop vielle → CANCELLED tracée, confirmation refusée, reachat chaîné', async () => {
      const res = await placeOrder(
        checkoutBody({ productSlug: paidSlug }),
        memberToken,
      ).expect(201);
      const orderId = res.body.orderId as string;
      allOrderIds.push(orderId);
      const firstOrder = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

      // Commande « vieille » : createdAt backdaté + TTL écrasé POUR l’appel.
      await prisma.order.update({
        where: { id: orderId },
        data: { createdAt: new Date(Date.now() - 120_000) },
      });
      process.env.PENDING_PAYMENT_TTL_HOURS = '0.001'; // 3,6 s
      let sweepResult: { expired: number; relaunched: number } = { expired: 0, relaunched: 0 };
      try {
        sweepResult = await lifecycle.sweep();
      } finally {
        delete process.env.PENDING_PAYMENT_TTL_HOURS;
      }
      expect(sweepResult.expired).toBeGreaterThanOrEqual(1);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.CANCELLED);
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId } });
      expect(invoice.status).toBe(InvoiceStatus.CANCELLED);
      const hist = await prisma.orderStatusHistory.findFirst({
        where: { orderId, status: OrderStatus.CANCELLED },
      });
      expect(hist?.note).toContain('Expiré');
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'order.expired', resourceId: orderId },
      });
      expect(audit).toBeTruthy();

      // Confirmation interdite sur commande annulée (aucun droit rétroactif).
      const conf = await confirmOrder(orderId);
      expect(conf.status).toBe(409);

      // NOUVEL achat (même intention) : nouvelle commande, clé chaînée, les
      // anciennes clés ne sont JAMAIS supprimées.
      const again = await placeOrder(
        checkoutBody({ productSlug: paidSlug }),
        memberToken,
      ).expect(201);
      allOrderIds.push(again.body.orderId as string);
      expect(again.body.orderId).not.toBe(orderId);
      const oldRow = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const newRow = await prisma.order.findUniqueOrThrow({
        where: { id: again.body.orderId as string },
      });
      expect(oldRow.idempotencyKey).toBe(firstOrder.idempotencyKey);
      expect(newRow.idempotencyKey).not.toBe(firstOrder.idempotencyKey);
      expect(newRow.status).toBe(OrderStatus.PENDING_PAYMENT);
      // Le rejeu de l’ancienne clé reste honnête (annulée → nouvel achat).
      expect(
        await prisma.order.count({ where: { idempotencyKey: firstOrder.idempotencyKey! } }),
      ).toBe(1);
    });

    it('G2 — PAID figée > 2 min → relance du provisioning (idempotent)', async () => {
      const orderId = await seedPaidOrder('stuck');
      await prisma.order.update({
        where: { id: orderId },
        data: { updatedAt: new Date(Date.now() - 180_000) },
      });
      const before = await lifecycle.sweep();
      expect(before.relaunched).toBeGreaterThanOrEqual(1);
      await waitFor(
        `order ${orderId} ACTIVE`,
        () => prisma.order.findUnique({ where: { id: orderId } }),
        (o) => o?.status === OrderStatus.ACTIVE,
      );
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'order.relaunch_provisioning', resourceId: orderId },
      });
      expect(audit).toBeTruthy();
      // Relance à l’état déjà complet → no-op (aucune double séquence).
      const again = await lifecycle.sweep();
      expect(again.relaunched).toBe(0);
      expect(
        await prisma.provisioningLog.count({ where: { orderId } }),
      ).toBe(0);
    });
  });
});
