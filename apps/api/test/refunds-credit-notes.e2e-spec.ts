import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import {
  InvoiceStatus,
  OrderStatus,
  PaymentMethodType,
  RefundKind,
  RefundStatus,
  Role,
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

// Sweep à la tâche (timer) : OFF — les commandes sont seedées PAID/PENDING et
// aucun test ne dépend d'une reprise automatique.
process.env.ORDER_SWEEP_ENABLED = 'false';
delete process.env.HOSTING_C3_ENABLED;
delete process.env.PAYMENT_SIMULATOR_ENABLED;

/**
 * GO Q9 (e2e) — Remboursements et avoirs du périmètre, sur base dédiée :
 *
 *  A. crédit partiel jusqu'au plafond exact (encaissé = 1500) ;
 *  B. rejeu idempotent : même clé + même intention = AUCUN second effet ;
 *  C. même clé + intention différente = 409, aucune écriture ;
 *  D. plafond : tout dépassement = 409 explicite ;
 *  E. concurrence : 20 remboursements parallèles → 15 OK / 5 rejets,
 *     delta wallet EXACT ; même clé ×2 en parallèle → 1 seule écriture ;
 *  F. externe (carte réelle désactivée) : reste PENDING, confirmation
 *     prestataire = refus 409 tracé, AUCUN succès externe déclaré, et
 *     l'opération INTERNE reste disponible malgré l'adaptateur bloqué ;
 *  G. avoirs : AV- liés (creditNoteOfId), statuts sur cumul complet, PDF ;
 *  H. RBAC : anonyme 401, USER 403, ADMIN 201 (routes refunds) ;
 *  I. commande non encaissée = 409 ; inconnue = 404.
 *
 * Coutures (AUCUN réseau réel) : MailTransportFactory + PanelTransportFactory
 * stubbés. PrismaService RÉEL — base dédiée du chantier.
 */
describe('Remboursements et avoirs (e2e, GO Q9)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const adminEmail = `q9admin_${stamp}@example.com`;
  const memberEmail = `q9member_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let memberToken = '';

  let virId = '';
  let productId = '';
  let memberCustomerId = '';

  const allOrderIds: string[] = [];
  const allSeededInvoiceIds: string[] = [];

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };
  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({}) as PanelTransport,
  } as unknown as PanelTransportFactory;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function refundBody(
    over: Record<string, unknown>,
  ): Record<string, unknown> {
    return { kind: RefundKind.WALLET_CREDIT, ...over };
  }

  function postRefund(
    orderId: string,
    body: Record<string, unknown>,
    key?: string,
    token?: string,
  ): request.Test {
    const req = request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/orders/${orderId}/refunds`)
      .send(body);
    req.set('Authorization', `Bearer ${token ?? adminToken}`);
    if (key) req.set('Idempotency-Key', key);
    return req;
  }

  async function balanceOf(): Promise<number> {
    const c = await prisma.customer.findUnique({
      where: { id: memberCustomerId },
    });
    return c?.walletBalanceCents ?? -1;
  }

  /** Seed d'une commande encaissée (PAID + paidAt) avec sa facture réglée. */
  async function seedPaidOrder(
    tag: string,
    opts: { rate?: number } = {},
  ): Promise<{ orderId: string; invoiceId: string }> {
    const rate = opts.rate ?? 15;
    const order = await prisma.order.create({
      data: {
        customerId: memberCustomerId,
        customerName: 'Membre Q9',
        customerEmail: memberEmail,
        productId,
        productName: `q9-${tag}-${stamp}`,
        status: OrderStatus.PAID,
        paidAt: new Date(),
        amountHtCents: 1304,
        taxAmountCents: 196,
        amountTtcCents: 1500,
        taxRatePercent: rate,
        paymentMethodId: virId,
        paymentMethodName: `VIR-${stamp}`,
        idempotencyKey: `q9-seed-${tag}-${stamp}`,
        idempotencyBase: `q9-seed-${tag}-${stamp}`,
      },
    });
    allOrderIds.push(order.id);
    const invoice = await prisma.invoice.create({
      data: {
        number: `Q9-${stamp}-${allSeededInvoiceIds.length + 1}`,
        orderId: order.id,
        customerId: memberCustomerId,
        status: InvoiceStatus.PAID,
        currency: 'USD',
        taxRatePercent: rate,
        amountHtCents: 1304,
        taxAmountCents: 196,
        amountTtcCents: 1500,
        paidAt: new Date(),
      },
    });
    allSeededInvoiceIds.push(invoice.id);
    return { orderId: order.id, invoiceId: invoice.id };
  }

  /** Commande JAMAIS encaissée (paidAt null) pour le refus d'accès. */
  async function seedPendingOrder(): Promise<string> {
    const order = await prisma.order.create({
      data: {
        customerId: memberCustomerId,
        customerName: 'Membre Q9',
        customerEmail: memberEmail,
        productId,
        productName: `q9-pending-${stamp}`,
        status: OrderStatus.PENDING_PAYMENT,
        amountHtCents: 1304,
        taxAmountCents: 196,
        amountTtcCents: 1500,
        taxRatePercent: 15,
        paymentMethodId: virId,
        paymentMethodName: `VIR-${stamp}`,
        idempotencyKey: `q9-seed-pending-${stamp}`,
        idempotencyBase: `q9-seed-pending-${stamp}`,
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
    limiter.reset();

    await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Admin Q9',
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
      },
    });
    const member = await prisma.user.create({
      data: {
        email: memberEmail,
        name: 'Membre Q9',
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

    const customer = await prisma.customer.upsert({
      where: { userId: member.id },
      update: {},
      create: { userId: member.id, email: memberEmail, name: 'Membre Q9' },
    });
    memberCustomerId = customer.id;

    virId = (
      await prisma.paymentMethod.create({
        data: {
          name: `Q9-VIR-${stamp}`,
          type: PaymentMethodType.BANK_TRANSFER,
          isActive: true,
        },
      })
    ).id;
    productId = (
      await prisma.product.create({
        data: {
          name: `q9-paid-${stamp}`,
          slug: `q9-paid-${stamp}`,
          status: 'ACTIVE',
          hidden: false,
          priceHtCents: 1500,
        },
      })
    ).id;
  });

  beforeEach(() => limiter.reset());

  afterAll(async () => {
    const orderIds = [...allOrderIds];
    const seededInvoices = [...allSeededInvoiceIds];
    const notes = await prisma.invoice
      .findMany({
        where: { creditNoteOfId: { in: seededInvoices } },
        select: { id: true },
      })
      .catch(() => []);
    await prisma.refund
      .deleteMany({ where: { orderId: { in: orderIds } } })
      .catch(() => {});
    await prisma.orderStatusHistory
      .deleteMany({ where: { orderId: { in: orderIds } } })
      .catch(() => {});
    await prisma.walletTransaction
      .deleteMany({
        where: {
          OR: [
            { orderId: { in: orderIds } },
            { customerId: memberCustomerId },
          ],
        },
      })
      .catch(() => {});
    await prisma.invoice
      .deleteMany({
        where: {
          id: { in: [...seededInvoices, ...notes.map((n) => n.id)] },
        },
      })
      .catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await prisma.customer
      .deleteMany({ where: { id: memberCustomerId } })
      .catch(() => {});
    await prisma.user
      .deleteMany({ where: { email: { in: [adminEmail, memberEmail] } } })
      .catch(() => {});
    await prisma.product.deleteMany({ where: { id: productId } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: virId } }).catch(() => {});
    delete process.env.ORDER_SWEEP_ENABLED;
    await app.close();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // A — Crédit partiel jusqu'au plafond exact
  // ═══════════════════════════════════════════════════════════════════════
  describe('A — plafond exact et effets internes', () => {
    let aOrderId = '';
    let aInvoiceId = '';
    const keyA1 = `q9-a1-${stamp}`;
    const keyA2 = `q9-a2-${stamp}`;

    it('A0 — seed : commande encaissée 1500, wallet à 0', async () => {
      const seeded = await seedPaidOrder('a');
      aOrderId = seeded.orderId;
      aInvoiceId = seeded.invoiceId;
      expect(await balanceOf()).toBe(0);
    });

    it('A1 — crédit 1000 : SUCCEEDED, wallet +1000 (type REFUND), statuts conservés', async () => {
      const res = await postRefund(
        aOrderId,
        refundBody({ amountCents: 1000, reason: 'Annulation partielle' }),
        keyA1,
      ).expect(201);
      expect(res.body.status).toBe(RefundStatus.SUCCEEDED);
      expect(res.body.kind).toBe(RefundKind.WALLET_CREDIT);
      expect(res.body.replayed).toBe(false);
      expect(res.body.walletTransactionId).toBeTruthy();
      expect(res.body.creditNoteInvoiceId).toBeNull();

      expect(await balanceOf()).toBe(1000);
      const wtx = await prisma.walletTransaction.findUniqueOrThrow({
        where: { id: res.body.walletTransactionId as string },
      });
      expect(wtx.type).toBe('REFUND');
      expect(wtx.idempotencyKey).toBe(`refund:${keyA1}`);
      expect(wtx.amountCents).toBe(1000);

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: aOrderId },
      });
      expect(order.status).toBe(OrderStatus.PAID); // pas encore complet
      const invoice = await prisma.invoice.findUniqueOrThrow({
        where: { id: aInvoiceId },
      });
      expect(invoice.status).toBe(InvoiceStatus.PAID);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'refund.succeeded' },
      });
      expect(audit).toBeTruthy();
    });

    it('D1 — dépassement du plafond (1000+600 > 1500) : 409, aucune écriture', async () => {
      const before = await prisma.refund.count({ where: { orderId: aOrderId } });
      const res = await postRefund(
        aOrderId,
        refundBody({ amountCents: 600 }),
        `q9-d1-${stamp}`,
      );
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('Plafond');
      expect(await prisma.refund.count({ where: { orderId: aOrderId } })).toBe(
        before,
      );
      expect(await balanceOf()).toBe(1000);
    });

    it('A2 — crédit 500 (cumul EXACT = encaissé) : commande + facture REFUNDED, wallet +1500', async () => {
      const res = await postRefund(
        aOrderId,
        refundBody({ amountCents: 500, reason: 'Solde' }),
        keyA2,
      ).expect(201);
      expect(res.body.status).toBe(RefundStatus.SUCCEEDED);
      expect(await balanceOf()).toBe(1500);

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: aOrderId },
      });
      expect(order.status).toBe(OrderStatus.REFUNDED);
      const invoice = await prisma.invoice.findUniqueOrThrow({
        where: { id: aInvoiceId },
      });
      expect(invoice.status).toBe(InvoiceStatus.REFUNDED);
    });

    it('B1 — rejeu même clé + même intention : 201 replayed, AUCUN second effet', async () => {
      const rowsBefore = await prisma.refund.count({
        where: { orderId: aOrderId },
      });
      const balanceBefore = await balanceOf();

      const res = await postRefund(
        aOrderId,
        refundBody({ amountCents: 1000, reason: 'Annulation partielle' }),
        keyA1,
      ).expect(201);
      expect(res.body.replayed).toBe(true);
      expect(res.body.status).toBe(RefundStatus.SUCCEEDED);

      expect(await balanceOf()).toBe(balanceBefore);
      expect(await prisma.refund.count({ where: { orderId: aOrderId } })).toBe(
        rowsBefore,
      );
      const extraWallet = await prisma.walletTransaction.count({
        where: { idempotencyKey: `refund:${keyA1}` },
      });
      expect(extraWallet).toBe(1);
    });

    it('C1 — même clé + intention DIFFÉRENTE : 409, aucune écriture', async () => {
      const rowsBefore = await prisma.refund.count({
        where: { orderId: aOrderId },
      });
      const res = await postRefund(
        aOrderId,
        refundBody({ amountCents: 999, reason: 'Annulation partielle' }),
        keyA1,
      );
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('déjà utilisée');
      expect(await prisma.refund.count({ where: { orderId: aOrderId } })).toBe(
        rowsBefore,
      );
      expect(await balanceOf()).toBe(1500);
    });

    it('D2 — cumul complet : TOUT nouvel essai = 409 plafond', async () => {
      const res = await postRefund(
        aOrderId,
        refundBody({ amountCents: 1 }),
        `q9-d2-${stamp}`,
      );
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('Plafond');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // E — Concurrence réelle (20 requêtes parallèles + même clé ×2)
  // ═══════════════════════════════════════════════════════════════════════
  describe('E — concurrence', () => {
    let eOrderId = '';
    let eInvoiceId = '';

    it('E1 — 20 × 100c parallèles sur 1500c : exactement 15 OK / 5 rejets, delta wallet EXACT', async () => {
      const seeded = await seedPaidOrder('e');
      eOrderId = seeded.orderId;
      eInvoiceId = seeded.invoiceId;
      const balanceBefore = await balanceOf();

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          postRefund(
            eOrderId,
            refundBody({ amountCents: 100, reason: `par-${i}` }),
            `q9-e${i}-${stamp}`,
          ),
        ),
      );
      const ok = results.filter((r) => r.status === 201);
      const conflicts = results.filter((r) => r.status === 409);
      expect(ok).toHaveLength(15);
      expect(conflicts).toHaveLength(5);
      for (const c of conflicts) {
        expect(c.body.message).toContain('Plafond');
      }

      expect(await balanceOf()).toBe(balanceBefore + 1500);
      expect(
        await prisma.refund.count({
          where: { orderId: eOrderId, status: RefundStatus.SUCCEEDED },
        }),
      ).toBe(15);

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: eOrderId },
      });
      expect(order.status).toBe(OrderStatus.REFUNDED);
      const invoice = await prisma.invoice.findUniqueOrThrow({
        where: { id: eInvoiceId },
      });
      expect(invoice.status).toBe(InvoiceStatus.REFUNDED);
    });

    it('E2 — même clé ×2 EN PARALLÈLE : UNE seule écriture, wallet crédité une fois', async () => {
      const seeded = await seedPaidOrder('k');
      const balanceBefore = await balanceOf();
      const key = `q9-k1-${stamp}`;
      const body = refundBody({ amountCents: 200, reason: 'double-clic' });

      const [r1, r2] = await Promise.all([
        postRefund(seeded.orderId, body, key),
        postRefund(seeded.orderId, body, key),
      ]);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect([r1.body.replayed, r2.body.replayed].sort()).toEqual([
        false,
        true,
      ]);

      expect(await balanceOf()).toBe(balanceBefore + 200);
      expect(
        await prisma.refund.count({ where: { orderId: seeded.orderId } }),
      ).toBe(1);
      expect(
        await prisma.walletTransaction.count({
          where: { idempotencyKey: `refund:${key}` },
        }),
      ).toBe(1);
    });

    it('E3 — même clé sur une AUTRE commande en parallèle : 409 (clé globale), zéro écriture', async () => {
      const seeded = await seedPaidOrder('k2');
      const balanceBefore = await balanceOf();
      const res = await postRefund(
        seeded.orderId,
        refundBody({ amountCents: 200, reason: 'double-clic' }),
        `q9-k1-${stamp}`,
      );
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('déjà utilisée');
      expect(await balanceOf()).toBe(balanceBefore);
      expect(
        await prisma.refund.count({ where: { orderId: seeded.orderId } }),
      ).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // F — Externe : carte réelle désactivée, jamais de succès sans réelle
  //     confirmation prestataire ; l'interne reste INDÉPENDANT
  // ═══════════════════════════════════════════════════════════════════════
  describe('F — remboursement externe (adaptateur non configuré)', () => {
    let fOrderId = '';
    let fInvoiceId = '';
    let fRefundId = '';
    const keyF1 = `q9-f1-${stamp}`;

    it('F1 — EXTERNAL_CARD : 201 PENDING, wallet INCHANGÉ, aucun providerRef', async () => {
      const seeded = await seedPaidOrder('f');
      fOrderId = seeded.orderId;
      fInvoiceId = seeded.invoiceId;
      const balanceBefore = await balanceOf();

      const res = await postRefund(
        fOrderId,
        refundBody({ amountCents: 1000, kind: RefundKind.EXTERNAL_CARD }),
        keyF1,
      ).expect(201);
      fRefundId = res.body.id as string;
      expect(res.body.status).toBe(RefundStatus.PENDING);
      expect(res.body.providerRef).toBeNull();
      expect(res.body.walletTransactionId).toBeNull();

      expect(await balanceOf()).toBe(balanceBefore); // AUCUN effet interne
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: fOrderId },
      });
      expect(order.status).toBe(OrderStatus.PAID); // encaissement intact
      const invoice = await prisma.invoice.findUniqueOrThrow({
        where: { id: fInvoiceId },
      });
      expect(invoice.status).toBe(InvoiceStatus.PAID);
    });

    it('F2 — provider-confirmation : refus 409 tracé, la ligne RESTE PENDING', async () => {
      const res = await request(app.getHttpServer())
        .post(
          `/${GlobalPrefix}/store/admin/refunds/${fRefundId}/provider-confirmation`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('confirmation RÉELLE');

      const row = await prisma.refund.findUniqueOrThrow({
        where: { id: fRefundId },
      });
      expect(row.status).toBe(RefundStatus.PENDING); // jamais auto-succès
      expect(row.providerRef).toBeNull();

      const audit = await prisma.auditLog.findFirst({
        where: {
          action: 'refund.provider_confirmation_refused',
          resourceId: fRefundId,
        },
      });
      expect(audit).toBeTruthy();
    });

    it('F3 — journal + détail : list/detail exposent la ligne PENDING, inconnu = 404', async () => {
      const list = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/orders/${fOrderId}/refunds`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].id).toBe(fRefundId);
      expect(list.body[0].status).toBe(RefundStatus.PENDING);

      const detail = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/refunds/${fRefundId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(detail.body.kind).toBe(RefundKind.EXTERNAL_CARD);

      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/refunds/cm0000000000000000000000000`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/orders/cm0000000000000000000000000/refunds`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });

    it('F4 — EXTERNAL_CARD + avoir refusé (avoir = wallet uniquement)', async () => {
      const res = await postRefund(
        fOrderId,
        refundBody({
          amountCents: 100,
          kind: RefundKind.EXTERNAL_CARD,
          issueCreditNote: true,
        }),
        `q9-f4-${stamp}`,
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('avoir');
    });

    it('F5 — l’adaptateur bloqué ne bloque PAS l’interne : wallet 500c SUCCEEDED sur la même commande', async () => {
      const balanceBefore = await balanceOf();
      const res = await postRefund(
        fOrderId,
        refundBody({ amountCents: 500, reason: 'interne malgré adaptateur' }),
        `q9-f5-${stamp}`,
      ).expect(201);
      expect(res.body.status).toBe(RefundStatus.SUCCEEDED);
      expect(await balanceOf()).toBe(balanceBefore + 500);

      // …et la ligne EXTERNE est toujours PENDING, totalement indépendante.
      const external = await prisma.refund.findUniqueOrThrow({
        where: { id: fRefundId },
      });
      expect(external.status).toBe(RefundStatus.PENDING);
    });

    it('F6 — AUCUN remboursement externe déclaré réussi sur toute la base dédiée', async () => {
      expect(
        await prisma.refund.count({
          where: {
            kind: RefundKind.EXTERNAL_CARD,
            status: RefundStatus.SUCCEEDED,
          },
        }),
      ).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // G — Avoirs (credit notes) + PDF
  // ═══════════════════════════════════════════════════════════════════════
  describe('G — avoirs', () => {
    let gOrderId = '';
    let gInvoiceId = '';
    let note1Id = '';

    it('G1 — avoir partiel 1000 : AV- lié (creditNoteOfId), origine PAID, wallet +1000', async () => {
      const seeded = await seedPaidOrder('g');
      gOrderId = seeded.orderId;
      gInvoiceId = seeded.invoiceId;
      const balanceBefore = await balanceOf();

      const res = await postRefund(
        gOrderId,
        refundBody({
          amountCents: 1000,
          reason: 'Avoir partiel',
          issueCreditNote: true,
        }),
        `q9-g1-${stamp}`,
      ).expect(201);
      expect(res.body.status).toBe(RefundStatus.SUCCEEDED);
      note1Id = res.body.creditNoteInvoiceId as string;
      expect(note1Id).toBeTruthy();
      expect(await balanceOf()).toBe(balanceBefore + 1000);

      const note = await prisma.invoice.findUniqueOrThrow({
        where: { id: note1Id },
      });
      expect(note.number).toMatch(/^AV-/);
      expect(note.status).toBe(InvoiceStatus.CREDITED);
      expect(note.orderId).toBeNull(); // avoir standalone, jamais une commande
      expect(note.creditNoteOfId).toBe(gInvoiceId);
      expect(note.amountTtcCents).toBe(1000);
      expect(note.amountHtCents).toBe(870); // 15 % : taxe 130 arrondie
      expect(note.taxAmountCents).toBe(130);

      const line = await prisma.invoiceLine.findFirstOrThrow({
        where: { invoiceId: note1Id },
      });
      expect(line.kind).toBe('CREDIT');
      expect(line.totalTtcCents).toBe(1000);

      // Partiel : l'origine et la commande restent réglées.
      const origin = await prisma.invoice.findUniqueOrThrow({
        where: { id: gInvoiceId },
      });
      expect(origin.status).toBe(InvoiceStatus.PAID);
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: gOrderId },
      });
      expect(order.status).toBe(OrderStatus.PAID);
    });

    it('G2 — PDF de l’avoir : 200 admin + 200 propriétaire (client)', async () => {
      const adminPdf = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/invoices/${note1Id}/pdf`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(adminPdf.headers['content-type']).toContain('application/pdf');

      const clientPdf = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/client/invoices/${note1Id}/pdf`)
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(200);
      expect(clientPdf.headers['content-type']).toContain('application/pdf');
    });

    it('G3 — avoir final 500 (cumul EXACT) : MÊME avoir cumulé, origine CREDITED, commande REFUNDED', async () => {
      const balanceBefore = await balanceOf();
      const res = await postRefund(
        gOrderId,
        refundBody({
          amountCents: 500,
          reason: 'Avoir solde',
          issueCreditNote: true,
        }),
        `q9-g2-${stamp}`,
      ).expect(201);
      expect(res.body.status).toBe(RefundStatus.SUCCEEDED);
      expect(await balanceOf()).toBe(balanceBefore + 500);

      // Un seul avoir par facture (invariant) : le 2e remboursement CUMULE.
      expect(res.body.creditNoteInvoiceId).toBe(note1Id);
      const note = await prisma.invoice.findUniqueOrThrow({
        where: { id: note1Id },
      });
      expect(note.amountTtcCents).toBe(1500); // 1000 + 500
      expect(note.amountHtCents).toBe(1304); // 15 % : taxe 196 arrondie
      expect(note.taxAmountCents).toBe(196);
      expect(note.status).toBe(InvoiceStatus.CREDITED);
      expect(note.pdfRenderedStatus).toBeNull(); // PDF à régénérer (Q8)

      // Une ligne CREDIT par remboursement (traçabilité de chaque écriture).
      const lines = await prisma.invoiceLine.findMany({
        where: { invoiceId: note1Id },
        orderBy: { sortOrder: 'asc' },
      });
      expect(lines).toHaveLength(2);
      expect(lines[1].totalTtcCents).toBe(500);

      const origin = await prisma.invoice.findUniqueOrThrow({
        where: { id: gInvoiceId },
      });
      expect(origin.status).toBe(InvoiceStatus.CREDITED); // réglé par avoir
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: gOrderId },
      });
      expect(order.status).toBe(OrderStatus.REFUNDED);
      expect(
        await prisma.invoice.count({ where: { creditNoteOfId: gInvoiceId } }),
      ).toBe(1); // TOUJOURS un seul avoir par facture
    });

    it('G4 — plafond aussi épuisé après les avoirs : 409', async () => {
      const res = await postRefund(
        gOrderId,
        refundBody({ amountCents: 1, issueCreditNote: true }),
        `q9-g3-${stamp}`,
      );
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('Plafond');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // H — RBAC (routes refunds)
  // ═══════════════════════════════════════════════════════════════════════
  describe('H — RBAC', () => {
    let hOrderId = '';

    it('H0 — seed commande encaissée', async () => {
      const seeded = await seedPaidOrder('h');
      hOrderId = seeded.orderId;
    });

    it('H1 — anonyme : 401 sur POST et GET', async () => {
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/orders/${hOrderId}/refunds`)
        .send(refundBody({ amountCents: 100 }))
        .expect(401);
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/orders/${hOrderId}/refunds`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/refunds/cm0000000000000000000000000`)
        .expect(401);
    });

    it('H2 — USER : 403 sur POST et GET, aucun côté-effect', async () => {
      const before = await prisma.refund.count({
        where: { orderId: hOrderId },
      });
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/orders/${hOrderId}/refunds`)
        .set('Authorization', `Bearer ${memberToken}`)
        .set('Idempotency-Key', `q9-h2-${stamp}`)
        .send(refundBody({ amountCents: 100 }))
        .expect(403);
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/store/admin/orders/${hOrderId}/refunds`)
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .post(
          `/${GlobalPrefix}/store/admin/refunds/cm0000000000000000000000000/provider-confirmation`,
        )
        .set('Authorization', `Bearer ${memberToken}`)
        .send({})
        .expect(403);
      expect(await prisma.refund.count({ where: { orderId: hOrderId } })).toBe(
        before,
      );
      expect(await balanceOf()).toBeGreaterThanOrEqual(0); // wallet intact
    });

    it('H3 — ADMIN : 201 sur POST (Idempotency-Key requise)', async () => {
      const res = await postRefund(
        hOrderId,
        refundBody({ amountCents: 100 }),
        `q9-h3-${stamp}`,
      ).expect(201);
      expect(res.body.status).toBe(RefundStatus.SUCCEEDED);
    });

    it('H4 — clé absente ou trop courte : 400, aucune écriture', async () => {
      const before = await prisma.refund.count({
        where: { orderId: hOrderId },
      });
      const noKey = await postRefund(
        hOrderId,
        refundBody({ amountCents: 100 }),
      );
      expect(noKey.status).toBe(400);
      expect(noKey.body.message).toContain('Idempotency-Key');
      const shortKey = await postRefund(
        hOrderId,
        refundBody({ amountCents: 100 }),
        'short',
      );
      expect(shortKey.status).toBe(400);
      expect(shortKey.body.message).toContain('Idempotency-Key');
      expect(await prisma.refund.count({ where: { orderId: hOrderId } })).toBe(
        before,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // I — Garde-fous commande
  // ═══════════════════════════════════════════════════════════════════════
  describe('I — commande non encaissée / inconnue', () => {
    it('I1 — commande PENDING_PAYMENT (paidAt null) : 409, aucune écriture', async () => {
      const pendingId = await seedPendingOrder();
      const res = await postRefund(
        pendingId,
        refundBody({ amountCents: 100 }),
        `q9-i1-${stamp}`,
      );
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('non encaissée');
      expect(
        await prisma.refund.count({ where: { orderId: pendingId } }),
      ).toBe(0);
    });

    it('I2 — commande inconnue : 404', async () => {
      const res = await postRefund(
        'cm0000000000000000000000000',
        refundBody({ amountCents: 100 }),
        `q9-i2-${stamp}`,
      );
      expect(res.status).toBe(404);
      expect(res.body.message).toContain('introuvable');
    });
  });
});
