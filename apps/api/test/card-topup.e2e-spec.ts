import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import {
  PanelTransport,
  PanelTransportFactory,
} from './../src/servers/panel-transport.factory';
import { signStripeWebhook } from './../src/payments/stripe-signature';
import { PAYMENT_SIMULATOR_ENABLED_ENV } from './../src/config/payment-simulator';
import { CryptoService } from './../src/crypto/crypto.service';

// Sweep (timer) OFF : aucune ligne de ce test ne dépend d'un sweep.
process.env.ORDER_SWEEP_ENABLED = 'false';
process.env.RENEWAL_SWEEP_ENABLED = 'false';

/**
 * GO Stripe §3–§6 (e2e) — recharge par CARTE, webhook signé, remboursements.
 *
 * A. configuration : sans prestataire = refus net ; live/mauvais préfixes refusés ;
 *    secrets JAMAIS renvoyés (écrits-seuls).
 * B. sessions : idempotence (double-clic = UNE session), montants, devises,
 *    isolation client, RBAC.
 * C. paiement simulé → crédit EXACTEMENT UNE fois (webhook signé, doublon,
 *    rejeu, concurrence réelle).
 * D. refus / expiration / succession contradictoire → 0 crédit, signalement.
 * E. signature (corps brut) : mauvaise, absente, JSON illisible, secret absent.
 * F. incohérence montant → NEEDS_REVIEW (aucun crédit approximatif).
 * G. remboursements : plafond, idempotence, solde déjà dépensé, RBAC.
 * H. litige + remboursement hors plateforme → signalement, solde inchangé.
 *
 * Aucun réseau réel : connecteur SIMULÉ + Mail/Panel stubbés ; PrismaService
 * RÉEL sur la base dédiée du chantier (icode_host_pro_socle).
 */
