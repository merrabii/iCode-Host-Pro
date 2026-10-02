import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { InvoiceStatus, OrderStatus, Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import {
  PanelTransport,
  PanelTransportFactory,
} from './../src/servers/panel-transport.factory';

// Sweep (timer) OFF : aucune ligne de ce test ne dépend du sweep.
process.env.ORDER_SWEEP_ENABLED = 'false';

/**
 * P4 — Visibilité / isolation (e2e, lot B1) :
 *
 *  A. vues client : liste paginée + détail, ISOLATION stricte par compte
 *     (404 croisé, jamais 403 — pas de révélation d'existence) ;
 *  B. repli email du dossier invité (customer.userId nul) ;
 *  C. pagination + validation des paramètres (page=0 → 400, statut invalide → 400) ;
 *  D. listes admin (commandes/factures/clients) : RBAC 401/403, agrégats KPI,
 *     recherche, détail ;
 *  E. aucun secret interne exposé sur les vues client (clés de tête).
 *
 * Aucun réseau réel : MailTransportFactory + PanelTransportFactory stubbés
 * (jamais appelés ici), PrismaService RÉEL sur la base dédiée du chantier.
 */
describe('Visibilité & isolation des listes (e2e, P4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const adminEmail = `p4admin_${stamp}@example.com`;
  const aliceEmail = `p4alice_${stamp}@example.com`;
  const bobEmail = `p4bob_${stamp}@example.com`;
  const carolEmail = `p4carol_${stamp}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let aliceToken = '';
  let bobToken = '';
  let carolToken = '';

  let aliceId = '';
  let bobId = '';
  let carolId = '';
  let adminIdSeed = '';
  let productId = '';

  // Commandes : alice x2 (PENDING + ACTIVE), bob x1 (PAID), dossier invité x1.
  let aliceOrder1 = ''; // PENDING_PAYMENT
  let aliceOrder2 = ''; // ACTIVE
  let bobOrder1 = ''; // PAID
  let guestOrder1 = ''; // PAID — dossier invité rattaché à carol par email
  let aliceInvoice1 = '';
  let bobInvoice1 = '';
  const customerIds: string[] = [];

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = {
    create: jest.fn().mockReturnValue(mailTransportStub),
  };
  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({}) as PanelTransport,
  } as unknown as PanelTransportFactory;

  function api(path: string, token?: string) {
    const req = request(app.getHttpServer()).get(`/${GlobalPrefix}${path}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email, password })
      .expect(201);
    return res.body.accessToken as string;
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
      const u = await prisma.user.create({
        data: {
          email,
          name,
          passwordHash: await bcrypt.hash(password, 10),
          role,
        },
      });
      return u.id;
    };
    adminIdSeed = await mkUser(adminEmail, Role.ADMIN, 'Admin P4');
    aliceId = await mkUser(aliceEmail, Role.USER, 'Alice P4');
    bobId = await mkUser(bobEmail, Role.USER, 'Bob P4');
    carolId = await mkUser(carolEmail, Role.USER, 'Carol P4');

    adminToken = await login(adminEmail);
    aliceToken = await login(aliceEmail);
    bobToken = await login(bobEmail);
    carolToken = await login(carolEmail);

    const product = await prisma.product.create({
      data: {
        name: `p4-prod-${stamp}`,
        slug: `p4-prod-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 1000,
      },
    });
    productId = product.id;

    // Dossiers client : alice/bob liés (userId), guest sans liaison (email seul).
    const mkCustomer = async (
      email: string,
      userId: string | null,
      name: string,
    ) => {
      const c = await prisma.customer.create({
        data: { email, name, userId },
      });
      customerIds.push(c.id);
      return c.id;
    };
    const aliceCustomer = await mkCustomer(aliceEmail, aliceId, 'Alice P4');
    const bobCustomer = await mkCustomer(bobEmail, bobId, 'Bob P4');
    const guestCustomer = await mkCustomer(carolEmail, null, 'Client invité P4');

    const mkOrder = async (
      customerId: string,
      email: string,
      name: string,
      status: OrderStatus,
      ttc: number,
      key: string,
    ) => {
      const o = await prisma.order.create({
        data: {
          customerId,
          customerName: name,
          customerEmail: email,
          productId,
          productName: `p4-prod-${stamp}`,
          status,
          amountHtCents: ttc,
          taxAmountCents: 0,
          amountTtcCents: ttc,
          idempotencyKey: `p4-${key}-${stamp}`,
          idempotencyBase: `p4-${key}-${stamp}`,
        },
      });
      return o.id;
    };
    aliceOrder1 = await mkOrder(aliceCustomer, aliceEmail, 'Alice P4', OrderStatus.PENDING_PAYMENT, 1000, 'a1');
    aliceOrder2 = await mkOrder(aliceCustomer, aliceEmail, 'Alice P4', OrderStatus.ACTIVE, 2000, 'a2');
    bobOrder1 = await mkOrder(bobCustomer, bobEmail, 'Bob P4', OrderStatus.PAID, 3000, 'b1');
    guestOrder1 = await mkOrder(guestCustomer, carolEmail, 'Client invité P4', OrderStatus.PAID, 4000, 'g1');

    const invAlice = await prisma.invoice.create({
      data: {
        number: `P4-A-${stamp}`,
        orderId: aliceOrder1,
        customerId: aliceCustomer,
        status: InvoiceStatus.UNPAID,
        amountHtCents: 1000,
        taxAmountCents: 0,
        amountTtcCents: 1000,
      },
    });
    aliceInvoice1 = invAlice.id;
    const invBob = await prisma.invoice.create({
      data: {
        number: `P4-B-${stamp}`,
        orderId: bobOrder1,
        customerId: bobCustomer,
        status: InvoiceStatus.PAID,
        amountHtCents: 3000,
        taxAmountCents: 0,
        amountTtcCents: 3000,
        paidAt: new Date(),
      },
    });
    bobInvoice1 = invBob.id;
  }, 120_000);

  afterAll(async () => {
    // Nettoyage de SES fixtures uniquement (aucune suppression hors ce périmètre).
    if (aliceInvoice1) await prisma.invoice.delete({ where: { id: aliceInvoice1 } }).catch(() => undefined);
    if (bobInvoice1) await prisma.invoice.delete({ where: { id: bobInvoice1 } }).catch(() => undefined);
    const orderIds = [aliceOrder1, aliceOrder2, bobOrder1, guestOrder1].filter(Boolean);
    if (orderIds.length) {
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    if (customerIds.length) {
      await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    }
    if (productId) await prisma.product.delete({ where: { id: productId } }).catch(() => undefined);
    const userIds = [adminIdSeed, aliceId, bobId, carolId].filter(Boolean);
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await app?.close();
  });

  // ── A. Isolation des vues client ───────────────────────────────────────────
  it('A1 — alice ne voit QUE ses commandes (liste filtrée par propriétaire)', async () => {
    const res = await api('/client/orders', aliceToken).expect(200);
    expect(res.body.total).toBe(2);
    const ids = res.body.items.map((o: { id: string }) => o.id);
    expect(ids).toContain(aliceOrder1);
    expect(ids).toContain(aliceOrder2);
    expect(ids).not.toContain(bobOrder1);
    expect(ids).not.toContain(guestOrder1);
  });

  it('A2 — détail croisé = 404 (pas 403 : aucune révélation d’existence)', async () => {
    await api(`/client/orders/${bobOrder1}`, aliceToken).expect(404);
    await api(`/client/orders/${aliceOrder1}`, bobToken).expect(404);
    // Le vrai propriétaire, lui, obtient 200.
    await api(`/client/orders/${aliceOrder1}`, aliceToken).expect(200);
  });

  it('A3 — factures isolées : liste + détail croisé 404', async () => {
    const res = await api('/client/invoices', aliceToken).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(aliceInvoice1);
    expect(res.body.items[0].number).toBe(`P4-A-${stamp}`);

    await api(`/client/invoices/${bobInvoice1}`, aliceToken).expect(404);
    await api(`/client/invoices/${aliceInvoice1}`, aliceToken).expect(200);
  });

  it('A4 — aucune clé interne sur les vues client (select explicite)', async () => {
    const res = await api('/client/orders', aliceToken).expect(200);
    for (const item of res.body.items) {
      expect(item.idempotencyKey).toBeUndefined();
      expect(item.clientKey).toBeUndefined();
      expect(item.clientKeyHash).toBeUndefined();
      expect(item.idempotencyBase).toBeUndefined();
      expect(item.walletTransactionId).toBeUndefined();
    }
  });

  it('A5 — anonyme sur une vue client = 401', async () => {
    await api('/client/orders').expect(401);
    await api('/client/invoices').expect(401);
  });

  // ── B. Repli email (dossier invité sans userId) ────────────────────────────
  it('B1 — carol voit la commande du dossier invité rattaché à SON email', async () => {
    const res = await api('/client/orders', carolToken).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(guestOrder1);
    // …mais pas les commandes d’un autre compte.
    const res2 = await api('/client/invoices', carolToken).expect(200);
    expect(res2.body.total).toBe(0);
  });

  // ── C. Pagination + validation ─────────────────────────────────────────────
  it('C1 — pagination : perPage=1 → 2 pages, items disjoints, total stable', async () => {
    const p1 = await api('/client/orders?perPage=1&page=1', aliceToken).expect(200);
    const p2 = await api('/client/orders?perPage=1&page=2', aliceToken).expect(200);
    expect(p1.body.total).toBe(2);
    expect(p2.body.total).toBe(2);
    expect(p1.body.items).toHaveLength(1);
    expect(p2.body.items).toHaveLength(1);
    expect(p1.body.items[0].id).not.toBe(p2.body.items[0].id);
  });

  it('C2 — validation stricte : page=0 → 400, statut invalide → 400', async () => {
    await api('/client/orders?page=0', aliceToken).expect(400);
    await api('/client/orders?status=BOGUS', aliceToken).expect(400);
    await api('/store/admin/orders?page=0', adminToken).expect(400);
    await api('/store/admin/orders?status=BOGUS', adminToken).expect(400);
  });

  it('C3 — filtre statut côté client (proprio ET filtre)', async () => {
    const res = await api('/client/orders?status=ACTIVE', aliceToken).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(aliceOrder2);
    const res2 = await api('/client/orders?status=PENDING_PAYMENT', aliceToken).expect(200);
    expect(res2.body.total).toBe(1);
    expect(res2.body.items[0].id).toBe(aliceOrder1);
  });

  // ── D. Listes admin (RBAC + agrégats + recherche) ─────────────────────────
  it('D1 — RBAC : anonyme 401, USER 403 sur toutes les listes admin', async () => {
    await api('/store/admin/orders').expect(401);
    await api('/store/admin/invoices').expect(401);
    await api('/store/admin/customers').expect(401);
    await api('/store/admin/orders', aliceToken).expect(403);
    await api('/store/admin/invoices', aliceToken).expect(403);
    await api('/store/admin/customers', aliceToken).expect(403);
  });

  it('D2 — admin : liste globale des commandes + KPI summary', async () => {
    const res = await api('/store/admin/orders', adminToken).expect(200);
    expect(res.body.total).toBe(4);
    const s = res.body.summary;
    expect(s.totalTtcCents).toBe(10000);
    const byStatus = Object.fromEntries(
      s.statuses.map((x: { status: string; count: number }) => [x.status, x.count]),
    );
    expect(byStatus.PENDING_PAYMENT).toBe(1);
    expect(byStatus.ACTIVE).toBe(1);
    expect(byStatus.PAID).toBe(2);
    // La vue admin VOIT les autres clients (contrairement au client).
    const ids = res.body.items.map((o: { id: string }) => o.id);
    expect(ids).toEqual(expect.arrayContaining([aliceOrder1, aliceOrder2, bobOrder1, guestOrder1]));
  });

  it('D3 — admin : recherche email + filtre statut + pagination', async () => {
    const q = await api(`/store/admin/orders?q=${encodeURIComponent(bobEmail)}`, adminToken).expect(200);
    expect(q.body.total).toBe(1);
    expect(q.body.items[0].id).toBe(bobOrder1);

    const f = await api('/store/admin/orders?status=PENDING_PAYMENT', adminToken).expect(200);
    expect(f.body.total).toBe(1);
    expect(f.body.items[0].id).toBe(aliceOrder1);
    // Le summary suit le filtre (KPI = vue courante).
    expect(f.body.summary.totalTtcCents).toBe(1000);

    const p = await api('/store/admin/orders?perPage=2&page=2', adminToken).expect(200);
    expect(p.body.total).toBe(4);
    expect(p.body.items).toHaveLength(2);
  });

  it('D4 — admin : détail de commande (client inclus) + 404 inconnu', async () => {
    const res = await api(`/store/admin/orders/${aliceOrder1}`, adminToken).expect(200);
    expect(res.body.customer.email).toBe(aliceEmail);
    expect(res.body.status).toBe('PENDING_PAYMENT');

    await api('/store/admin/orders/does-not-exist', adminToken).expect(404);
  });

  it('D5 — admin : factures globales + recherche par numéro + détail', async () => {
    const res = await api('/store/admin/invoices', adminToken).expect(200);
    expect(res.body.total).toBe(2);

    const q = await api(
      `/store/admin/invoices?q=${encodeURIComponent(`P4-B-${stamp}`)}`,
      adminToken,
    ).expect(200);
    expect(q.body.total).toBe(1);
    expect(q.body.items[0].id).toBe(bobInvoice1);
    expect(q.body.items[0].customer.email).toBe(bobEmail);

    const det = await api(`/store/admin/invoices/${aliceInvoice1}`, adminToken).expect(200);
    expect(det.body.number).toBe(`P4-A-${stamp}`);
    expect(det.body.lines).toEqual([]);

    await api('/store/admin/invoices/does-not-exist', adminToken).expect(404);
  });

  it('D6 — admin : clients globaux (3 dossiers) + recherche email + compteurs', async () => {
    const res = await api('/store/admin/customers', adminToken).expect(200);
    expect(res.body.total).toBe(3);

    const q = await api(
      `/store/admin/customers?q=${encodeURIComponent(carolEmail)}`,
      adminToken,
    ).expect(200);
    expect(q.body.total).toBe(1);
    expect(q.body.items[0].userId).toBeNull(); // dossier invité visible tel quel
    expect(q.body.items[0]._count.orders).toBe(1);
  });
});
