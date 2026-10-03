import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { FeeType, OrderStatus, PaymentMethodType, Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import {
  PanelTransport,
  PanelTransportFactory,
} from './../src/servers/panel-transport.factory';

// Aucun timer ne doit tourner pendant cette recette (pattern des specs P7/P8).
process.env.ORDER_SWEEP_ENABLED = 'false';
process.env.RENEWAL_SWEEP_ENABLED = 'false';

/**
 * P9 — Complétude de l'audit (e2e, lot E1, GO socle, M-05) :
 *
 *  A. `payment.checkout` porte l'ACTEUR (actorId + actorEmail) — créateur du
 *     compte au checkout (constat d'audit : action enregistrée sans acteur) ;
 *  B. confirmation admin : `payment.confirmed` avec acteur ADMIN (actorId =
 *     sub) + `from`/`to` dans les détails, et UNE ligne `order.transition`
 *     PENDING_PAYMENT → PAID tracée avec le même acteur ;
 *  C. `payment.method.update` journalise les VALEURS de frais (feeType +
 *     feePercent + feeFixedCents, pas seulement le type) ;
 *  D. transition de provisioning : commande SANS module de provisioning →
 *     `order.transition` PAID → ACTIVE (`via: provision_no_method`), la
 *     commande atteint réellement ACTIVE (auto-lancement post-confirmation) ;
 *  E. RBAC des actions de provisioning (401 anonyme / 403 USER).
 *
 * Aucun réseau réel : MailTransportFactory + PanelTransportFactory stubbés,
 * PrismaService RÉEL sur la base dédiée du chantier (icode_host_pro_socle).
 */
describe('Complétude audit & transitions (e2e, P9)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const adminEmail = `p9admin_${stamp}@example.com`;
  const aliceEmail = `p9alice_${stamp}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let aliceToken = '';

  let virId = '';
  let productId = '';
  let aliceUserId = '';
  let adminUserId = '';
  let aliceOrderId = '';
  let createdMailId: string | null = null;

  const orderIds: string[] = [];

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = {
    create: jest.fn().mockReturnValue(mailTransportStub),
  };
  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({}) as PanelTransport,
  } as unknown as PanelTransportFactory;

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email, password })
      .expect(201);
    return res.body.accessToken as string;
  }

  function checkout(name: string, token: string) {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/checkout`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        productSlug: `p9-audit-${stamp}`,
        name,
        email: aliceEmail,
        paymentMethodId: virId,
      });
  }

  function confirm(id: string, token = adminToken) {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/orders/${id}/confirm-payment`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reference: 'P9-AUDIT-REF' });
  }

  /** Lignes d'audit d'une ressource, les plus récentes d'abord. */
  async function auditsOf(resourceId: string) {
    return prisma.auditLog.findMany({
      where: { resourceId },
      orderBy: { createdAt: 'desc' },
    });
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
    limiter.reset();

    const mkUser = async (email: string, role: Role, name: string) => {
      await prisma.user.create({
        data: {
          email,
          name,
          passwordHash: await bcrypt.hash(password, 10),
          role,
        },
      });
    };
    await mkUser(adminEmail, Role.ADMIN, 'Admin P9');
    await mkUser(aliceEmail, Role.USER, 'Alice P9');
    adminToken = await login(adminEmail);
    aliceToken = await login(aliceEmail);
    adminUserId = (await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } })).id;
    aliceUserId = (await prisma.user.findUniqueOrThrow({ where: { email: aliceEmail } })).id;

    const vir = await prisma.paymentMethod.create({
      data: { name: `VIR-P9-${stamp}`, type: PaymentMethodType.BANK_TRANSFER, isActive: true },
    });
    virId = vir.id;

    // Produit SANS pack/module de provisioning : la confirmation lance le
    // provisioning legacy qui bascule directement en ACTIVE (aucun réseau).
    const product = await prisma.product.create({
      data: {
        name: `p9-audit-${stamp}`,
        slug: `p9-audit-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 10000,
      },
    });
    productId = product.id;

    // Config mail minimale (transport stubbé, 0 SMTP).
    const priorMail = await prisma.mailSetting.findFirst();
    if (!priorMail || !priorMail.host || !priorMail.fromEmail) {
      createdMailId = (
        await prisma.mailSetting.create({
          data: {
            host: 'smtp.test.local',
            fromEmail: `noreply-${stamp}@test.local`,
            fromName: 'Code Diali P9',
          },
        })
      ).id;
    }
  });

  beforeEach(() => {
    limiter.reset();
  });

  afterAll(async () => {
    const allEmails = [adminEmail, aliceEmail];
    const users = await prisma.user
      .findMany({ where: { email: { in: allEmails } }, select: { id: true } })
      .catch(() => []);
    const userIds = users.map((u) => u.id);
    const orders = await prisma.order
      .findMany({
        where: { OR: [{ customerEmail: { in: allEmails } }, { id: { in: orderIds } }] },
        select: { id: true },
      })
      .catch(() => []);
    const ids = orders.map((o) => o.id);
    const subs = await prisma.subscription
      .findMany({ where: { userId: { in: userIds } }, select: { id: true } })
      .catch(() => []);

    await prisma.auditLog
      .deleteMany({ where: { resourceId: { in: [...ids, ...subs.map((s) => s.id), virId] } } })
      .catch(() => {});
    await prisma.invoice.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.subscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { email: { in: allEmails } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: allEmails } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { id: productId } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: virId } }).catch(() => {});
    if (createdMailId) {
      await prisma.mailSetting.delete({ where: { id: createdMailId } }).catch(() => {});
    }
    await app?.close();
  });

  // ── A. payment.checkout avec acteur ────────────────────────────────────────
  it('A — payment.checkout porte l’acteur (actorId + actorEmail) au checkout', async () => {
    const res = await checkout('Alice P9', aliceToken).expect(201);
    aliceOrderId = (res.body as { orderId: string }).orderId;
    orderIds.push(aliceOrderId);

    const rows = await prisma.auditLog.findMany({
      where: { action: 'payment.checkout', resourceId: aliceOrderId },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const created = rows.find((r) =>
      (r.details as { stage?: string } | null)?.stage === 'order-created',
    );
    expect(created).toBeDefined();
    expect(created!.actorId).toBe(aliceUserId);
    expect(created!.actorEmail).toBe(aliceEmail);
  });

  // ── B. confirmation admin : payment.confirmed + order.transition ───────────
  it('B — confirmation admin : payment.confirmed acteur ADMIN (from/to) + order.transition PENDING_PAYMENT → PAID', async () => {
    await confirm(aliceOrderId).expect(201);

    const rows = await auditsOf(aliceOrderId);

    const confirmed = rows.find((r) => r.action === 'payment.confirmed');
    expect(confirmed).toBeDefined();
    expect(confirmed!.actorId).toBe(adminUserId);
    expect(confirmed!.actorEmail).toBe(adminEmail);
    const details = confirmed!.details as {
      source?: string;
      from?: string;
      to?: string;
      amountTtcCents?: number;
    };
    expect(details.source).toBe('admin-transfer');
    expect(details.from).toBe(OrderStatus.PENDING_PAYMENT);
    expect(details.to).toBe(OrderStatus.PAID);
    expect(details.amountTtcCents).toBe(10000);

    const transition = rows.find((r) => r.action === 'order.transition');
    expect(transition).toBeDefined();
    expect(transition!.actorId).toBe(adminUserId);
    expect(transition!.actorEmail).toBe(adminEmail);
    const t = transition!.details as { from?: string; to?: string; source?: string };
    expect(t.from).toBe(OrderStatus.PENDING_PAYMENT);
    expect(t.to).toBe(OrderStatus.PAID);
    expect(t.source).toBe('admin-transfer');
  });

  // ── C. frais de moyen de paiement journalisés ─────────────────────────────
  it('C — payment.method.update journalise les VALEURS de frais (feeType + percent + fixed)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/store/admin/payment-methods/${virId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ feeType: FeeType.PERCENT_AND_FIXED, feePercent: 2.5, feeFixedCents: 100 })
      .expect(200);
    expect(res.body).toMatchObject({ feeType: 'PERCENT_AND_FIXED', feePercent: '2.5', feeFixedCents: 100 });

    const row = await prisma.auditLog.findFirst({
      where: { action: 'payment.method.update', resourceId: virId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row!.actorId).toBe(adminUserId);
    expect(row!.actorEmail).toBe(adminEmail);
    expect(row!.details).toMatchObject({
      feeType: 'PERCENT_AND_FIXED',
      feePercent: '2.5',
      feeFixedCents: 100,
    });
  });

  // ── D. transition de provisioning (sans module → ACTIVE) ──────────────────
  it('D — auto-provisioning sans module : order.transition PAID → ACTIVE (provision_no_method), commande ACTIVE', async () => {
    // La confirmation a lancé le provisioning en fire-and-forget : on attend
    // (max ~10 s) la ligne d'audit de transition écrite par le service.
    let transition: { details: unknown } | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !transition) {
      const rows = await prisma.auditLog.findMany({
        where: { action: 'order.transition', resourceId: aliceOrderId },
        orderBy: { createdAt: 'desc' },
      });
      transition = rows.find((r) => (r.details as { via?: string })?.via === 'provision_no_method') ?? null;
      if (!transition) await new Promise((r) => setTimeout(r, 200));
    }
    expect(transition).not.toBeNull();
    expect(transition!.details).toMatchObject({
      from: OrderStatus.PAID,
      to: OrderStatus.ACTIVE,
      via: 'provision_no_method',
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: aliceOrderId } });
    expect(order.status).toBe(OrderStatus.ACTIVE);
  });

  // ── E. RBAC des actions de provisioning ───────────────────────────────────
  it('E — RBAC : 401 anonyme et 403 USER sur les actions admin de provisioning', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/orders/${aliceOrderId}/provision`)
      .expect(401);
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/orders/${aliceOrderId}/provision`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(403);
  });
});
