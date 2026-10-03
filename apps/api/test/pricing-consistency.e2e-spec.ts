import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
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

// Sweep (timer) OFF : aucune ligne de ce test ne dépend du sweep.
process.env.ORDER_SWEEP_ENABLED = 'false';

/**
 * P5 — Cohérence tarifaire (e2e, lot B2, GO socle) :
 *
 *  A. devis public `/store/quote` : prix ACTIF promo facturé (§6-2a), 0 écart
 *     avec la commande persistée, promo ≥ catalogue ignorée, taxe arrondie PAR
 *     LIGNE (strict ≠ arrondi global), option requise → 400, taux neuf appliqué ;
 *  B. CRUD des taux `/store/admin/tax-rates` (décision §6-6) : RBAC 401/403,
 *     nom dupliqué 409, un seul `isDefault`, suppression refusée (409) si
 *     produit rattaché, 404 inconnu, validation 0..100.
 *
 * Aucun réseau réel : MailTransportFactory + PanelTransportFactory stubbés,
 * PrismaService RÉEL sur la base dédiée du chantier (icode_host_pro_socle).
 */
describe('Cohérence tarifaire & taux de taxe (e2e, P5)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const adminEmail = `p5admin_${stamp}@example.com`;
  const userEmail = `p5user_${stamp}@example.com`;
  const guestEmail = `p5guest_${stamp}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let userToken = '';

  // Fixtures catalogue.
  let virId = '';
  let taxOddId = ''; // 19,6 % — rattaché à promoSlug (référence → suppression refusée)
  let promoSlug = ''; // 4900 → promo 3900, installation 1500, option requise, addon 701
  let promoOptionId = '';
  let promoChoiceLinuxId = '';
  let promoAddonId = '';
  let equalSlug = ''; // 4900 / promo 4900 (promo ignorée), sans taxe
  let oddSlug = ''; // 333 + addon 333 @19,6 % (arrondi par ligne)
  let oddAddonId = '';

  const orderIds: string[] = [];
  let createdMailId: string | null = null;

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

  function quote(body: Record<string, unknown>) {
    return request(app.getHttpServer()).post(`/${GlobalPrefix}/store/quote`).send(body);
  }

  const admin = (path: string) =>
    request(app.getHttpServer())
      .get(`/${GlobalPrefix}${path}`)
      .set('Authorization', `Bearer ${adminToken}`);

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
    await mkUser(adminEmail, Role.ADMIN, 'Admin P5');
    await mkUser(userEmail, Role.USER, 'User P5');
    adminToken = await login(adminEmail);
    userToken = await login(userEmail);

    const vir = await prisma.paymentMethod.create({
      data: { name: `VIR-P5-${stamp}`, type: PaymentMethodType.BANK_TRANSFER, isActive: true },
    });
    virId = vir.id;

    const taxOdd = await prisma.taxRate.create({
      data: { name: `p5-tva-odd-${stamp}`, ratePercent: 19.6, isDefault: false },
    });
    taxOddId = taxOdd.id;

    const promo = await prisma.product.create({
      data: {
        name: `p5-promo-${stamp}`,
        slug: `p5-promo-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 4900,
        promoPriceHtCents: 3900,
        installationFeeCents: 1500,
        taxRateId: taxOddId,
        options: {
          create: {
            name: 'Système',
            required: true,
            choices: {
              create: [
                { label: 'Linux', priceDeltaHtCents: 0 },
                { label: 'Linux +', priceDeltaHtCents: 500 },
              ],
            },
          },
        },
        addons: { create: { name: 'Backup', priceHtCents: 701 } },
      },
      include: { options: { include: { choices: true } }, addons: true },
    });
    promoSlug = promo.slug!;
    promoOptionId = promo.options[0].id;
    promoChoiceLinuxId = promo.options[0].choices.find((c) => c.label === 'Linux')!.id;
    promoAddonId = promo.addons[0].id;

    const equal = await prisma.product.create({
      data: {
        name: `p5-equal-${stamp}`,
        slug: `p5-equal-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 4900,
        promoPriceHtCents: 4900,
      },
    });
    equalSlug = equal.slug!;

    const odd = await prisma.product.create({
      data: {
        name: `p5-odd-${stamp}`,
        slug: `p5-odd-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 333,
        taxRateId: taxOddId,
        addons: { create: { name: 'Impaire', priceHtCents: 333 } },
      },
      include: { addons: true },
    });
    oddSlug = odd.slug!;
    oddAddonId = odd.addons[0].id;

    // Config mail minimale (host + fromEmail requis par getMailConfig) : le
    // transport est stubbé, aucun SMTP n'est jamais contactné. Snapshot/restore.
    const priorMail = await prisma.mailSetting.findFirst();
    if (!priorMail || !priorMail.host || !priorMail.fromEmail) {
      createdMailId = (
        await prisma.mailSetting.create({
          data: {
            host: 'smtp.test.local',
            fromEmail: `noreply-${stamp}@test.local`,
            fromName: 'Code Diali P5',
          },
        })
      ).id;
    }
  });

  beforeEach(() => {
    limiter.reset();
    mailTransportStub.sendMail.mockClear();
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
  });

  afterAll(async () => {
    await prisma.walletTransaction
      .deleteMany({ where: { orderId: { in: orderIds } } })
      .catch(() => {});
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { email: { in: [guestEmail] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: [guestEmail, adminEmail, userEmail] } } }).catch(() => {});
    await prisma.product
      .deleteMany({ where: { slug: { in: [promoSlug, equalSlug, oddSlug] } } })
      .catch(() => {});
    await prisma.taxRate.deleteMany({ where: { name: { contains: stamp } } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: virId } }).catch(() => {});
    if (createdMailId) {
      await prisma.mailSetting.delete({ where: { id: createdMailId } }).catch(() => {});
    }
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    delete process.env.ORDER_SWEEP_ENABLED;
    await app.close();
  });

  // ── A — devis public & prix (B2) ───────────────────────────────────────────
  describe('A — devis public /store/quote', () => {
    const cfg = {
      options: [] as { optionId: string; choiceId: string }[],
      addonIds: [] as string[],
    };

    beforeAll(() => {
      cfg.options = [{ optionId: promoOptionId, choiceId: promoChoiceLinuxId }];
      cfg.addonIds = [promoAddonId];
    });

    it('A1 — devis PUBLIC (sans auth) : prix promo facturé, ligne = prix affiché', async () => {
      const res = await quote({
        productSlug: promoSlug,
        options: cfg.options,
        addonIds: cfg.addonIds,
      }).expect(201);

      const body = res.body as {
        lines: {
          kind: string;
          unitPriceHtCents: number;
          taxRatePercent: number;
          taxAmountCents: number;
          totalTtcCents: number;
        }[];
        amountHtCents: number;
        taxAmountCents: number;
        amountTtcCents: number;
        taxRatePercent: number;
        product: { priceHtCents: number; promoPriceHtCents: number; activePriceHtCents: number };
      };

      // Prix promo (décision §6-2a) : le devis affiche/débite le prix actif.
      expect(body.product.priceHtCents).toBe(4900);
      expect(body.product.promoPriceHtCents).toBe(3900);
      expect(body.product.activePriceHtCents).toBe(3900);
      expect(body.lines[0].unitPriceHtCents).toBe(3900);

      // Totaux stricts : taxe PAR LIGNE, installation jamais taxée, sommes exactes.
      const kinds = body.lines.map((l) => l.kind);
      expect(kinds).toEqual(['PRODUCT', 'OPTION', 'ADDON', 'ADJUSTMENT']);
      const adj = body.lines.find((l) => l.kind === 'ADJUSTMENT')!;
      expect(adj.unitPriceHtCents).toBe(1500);
      expect(adj.taxAmountCents).toBe(0);
      for (const l of body.lines) {
        if (l.kind === 'ADJUSTMENT') continue;
        expect(l.taxRatePercent).toBe(19.6);
        expect(l.taxAmountCents).toBe(Math.round((l.unitPriceHtCents * 19.6) / 100));
      }
      expect(body.amountHtCents).toBe(body.lines.reduce((s, l) => s + l.unitPriceHtCents, 0));
      expect(body.taxAmountCents).toBe(body.lines.reduce((s, l) => s + l.taxAmountCents, 0));
      expect(body.amountTtcCents).toBe(body.amountHtCents + body.taxAmountCents);
      expect(body.taxRatePercent).toBe(19.6);
    });

    it('A2 — 0 écart devis ↔ commande : les totaux persistés sont EXACTEMENT ceux du devis', async () => {
      const q = await quote({
        productSlug: promoSlug,
        options: cfg.options,
        addonIds: cfg.addonIds,
      }).expect(201);

      const checkout = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/checkout`)
        .send({
          productSlug: promoSlug,
          options: cfg.options,
          addonIds: cfg.addonIds,
          name: 'Client P5',
          email: guestEmail,
          paymentMethodId: virId,
        })
        .expect(201);

      const orderId = (checkout.body as { orderId: string }).orderId;
      orderIds.push(orderId);
      expect(checkout.body.nextStep).toBe('payment-pending');

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(order.amountHtCents).toBe(q.body.amountHtCents);
      expect(order.taxAmountCents).toBe(q.body.taxAmountCents);
      expect(order.amountTtcCents).toBe(q.body.amountTtcCents);
      // Pas de surprise : HT du devis = 3900 promo + 0 option + 701 addon + 1500 install.
      expect(order.amountHtCents).toBe(3900 + 0 + 701 + 1500);
    });

    it('A3 — promo ÉGALE au catalogue → catalogue facturé (ignorée)', async () => {
      const res = await quote({ productSlug: equalSlug }).expect(201);
      expect(res.body.product.activePriceHtCents).toBe(4900);
      expect(res.body.lines[0].unitPriceHtCents).toBe(4900);
    });

    it('A4 — taxe ARRONDIE PAR LIGNE : 130 (par ligne) ≠ 131 (arrondi du HT global)', async () => {
      const res = await quote({ productSlug: oddSlug, addonIds: [oddAddonId] }).expect(201);
      const body = res.body as {
        lines: { kind: string; taxAmountCents: number }[];
        amountHtCents: number;
        taxAmountCents: number;
        amountTtcCents: number;
      };
      expect(body.amountHtCents).toBe(666); // 333 + 333
      expect(body.lines.map((l) => l.taxAmountCents)).toEqual([65, 65]); // 333×19,6 % = 65,268
      expect(body.taxAmountCents).toBe(130);
      expect(Math.round((body.amountHtCents * 19.6) / 100)).toBe(131); // ≠
      expect(body.amountTtcCents).toBe(666 + 130);
    });

    it('A5 — option requise manquante → 400 honnête (aucun total silencieux)', async () => {
      await quote({ productSlug: promoSlug, addonIds: cfg.addonIds }).expect(400);
    });

    it('A6 — slug inconnu → 404', async () => {
      await quote({ productSlug: `p5-nope-${stamp}` }).expect(404);
    });

    it('A7 — taux neuf appliqué immédiatement au devis, puis retiré', async () => {
      const created = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/tax-rates`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `p5-tva-55-${stamp}`, ratePercent: 5.5, isDefault: false })
        .expect(201);
      const rateId = (created.body as { id: string }).id;

      await prisma.product.update({
        where: { id: (await prisma.product.findUniqueOrThrow({ where: { slug: equalSlug } })).id },
        data: { taxRateId: rateId },
      });

      const res = await quote({ productSlug: equalSlug }).expect(201);
      expect(res.body.taxRatePercent).toBe(5.5);
      expect(res.body.lines[0].taxAmountCents).toBe(Math.round((4900 * 5.5) / 100)); // 269,5 → 270
      expect(res.body.amountTtcCents).toBe(4900 + Math.round((4900 * 5.5) / 100));

      // Retrait du taux → retour au taux par défaut 0 (aucun taux imposé).
      await prisma.product.update({
        where: { slug: equalSlug },
        data: { taxRateId: null },
      });
      const back = await quote({ productSlug: equalSlug }).expect(201);
      expect(back.body.taxRatePercent).toBe(0);
      expect(back.body.amountTtcCents).toBe(4900);

      await request(app.getHttpServer())
        .delete(`/${GlobalPrefix}/store/admin/tax-rates/${rateId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });
  });

  // ── B — CRUD des taux (§6-6, /manager/taxe) ────────────────────────────────
  describe('B — CRUD /store/admin/tax-rates', () => {
    let prevDefaultId: string | null = null;
    let rateXId = '';

    it('B1 — RBAC strict : 401 sans token, 403 USER, 200 ADMIN', async () => {
      await api('/store/admin/tax-rates').expect(401);
      await api('/store/admin/tax-rates', userToken).expect(403);

      const res = await admin('/store/admin/tax-rates').expect(200);
      const rows = res.body as { id: string; name: string; isDefault: boolean }[];
      expect(Array.isArray(rows)).toBe(true);
      prevDefaultId = rows.find((r) => r.isDefault)?.id ?? null;
    });

    it('B2 — nom dupliqué → 409 ; taux hors bornes → 400', async () => {
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/tax-rates`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `p5-tva-odd-${stamp}`, ratePercent: 10, isDefault: false })
        .expect(409);

      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/tax-rates`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `p5-tva-bad-${stamp}`, ratePercent: 150, isDefault: false })
        .expect(400);
    });

    it('B3 — UN SEUL isDefault : bascule + restauration du défaut initial', async () => {
      const created = await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/store/admin/tax-rates`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `p5-tva-x-${stamp}`, ratePercent: 10, isDefault: false })
        .expect(201);
      rateXId = (created.body as { id: string }).id;

      await request(app.getHttpServer())
        .patch(`/${GlobalPrefix}/store/admin/tax-rates/${rateXId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isDefault: true })
        .expect(200);

      const res = await admin('/store/admin/tax-rates').expect(200);
      const rows = res.body as { id: string; isDefault: boolean }[];
      expect(rows.find((r) => r.id === rateXId)?.isDefault).toBe(true);
      if (prevDefaultId) {
        expect(rows.find((r) => r.id === prevDefaultId)?.isDefault).toBe(false);
        // Restauration du défaut initial (propriété partagée par la plateforme).
        await request(app.getHttpServer())
          .patch(`/${GlobalPrefix}/store/admin/tax-rates/${prevDefaultId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ isDefault: true })
          .expect(200);
      } else {
        await request(app.getHttpServer())
          .patch(`/${GlobalPrefix}/store/admin/tax-rates/${rateXId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ isDefault: false })
          .expect(200);
      }
    });

    it('B4 — suppression REFUSÉE (409) tant qu’un produit référence le taux', async () => {
      await request(app.getHttpServer())
        .delete(`/${GlobalPrefix}/store/admin/tax-rates/${taxOddId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);

      // Toujours présent en base.
      const still = await prisma.taxRate.findUnique({ where: { id: taxOddId } });
      expect(still).not.toBeNull();
    });

    it('B5 — taux non référencé → suppression OK ; inconnu → 404', async () => {
      await request(app.getHttpServer())
        .delete(`/${GlobalPrefix}/store/admin/tax-rates/${rateXId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const gone = await prisma.taxRate.findUnique({ where: { id: rateXId } });
      expect(gone).toBeNull();

      await request(app.getHttpServer())
        .patch(`/${GlobalPrefix}/store/admin/tax-rates/p5-nope-${stamp}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isDefault: false })
        .expect(404);
      await request(app.getHttpServer())
        .delete(`/${GlobalPrefix}/store/admin/tax-rates/p5-nope-${stamp}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });
});