describe('Recharge par carte & webhooks Stripe (e2e, GO)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;
  let crypto: CryptoService;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date();

  const adminEmail = `stadmin_${uid}@example.com`;
  const aliceEmail = `stalice_${uid}@example.com`;
  const bobEmail = `stbob_${uid}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let aliceToken = '';
  let bobToken = '';

  /** Références créées (nettoyage ciblé en afterAll). */
  const refs: string[] = [];
  const emails = [adminEmail, aliceEmail, bobEmail];

  let walletCurrency = 'USD';

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };
  const fakePanelFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({}) as PanelTransport,
  } as unknown as PanelTransportFactory;

  const api = () => request(app.getHttpServer());

  async function login(email: string): Promise<string> {
    const res = await api()
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email, password })
      .expect(201);
    return res.body.accessToken as string;
  }

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function balanceOf(email: string): Promise<number> {
    const c = await prisma.customer.findUnique({ where: { email } });
    return c?.walletBalanceCents ?? -1;
  }

  async function paymentRow(reference: string) {
    return prisma.cardPayment.findUnique({ where: { reference } });
  }

  /** Ouverture d'une session de recharge (clé d'idempotence optionnelle). */
  async function createTopup(
    token: string,
    amountCents: number,
    opts: { key?: string; currency?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const req = api()
      .post(`/${GlobalPrefix}/client/payments/topups`)
      .set(auth(token))
      .send({
        amountCents,
        ...(opts.currency ? { currency: opts.currency } : {}),
      });
    if (opts.key !== undefined) req.set('Idempotency-Key', opts.key);
    const res = await req;
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  const sessionRefOf = (checkoutUrl: unknown): string => {
    const url = String(checkoutUrl ?? '');
    const m = url.match(/sessions\/([A-Za-z0-9_]+)$/);
    if (!m) throw new Error(`URL de paiement inattendue : ${url}`);
    return m[1];
  };

  /** Émission d'un événement simulé (page hébergée : SIGNÉ côté serveur). */
  const completeSimulated = (sessionRef: string, outcome: string) =>
    api()
      .post(`/${GlobalPrefix}/payments/simulated/sessions/${sessionRef}/complete`)
      .send({ outcome });

  /** POST webhook avec corps BRUT et signature HMAC (exactement comme Stripe). */
  async function postWebhook(
    rawBody: string,
    opts: { secret?: string; signature?: string; code?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const signature =
      opts.signature !== undefined
        ? opts.signature
        : opts.secret !== undefined
          ? signStripeWebhook({ rawBody, secret: opts.secret })
          : undefined;
    const req = api()
      .post(`/${GlobalPrefix}/payments/webhook`)
      .set('Content-Type', 'application/json');
    if (signature !== undefined) req.set('stripe-signature', signature);
    req.set('x-provider-code', opts.code ?? 'simulated');
    // Chaîne (et non Buffer) : superagent sérialiserait un Buffer en JSON et la
    // signature porterait alors sur d'autres octets que ceux reçus.
    req.send(rawBody);
    const res = await req;
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  const event = (
    id: string,
    type: string,
    obj: Record<string, unknown>,
  ): string => JSON.stringify({ id, type, livemode: false, data: { object: obj } });

  /** Secret webhook local du simulateur (généré une fois en base). */
  async function simulatedSecret(): Promise<string> {
    const row = await prisma.paymentProviderSetting.findUnique({
      where: { code: 'simulated' },
    });
    if (!row?.webhookSecretEnc) throw new Error('Secret simulateur absent.');
    return crypto.decrypt(row.webhookSecretEnc);
  }

  // ── Boot + fixtures ───────────────────────────────────────────────────────
  beforeAll(async () => {
    // A — aucun prestataire : simulateur EXPLICITEMENT désactivé au démarrage.
    delete process.env[PAYMENT_SIMULATOR_ENABLED_ENV];

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransportFactory)
      .useValue(mailFactoryStub)
      .overrideProvider(PanelTransportFactory)
      .useValue(fakePanelFactory)
      .compile();

    // Corps BRUT conservé : la signature webhook se calcule sur les octets reçus.
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = moduleRef.get(PrismaService);
    limiter = moduleRef.get(SaRateLimiter);
    crypto = moduleRef.get(CryptoService);
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
    await mkUser(adminEmail, Role.ADMIN, 'Admin Stripe');
    await mkUser(aliceEmail, Role.USER, 'Alice Stripe');
    await mkUser(bobEmail, Role.USER, 'Bob Stripe');

    adminToken = await login(adminEmail);
    aliceToken = await login(aliceEmail);
    bobToken = await login(bobEmail);
  });

  beforeEach(() => {
    limiter.reset();
  });

  afterAll(async () => {
    const cards = await prisma.cardPayment.findMany({
      where: { customer: { email: { in: emails } } },
      select: { id: true, reference: true },
    });
    const ids = cards.map((c) => c.id);
    const allRefs = [...new Set([...refs, ...cards.map((c) => c.reference)])];

    await prisma.auditLog
      .deleteMany({
        where: {
          OR: [
            { resourceId: { in: ids } },
            { actorEmail: { in: emails } },
            {
              action: {
                in: ['payment.provider_refund_observed', 'payment.dispute.created'],
              },
              resourceType: 'cardPayment',
            },
          ],
        },
      })
      .catch(() => {});
    await prisma.refund
      .deleteMany({ where: { cardPaymentId: { in: ids } } })
      .catch(() => {});
    await prisma.paymentWebhookEvent
      .deleteMany({
        where: {
          OR: [
            { receivedAt: { gte: startedAt } },
            { cardPaymentId: { in: ids } },
          ],
        },
      })
      .catch(() => {});
    await prisma.cardPayment
      .deleteMany({ where: { id: { in: ids } } })
      .catch(() => {});
    await prisma.walletTransaction
      .deleteMany({ where: { reference: { in: allRefs } } })
      .catch(() => {});
    await prisma.customer.deleteMany({ where: { email: { in: emails } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: emails } } }).catch(() => {});
    await prisma.paymentProviderSetting
      .deleteMany({ where: { code: { in: ['stripe', 'simulated'] } } })
      .catch(() => {});

    delete process.env[PAYMENT_SIMULATOR_ENABLED_ENV];
    delete process.env.ORDER_SWEEP_ENABLED;
    delete process.env.RENEWAL_SWEEP_ENABLED;
    await app.close();
  });

  // ── A — configuration du connecteur ───────────────────────────────────────
  describe('A — configuration connecteur (mode test strict)', () => {
    it('A1 — RBAC : client 403 sur la config ; admin 200 sans secret renvoyé', async () => {
      const asClient = await api()
        .get(`/${GlobalPrefix}/store/admin/payments/provider`)
        .set(auth(aliceToken))
        .expect(403);

      const res = await api()
        .get(`/${GlobalPrefix}/store/admin/payments/provider`)
        .set(auth(adminToken))
        .expect(200);
      expect(res.body.stripe).toBeNull();
      expect(res.body.simulated).toBeNull();
      expect(String(res.body.endpointUrl)).toMatch(/\/api\/payments\/webhook$/);
      expect(JSON.stringify(res.body)).not.toContain('sk_');
      expect(JSON.stringify(res.body)).not.toContain('whsec_');
      void asClient;
    });

    it('A2 — aucun prestataire : création de recharge refusée (409, bouton réellement fonctionnel)', async () => {
      const r = await createTopup(aliceToken, 5000, { key: `a2-${uid}` });
      expect(r.status).toBe(409);
      expect(String((r.body as { message?: string }).message)).toContain(
        'Aucun prestataire de paiement',
      );
    });

    it('A3 — live, clés hors test et activation sans clé sont refusés (400)', async () => {
      await api()
        .put(`/${GlobalPrefix}/store/admin/payments/provider`)
        .set(auth(adminToken))
        .send({
          code: 'stripe',
          displayName: 'Live',
          isActive: true,
          environment: 'live',
        })
        .expect(400);

      await api()
        .put(`/${GlobalPrefix}/store/admin/payments/provider`)
        .set(auth(adminToken))
        .send({
          code: 'stripe',
          displayName: 'Live',
          isActive: true,
          liveEnabled: true,
        })
        .expect(400);

      await api()
        .put(`/${GlobalPrefix}/store/admin/payments/provider`)
        .set(auth(adminToken))
        .send({
          code: 'stripe',
          displayName: 'Mauvaise clé',
          isActive: false,
          secretKey: 'sk_live_123',
        })
        .expect(400);

      await api()
        .put(`/${GlobalPrefix}/store/admin/payments/provider`)
        .set(auth(adminToken))
        .send({
          code: 'stripe',
          displayName: 'Mauvaise clé',
          isActive: false,
          publishableKey: 'pk_live_123',
        })
        .expect(400);

      // Activation impossible sans clé secrète test.
      await api()
        .put(`/${GlobalPrefix}/store/admin/payments/provider`)
        .set(auth(adminToken))
        .send({ code: 'stripe', displayName: 'Actif sans clé', isActive: true })
        .expect(400);
    });

    it('A4 — enregistrement test : secrets écrits-seuls, jamais relus en clair', async () => {
      const res = await api()
        .put(`/${GlobalPrefix}/store/admin/payments/provider`)
        .set(auth(adminToken))
        .send({
          code: 'stripe',
          displayName: 'Stripe (test)',
          isActive: false,
          merchantAccount: 'acct_test_1',
          publishableKey: 'pk_test_51Demo',
          secretKey: 'sk_test_51DemoSecret',
          allowedCurrencies: ['USD', 'EUR'],
        })
        .expect(200);

      expect(res.body.hasSecretKey).toBe(true);
      expect(res.body.hasWebhookSecret).toBe(false);
      expect(res.body.environment).toBe('test');
      expect(res.body.liveEnabled).toBe(false);
      // Clé PUBLIQUE renvoyée volontairement (usage checkout côté navigateur) ;
      // seules les valeurs secrètes doivent être absentes.
      expect(res.body.publishableKey).toBe('pk_test_51Demo');
      expect(JSON.stringify(res.body)).not.toContain('sk_test_51DemoSecret');

      const detail = await api()
        .get(`/${GlobalPrefix}/store/admin/payments/provider`)
        .set(auth(adminToken))
        .expect(200);
      expect(JSON.stringify(detail.body)).not.toContain('sk_test_51DemoSecret');
    });

    it('A5 — sans secret webhook : contrôle de connexion expose l’échec (pas de « OK » silencieux)', async () => {
      // Stripe existe mais est inactif → repli sur le simulateur (désactivé) → échec visible.
      const res = await api()
        .post(`/${GlobalPrefix}/store/admin/payments/provider/check`)
        .set(auth(adminToken))
        .expect(201);
      expect(res.body.lastCheckError).toBeTruthy();
      expect(res.body.lastCheckAt).toBeTruthy();
    });
  });

  // ── B — sessions de recharge ──────────────────────────────────────────────
  describe('B — sessions de recharge (simulateur de recette)', () => {
    beforeAll(() => {
      process.env[PAYMENT_SIMULATOR_ENABLED_ENV] = 'true';
    });

    it('B0 — devise du portefeuille lue en base (mono-devise assumée)', async () => {
      await createTopup(aliceToken, 100, { key: `b0-${uid}` });
      const c = await prisma.customer.findUnique({ where: { email: aliceEmail } });
      expect(c).toBeTruthy();
      walletCurrency = (c?.walletCurrency ?? 'USD').toUpperCase();
      expect(['USD', 'EUR']).toContain(walletCurrency);
    });

    it('B1 — 401 anonyme sur la création et sur la consultation', async () => {
      await api().post(`/${GlobalPrefix}/client/payments/topups`).send({ amountCents: 5000 }).expect(401);
      await api().get(`/${GlobalPrefix}/client/payments/topups/CDP-NOPE`).expect(401);
    });

    it('B2 — session créée : référence CDP, URL hébergée, statut CREATED', async () => {
      const r = await createTopup(aliceToken, 5000, { key: `b2-${uid}` });
      expect(r.status).toBe(201);
      expect(String(r.body.reference)).toMatch(/^CDP-/);
      expect(r.body.status).toBe('CREATED');
      expect(r.body.currency).toBe(walletCurrency);
      expect(r.body.amountCents).toBe(5000);
      expect(String(r.body.checkoutUrl)).toContain('/api/payments/simulated/sessions/');
      refs.push(String(r.body.reference));
    });

    it('B3 — idempotence : même clé = MÊME session (aucun second paiement ouvert)', async () => {
      const key = `b3-${uid}`;
      const first = await createTopup(aliceToken, 5000, { key });
      const second = await createTopup(aliceToken, 5000, { key });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.reference).toBe(first.body.reference);
      refs.push(String(first.body.reference));

      const rows = await prisma.cardPayment.count({ where: { idempotencyKey: key } });
      expect(rows).toBe(1);

      // Clé réutilisée pour un AUTRE montant = conflit explicite.
      const mismatch = await createTopup(aliceToken, 6000, { key });
      expect(mismatch.status).toBe(409);
    });

    it('B4 — clés d’idempotence invalides refusées (400)', async () => {
      const short = await createTopup(aliceToken, 5000, { key: 'abc' });
      expect(short.status).toBe(400);
      const chars = await createTopup(aliceToken, 5000, { key: 'clé avec espace!' });
      expect(chars.status).toBe(400);
    });

    it('B5 — montants hors bornes refusés (400)', async () => {
      expect((await createTopup(aliceToken, 99, { key: `b5a-${uid}` })).status).toBe(400);
      expect((await createTopup(aliceToken, 0, { key: `b5b-${uid}` })).status).toBe(400);
      expect((await createTopup(aliceToken, 10_000_001, { key: `b5c-${uid}` })).status).toBe(400);
    });

    it('B6 — devise ≠ devise du portefeuille refusée (409, aucun change automatique)', async () => {
      const other = walletCurrency === 'USD' ? 'EUR' : 'USD';
      const r = await createTopup(aliceToken, 5000, { key: `b6-${uid}`, currency: other });
      expect(r.status).toBe(409);
      expect(String((r.body as { message?: string }).message)).toContain('refusée');
    });

    it('B7 — isolation : Bob ne voit pas la référence d’Alice (404)', async () => {
      const mine = await createTopup(aliceToken, 5000, { key: `b7-${uid}` });
      const reference = String(mine.body.reference);
      refs.push(reference);
      await api()
        .get(`/${GlobalPrefix}/client/payments/topups/${reference}`)
        .set(auth(bobToken))
        .expect(404);
      await api()
        .post(`/${GlobalPrefix}/client/payments/topups/${reference}/refresh`)
        .set(auth(bobToken))
        .expect(404);
      await api()
        .get(`/${GlobalPrefix}/client/payments/topups/${reference}`)
        .set(auth(aliceToken))
        .expect(200);
    });

    it('B8 — RBAC : un client n’accède à aucune route d’administration', async () => {
      await api()
        .get(`/${GlobalPrefix}/store/admin/payments/card-payments`)
        .set(auth(aliceToken))
        .expect(403);
      await api()
        .get(`/${GlobalPrefix}/store/admin/payments/webhook-events`)
        .set(auth(aliceToken))
        .expect(403);
      await api()
        .get(`/${GlobalPrefix}/store/admin/payments/provider`)
        .set(auth(bobToken))
        .expect(403);
    });
  });

  // ── C — paiement abouti : crédit exactement une fois ───────────────────────
  describe('C — paiement simulé → crédit unique', () => {
    let secret = '';

    beforeAll(async () => {
      secret = await simulatedSecret();
    });

    it('C1 — événement signé → SUCCEEDED + crédit = montant, UNE fois', async () => {
      const before = await balanceOf(aliceEmail);
      const created = await createTopup(aliceToken, 5000, { key: `c1-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);
      const sessionRef = sessionRefOf(created.body.checkoutUrl);

      const res = await completeSimulated(sessionRef, 'success');
      expect(res.status).toBe(200);
      expect(res.body.providerResult).toMatchObject({ received: true, result: 'processed' });

      const row = await paymentRow(reference);
      expect(row?.status).toBe('SUCCEEDED');
      expect(row?.paidAt).toBeTruthy();
      expect(row?.livemode).toBe(false);

      const after = await balanceOf(aliceEmail);
      expect(after - before).toBe(5000);

      const tx = await prisma.walletTransaction.findUnique({
        where: { idempotencyKey: `cardpay:${row?.id}` },
      });
      expect(tx?.type).toBe('CREDIT');
      expect(tx?.amountCents).toBe(5000);
      expect(tx?.reference).toBe(reference);

      // Plus de lien de paiement après confirmation (l'état suffit).
      const view = await api()
        .get(`/${GlobalPrefix}/client/payments/topups/${reference}`)
        .set(auth(aliceToken))
        .expect(200);
      expect(view.body.status).toBe('SUCCEEDED');
      expect(view.body.checkoutUrl).toBeNull();
    });

    it('C2 — seconde tentative sur une session clos : refus net (404)', async () => {
      const created = await createTopup(aliceToken, 5000, { key: `c2-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);
      const sessionRef = sessionRefOf(created.body.checkoutUrl);
      await completeSimulated(sessionRef, 'success').expect(200);
      const again = await completeSimulated(sessionRef, 'success');
      expect(again.status).toBe(404);
    });

    it('C3 — rejeu du MÊME événement : doublon acquitté, zéro second crédit', async () => {
      const before = await balanceOf(aliceEmail);
      const created = await createTopup(aliceToken, 5000, { key: `c3-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);
      const row = await paymentRow(reference);

      const payload = event('evt_dup_test', 'checkout.session.completed', {
        id: row?.providerSessionRef,
        payment_intent: row?.providerPaymentRef,
        payment_status: 'paid',
        amount_total: 5000,
        currency: walletCurrency.toLowerCase(),
        livemode: false,
      });

      const first = await postWebhook(payload, { secret });
      expect(first.status).toBe(200);
      expect(first.body.result).toBe('processed');

      const second = await postWebhook(payload, { secret });
      expect(second.status).toBe(200);
      expect(second.body.duplicate).toBe(true);

      expect((await balanceOf(aliceEmail)) - before).toBe(5000);
      expect((await paymentRow(reference))?.status).toBe('SUCCEEDED');
    });

    it('C4 — relecture serveur (refresh) idempotente après crédit', async () => {
      const before = await balanceOf(aliceEmail);
      const created = await createTopup(aliceToken, 5000, { key: `c4-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);
      const sessionRef = sessionRefOf(created.body.checkoutUrl);
      await completeSimulated(sessionRef, 'success');

      const r1 = await api()
        .post(`/${GlobalPrefix}/client/payments/topups/${reference}/refresh`)
        .set(auth(aliceToken))
        .expect(201);
      const r2 = await api()
        .post(`/${GlobalPrefix}/client/payments/topups/${reference}/refresh`)
        .set(auth(aliceToken))
        .expect(201);
      expect(r1.body.status).toBe('SUCCEEDED');
      expect(r2.body.status).toBe('SUCCEEDED');
      expect((await balanceOf(aliceEmail)) - before).toBe(5000);
    });

    it('C5 — concurrence : deux confirmations parallèles → UN seul crédit', async () => {
      const before = await balanceOf(aliceEmail);
      const created = await createTopup(aliceToken, 5000, { key: `c5-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);
      const row = await paymentRow(reference);

      const mk = (id: string) =>
        event(id, 'checkout.session.completed', {
          id: row?.providerSessionRef,
          payment_intent: row?.providerPaymentRef,
          payment_status: 'paid',
          amount_total: 5000,
          currency: walletCurrency.toLowerCase(),
          livemode: false,
        });

      const [a, b] = await Promise.all([
        postWebhook(mk('evt_race_a'), { secret }),
        postWebhook(mk('evt_race_b'), { secret }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect([a.body.result, b.body.result]).toContain('processed');

      expect((await balanceOf(aliceEmail)) - before).toBe(5000);
      expect((await paymentRow(reference))?.status).toBe('SUCCEEDED');
    });
  });

  // ── D — refus, expiration, contradictions ─────────────────────────────────
  describe('D — refus / expiration : zéro crédit', () => {
    it('D1 — refus de carte : FAILED + message, solde inchangé', async () => {
      const before = await balanceOf(aliceEmail);
      const created = await createTopup(aliceToken, 5000, { key: `d1-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);

      const res = await completeSimulated(sessionRefOf(created.body.checkoutUrl), 'failed');
      expect(res.status).toBe(200);

      const row = await paymentRow(reference);
      expect(row?.status).toBe('FAILED');
      expect(String(row?.failureMessage)).toContain('refusée');
      expect((await balanceOf(aliceEmail)) - before).toBe(0);
    });

    it('D2 — expiration : EXPIRED, solde inchangé, aucun lien de paiement', async () => {
      const before = await balanceOf(aliceEmail);
      const created = await createTopup(aliceToken, 5000, { key: `d2-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);

      await completeSimulated(sessionRefOf(created.body.checkoutUrl), 'expired');
      expect((await paymentRow(reference))?.status).toBe('EXPIRED');
      expect((await balanceOf(aliceEmail)) - before).toBe(0);
    });

    it('D3 — succès reçu APRÈS un échec tranché : contradiction signalée, aucun crédit tardif', async () => {
      const before = await balanceOf(aliceEmail);
      const created = await createTopup(aliceToken, 5000, { key: `d3-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);
      const sessionRef = sessionRefOf(created.body.checkoutUrl);
      await completeSimulated(sessionRef, 'failed');

      const secret = await simulatedSecret();
      const row = await paymentRow(reference);
      const res = await postWebhook(
        event('evt_late_success', 'checkout.session.completed', {
          id: row?.providerSessionRef,
          payment_intent: row?.providerPaymentRef,
          payment_status: 'paid',
          amount_total: 5000,
          currency: walletCurrency.toLowerCase(),
          livemode: false,
        }),
        { secret },
      );
      expect(res.status).toBe(200);

      const fresh = await paymentRow(reference);
      expect(fresh?.status).toBe('FAILED');
      expect(fresh?.interventionNeeded).toBe(true);
      expect((await balanceOf(aliceEmail)) - before).toBe(0);
    });
  });

  // ── E — signature webhook (corps brut) ────────────────────────────────────
  describe('E — signature et durcissement du webhook', () => {
    let secret = '';
    beforeAll(async () => {
      secret = await simulatedSecret();
    });

    it('E1 — signature invalide → 401 (aucun traitement)', async () => {
      const res = await postWebhook(
        event('evt_bad_sig', 'checkout.session.completed', { id: 'cs_x' }),
        { signature: 't=1,v1=deadbeef' },
      );
      expect(res.status).toBe(401);
      const row = await prisma.paymentWebhookEvent.findUnique({
        where: { providerCode_eventId: { providerCode: 'simulated', eventId: 'evt_bad_sig' } },
      });
      expect(row).toBeNull();
    });

    it('E2 — en-tête de signature absent → 401', async () => {
      const res = await postWebhook(event('evt_no_sig', 'checkout.session.completed', { id: 'cs_x' }), {});
      expect(res.status).toBe(401);
    });

    it('E3 — secret du MAUvais prestataire → 401 (pas de « default OK »)', async () => {
      const res = await postWebhook(
        event('evt_wrong_provider', 'checkout.session.completed', { id: 'cs_x' }),
        { secret: 'whsec_wrong_provider_secret', code: 'simulated' },
      );
      expect(res.status).toBe(401);
    });

    it('E4 — corps brut absent/illisible : 400 signé ou 400 JSON cassé', async () => {
      const garbage = 'ceci n\'est pas du json';
      const res = await postWebhook(garbage, { secret });
      expect(res.status).toBe(400);
    });

    it('E5 — événement sans id/type → 400 (jamais traité)', async () => {
      const res = await postWebhook(JSON.stringify({ foo: 'bar' }), { secret });
      expect(res.status).toBe(400);
      const row = await prisma.paymentWebhookEvent.findFirst({
        where: { providerCode: 'simulated', eventId: '' },
      });
      expect(row).toBeNull();
    });

    it('E6 — type inconnu : acquitté 200 « ignored », aucun effet métier', async () => {
      const res = await postWebhook(
        event('evt_unknown_type', 'invoice.paid', { id: 'in_x' }),
        { secret },
      );
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('ignored');
      const row = await prisma.paymentWebhookEvent.findUnique({
        where: {
          providerCode_eventId: { providerCode: 'simulated', eventId: 'evt_unknown_type' },
        },
      });
      expect(row?.status).toBe('IGNORED');
    });

    it('E7 — Stripe SANS secret webhook configuré → 503 explicite (rejeu après config)', async () => {
      const res = await postWebhook(
        event('evt_stripe_nosecret', 'checkout.session.completed', { id: 'cs_x' }),
        { secret: 'whsec_whatever', code: 'stripe' },
      );
      expect(res.status).toBe(503);
      expect(res.body.reason).toBe('webhook_secret_not_configured');
    });

    it('E8 — une fois le secret enregistré : mauvaise signature 401, bonne 200', async () => {
      await api()
        .put(`/${GlobalPrefix}/store/admin/payments/provider`)
        .set(auth(adminToken))
        .send({
          code: 'stripe',
          displayName: 'Stripe (test)',
          isActive: false,
          webhookSecret: 'whsec_test_stripe_secret',
        })
        .expect(200);

      const bad = await postWebhook(
        event('evt_stripe_bad', 'checkout.session.completed', { id: 'cs_x' }),
        { secret: 'whsec_other_secret', code: 'stripe' },
      );
      expect(bad.status).toBe(401);

      const good = await postWebhook(
        event('evt_stripe_good', 'customer.updated', { id: 'cus_x' }),
        { secret: 'whsec_test_stripe_secret', code: 'stripe' },
      );
      expect(good.status).toBe(200);
      expect(good.body.result).toBe('ignored');
    });
  });

  // ── F — incohérence → intervention ────────────────────────────────────────
  describe('F — incohérence montant : NEEDS_REVIEW, aucun crédit', () => {
    it('F1 — montant différent du paiement → NEEDS_REVIEW + signalement', async () => {
      const before = await balanceOf(aliceEmail);
      const created = await createTopup(aliceToken, 5000, { key: `f1-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);
      const row = await paymentRow(reference);
      const secret = await simulatedSecret();

      const res = await postWebhook(
        event('evt_amount_mismatch', 'checkout.session.completed', {
          id: row?.providerSessionRef,
          payment_intent: row?.providerPaymentRef,
          payment_status: 'paid',
          amount_total: 4999,
          currency: walletCurrency.toLowerCase(),
          livemode: false,
        }),
        { secret },
      );
      expect(res.status).toBe(200);

      const fresh = await paymentRow(reference);
      expect(fresh?.status).toBe('NEEDS_REVIEW');
      expect(fresh?.interventionNeeded).toBe(true);
      expect(String(fresh?.interventionReason)).toContain('montant');
      expect((await balanceOf(aliceEmail)) - before).toBe(0);
    });

    it('F2 — détail admin visible ; levée après vérification (statut conservé)', async () => {
      const created = await createTopup(aliceToken, 5000, { key: `f2-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);
      const row = await paymentRow(reference);
      const secret = await simulatedSecret();
      await postWebhook(
        event('evt_live_mode', 'checkout.session.completed', {
          id: row?.providerSessionRef,
          payment_intent: row?.providerPaymentRef,
          payment_status: 'paid',
          amount_total: 5000,
          currency: walletCurrency.toLowerCase(),
          livemode: true, // LIVE détecté en mode test
        }),
        { secret },
      );
      const flagged = await paymentRow(reference);
      expect(flagged?.status).toBe('NEEDS_REVIEW');
      expect(String(flagged?.interventionReason)).toContain('LIVE');

      const detail = await api()
        .get(`/${GlobalPrefix}/store/admin/payments/card-payments/${row?.id}`)
        .set(auth(adminToken))
        .expect(200);
      expect(detail.body.interventionNeeded).toBe(true);
      expect(detail.body.refunds).toEqual([]);
      expect(detail.body.events.length).toBeGreaterThanOrEqual(1);

      await api()
        .post(`/${GlobalPrefix}/store/admin/payments/card-payments/${row?.id}/intervention`)
        .set(auth(adminToken))
        .send({ note: 'Vérifié manuellement : montant et compte conformes.' })
        .expect(201);

      const resolved = await paymentRow(reference);
      expect(resolved?.status).toBe('NEEDS_REVIEW'); // jamais « re-crédité »
      expect(resolved?.interventionNeeded).toBe(false);

      // Seconde levée sans signalement = 409 (aucune action vide).
      await api()
        .post(`/${GlobalPrefix}/store/admin/payments/card-payments/${row?.id}/intervention`)
        .set(auth(adminToken))
        .send({ note: 'Encore vérifié.' })
        .expect(409);
    });

    it('F3 — remboursement refusé sur un paiement non encaissé (409)', async () => {
      const created = await createTopup(aliceToken, 5000, { key: `f3-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);
      const row = await paymentRow(reference);
      await api()
        .post(`/${GlobalPrefix}/store/admin/payments/card-payments/${row?.id}/refunds`)
        .set(auth(adminToken))
        .set('Idempotency-Key', `f3-${uid}`)
        .send({ amountCents: 100 })
        .expect(409);
    });
  });

  // ── G — remboursements ────────────────────────────────────────────────────
  describe('G — remboursements de recharge vers la carte', () => {
    let paidRef = '';
    let paidId = '';

    beforeAll(async () => {
      const created = await createTopup(aliceToken, 5000, { key: `g-${uid}` });
      paidRef = String(created.body.reference);
      refs.push(paidRef);
      await completeSimulated(sessionRefOf(created.body.checkoutUrl), 'success');
      const row = await paymentRow(paidRef);
      paidId = row?.id ?? '';
      expect(row?.status).toBe('SUCCEEDED');
    });

    it('G1 — remboursement partiel : plafond, débit wallet, statut partiel', async () => {
      const before = await balanceOf(aliceEmail);
      const res = await api()
        .post(`/${GlobalPrefix}/store/admin/payments/card-payments/${paidId}/refunds`)
        .set(auth(adminToken))
        .set('Idempotency-Key', `g1-${uid}`)
        .send({ amountCents: 1000, reason: 'Demande client' })
        .expect(201);

      expect(res.body.status).toBe('SUCCEEDED');
      expect(String(res.body.providerRef)).toMatch(/^re_sim_/);
      expect(res.body.kind).toBe('EXTERNAL_CARD');
      expect((await balanceOf(aliceEmail)) - before).toBe(-1000);

      const row = await paymentRow(paidRef);
      expect(row?.refundedCents).toBe(1000);
      expect(row?.status).toBe('PARTIALLY_REFUNDED');
    });

    it('G2 — rejeu avec la MÊME clé : aucun second remboursement ni second débit', async () => {
      const before = await balanceOf(aliceEmail);
      const res = await api()
        .post(`/${GlobalPrefix}/store/admin/payments/card-payments/${paidId}/refunds`)
        .set(auth(adminToken))
        .set('Idempotency-Key', `g1-${uid}`)
        .send({ amountCents: 1000, reason: 'Demande client' })
        .expect(201);
      expect(res.body.amountCents).toBe(1000);
      expect((await balanceOf(aliceEmail)) - before).toBe(0);

      const count = await prisma.refund.count({
        where: { cardPaymentId: paidId, idempotencyKey: `g1-${uid}` },
      });
      expect(count).toBe(1);
    });

    it('G3 — plafond dépassé → 409 explicite (encaissé / engagé / demandé)', async () => {
      const res = await api()
        .post(`/${GlobalPrefix}/store/admin/payments/card-payments/${paidId}/refunds`)
        .set(auth(adminToken))
        .set('Idempotency-Key', `g3-${uid}`)
        .send({ amountCents: 4001 })
        .expect(409);
      expect(String(res.body.message)).toContain('Plafond de remboursement dépassé');
    });

    it('G4 — solde déjà dépensé → REFUS explicite, jamais de dette implicite', async () => {
      // Bob : recharge créditée puis solde dépensé artificiellement (fixture).
      const created = await createTopup(bobToken, 5000, { key: `g4-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);
      await completeSimulated(sessionRefOf(created.body.checkoutUrl), 'success');
      const row = await paymentRow(reference);
      await prisma.customer.update({
        where: { email: bobEmail },
        data: { walletBalanceCents: 100 },
      });

      const res = await api()
        .post(`/${GlobalPrefix}/store/admin/payments/card-payments/${row?.id}/refunds`)
        .set(auth(adminToken))
        .set('Idempotency-Key', `g4-${uid}`)
        .send({ amountCents: 5000 })
        .expect(409);
      expect(String(res.body.message)).toContain('déjà été dépensé');
      expect((await balanceOf(bobEmail))).toBe(100);

      // Aucune intention orpheline créée.
      const count = await prisma.refund.count({ where: { cardPaymentId: row?.id } });
      expect(count).toBe(0);
    });

    it('G5 — remboursement restant → REFUNDED puis refus supplémentaire (409)', async () => {
      const before = await balanceOf(aliceEmail);
      const res = await api()
        .post(`/${GlobalPrefix}/store/admin/payments/card-payments/${paidId}/refunds`)
        .set(auth(adminToken))
        .set('Idempotency-Key', `g5-${uid}`)
        .send({ amountCents: 4000 })
        .expect(201);
      expect(res.body.status).toBe('SUCCEEDED');
      expect((await balanceOf(aliceEmail)) - before).toBe(-4000);

      const row = await paymentRow(paidRef);
      expect(row?.refundedCents).toBe(5000);
      expect(row?.status).toBe('REFUNDED');

      await api()
        .post(`/${GlobalPrefix}/store/admin/payments/card-payments/${paidId}/refunds`)
        .set(auth(adminToken))
        .set('Idempotency-Key', `g5b-${uid}`)
        .send({ amountCents: 100 })
        .expect(409);

      // Relance / annulation impossibles hors PENDING.
      const refunds = await prisma.refund.findMany({
        where: { cardPaymentId: paidId },
        select: { id: true },
      });
      await api()
        .post(`/${GlobalPrefix}/store/admin/payments/refunds/${refunds[0].id}/retry`)
        .set(auth(adminToken))
        .expect(409);
      await api()
        .post(`/${GlobalPrefix}/store/admin/payments/refunds/${refunds[0].id}/cancel`)
        .set(auth(adminToken))
        .send({ reason: 'Rien à annuler.' })
        .expect(409);
    });

    it('G6 — RBAC : un client ne peut pas rembourser', async () => {
      await api()
        .post(`/${GlobalPrefix}/store/admin/payments/card-payments/${paidId}/refunds`)
        .set(auth(aliceToken))
        .send({ amountCents: 100 })
        .expect(403);
    });

    it('G7 — détail admin : remboursements + événements rattachés', async () => {
      const detail = await api()
        .get(`/${GlobalPrefix}/store/admin/payments/card-payments/${paidId}`)
        .set(auth(adminToken))
        .expect(200);
      expect(detail.body.refunds.length).toBeGreaterThanOrEqual(2);
      expect(detail.body.refunds.every((r: { kind: string }) => r.kind === 'EXTERNAL_CARD')).toBe(true);
      expect(detail.body.refundedCents).toBe(5000);
      expect(JSON.stringify(detail.body)).not.toContain('sk_test_');
    });
  });

  // ── H — litige & remboursement hors plateforme ────────────────────────────
  describe('H — litige et remboursement constaté hors plateforme', () => {
    it('H1 — litige : signalement + solde INCHANGÉ (traitement conservateur)', async () => {
      const before = await balanceOf(aliceEmail);
      const created = await createTopup(aliceToken, 5000, { key: `h1-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);
      await completeSimulated(sessionRefOf(created.body.checkoutUrl), 'success');
      expect((await balanceOf(aliceEmail)) - before).toBe(5000);

      const row = await paymentRow(reference);
      const secret = await simulatedSecret();
      const res = await postWebhook(
        event('evt_dispute_1', 'charge.dispute.created', {
          id: 'dp_123',
          payment_intent: row?.providerPaymentRef,
          reason: 'fraudulent',
        }),
        { secret },
      );
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('processed');

      const fresh = await paymentRow(reference);
      expect(fresh?.disputedAt).toBeTruthy();
      expect(fresh?.interventionNeeded).toBe(true);
      expect((await balanceOf(aliceEmail)) - before).toBe(5000); // aucun débit automatique

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'payment.dispute.created', resourceId: row?.id },
      });
      expect(audit).toBeTruthy();
    });

    it('H2 — charge.refunded hors plateforme : état aligné + intervention (zéro modification silencieuse)', async () => {
      const before = await balanceOf(aliceEmail);
      const created = await createTopup(aliceToken, 5000, { key: `h2-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);
      await completeSimulated(sessionRefOf(created.body.checkoutUrl), 'success');

      const row = await paymentRow(reference);
      const secret = await simulatedSecret();
      const res = await postWebhook(
        event('evt_refund_external', 'charge.refunded', {
          id: 'ch_1',
          payment_intent: row?.providerPaymentRef,
          amount_refunded: 5000,
          refunds: { data: [{ id: 're_external_1' }] },
        }),
        { secret },
      );
      expect(res.status).toBe(200);

      const fresh = await paymentRow(reference);
      expect(fresh?.status).toBe('REFUNDED');
      expect(fresh?.refundedCents).toBe(5000);
      expect(fresh?.interventionNeeded).toBe(true);
      expect(String(fresh?.interventionReason)).toContain('hors plateforme');
      expect((await balanceOf(aliceEmail)) - before).toBe(5000); // wallet NON touché

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'payment.provider_refund_observed', resourceId: row?.id },
      });
      expect(audit).toBeTruthy();
    });

    it('H3 — recherche admin par référence prestataire + liste des événements', async () => {
      const created = await createTopup(aliceToken, 5000, { key: `h3-${uid}` });
      const reference = String(created.body.reference);
      refs.push(reference);
      const row = await paymentRow(reference);

      const byProviderRef = await api()
        .get(`/${GlobalPrefix}/store/admin/payments/card-payments`)
        .query({ q: row?.providerPaymentRef })
        .set(auth(adminToken))
        .expect(200);
      expect(
        byProviderRef.body.items.some((i: { reference: string }) => i.reference === reference),
      ).toBe(true);

      const byEmail = await api()
        .get(`/${GlobalPrefix}/store/admin/payments/card-payments`)
        .query({ q: aliceEmail, status: 'CREATED' })
        .set(auth(adminToken))
        .expect(200);
      expect(byEmail.body.total).toBeGreaterThanOrEqual(1);

      const events = await api()
        .get(`/${GlobalPrefix}/store/admin/payments/webhook-events`)
        .set(auth(adminToken))
        .expect(200);
      expect(events.body.total).toBeGreaterThanOrEqual(1);
      expect(typeof events.body.failed).toBe('number');
      expect(JSON.stringify(events.body)).not.toContain('sk_test_');
      expect(JSON.stringify(events.body)).not.toContain('whsec_');
    });

    it('H4 — aucune clé secrète n’apparaît dans la configuration admin (réponse complète)', async () => {
      const res = await api()
        .get(`/${GlobalPrefix}/store/admin/payments/provider`)
        .set(auth(adminToken))
        .expect(200);
      const raw = JSON.stringify(res.body);
      // Absence des VALEURS secrètes (le texte d'aide « sk_test_ / whsec_ »
      // de lastCheckError n'est pas une clé).
      expect(raw).not.toContain('sk_test_51DemoSecret');
      expect(raw).not.toContain('whsec_test_stripe_secret');
      expect(res.body.stripe.hasSecretKey).toBe(true);
      expect(res.body.stripe.hasWebhookSecret).toBe(true);
    });
  });
});

