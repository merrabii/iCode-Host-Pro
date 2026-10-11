import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import request = require('supertest');
import { CardPaymentStatus, RefundKind, RefundStatus, Role } from '@prisma/client';
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
import { PaymentProviderService } from './../src/payments/payment-provider.service';

// Sweep (timer) OFF : aucune ligne de ce test n'en dépend.
process.env.ORDER_SWEEP_ENABLED = 'false';
process.env.RENEWAL_SWEEP_ENABLED = 'false';

/**
 * GO clôture §2 + §4 (e2e) — comptabilisation UNITAIRE des remboursements et
 * blocage des encaissements sur résultat non établi.
 *
 *  §2 — la règle `max` monotone (courant ∪ internes soldés ∪ plancher
 *       prestataire) : 1 000 reste 1 000 quel que soit le nombre de sources
 *       (réponse API, `charge.refunded`, `refund.*`, rejeux, concurrence) ;
 *       un remboursement inconnu `pending`/`failed`/`canceled` n'entre
 *       JAMAIS dans le compteur ; seul `succeeded` y entre (plancher) ;
 *       un dépassement devient NEEDS_REVIEW (jamais lissé).
 *  §4 — `dispatchedAt` premier envoi IMMUABLE ; simulateur déterministe
 *       (reprise = MÊME session, y compris après « redémarrage ») ; un
 *       UNCERTAIN/NEEDS_REVIEW bloquant empêche tout NOUVEL encaissement
 *       du client jusqu'à la reprise ou à la levée d'alerte admin.
 *
 * Aucun réseau réel : connecteur SIMULÉ + Mail/Panel stubbés ; PrismaService
 * RÉEL sur la base dédiée du chantier (icode_host_pro_socle).
 */
describe('Comptabilisation remboursements & blocage encaissement (e2e, GO §2/§4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;
  let crypto: CryptoService;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const adminEmail = `ra_admin_${uid}@example.com`;
  const clientEmail = `ra_client_${uid}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let clientToken = '';

  const emails = [adminEmail, clientEmail];
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

  const paymentRow = (reference: string) =>
    prisma.cardPayment.findUnique({ where: { reference } });

  async function createTopup(
    amountCents: number,
    key: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await api()
      .post(`/${GlobalPrefix}/client/payments/topups`)
      .set(auth(clientToken))
      .set('Idempotency-Key', key)
      .send({ amountCents });
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  const sessionRefOf = (checkoutUrl: unknown): string => {
    const url = String(checkoutUrl ?? '');
    const m = url.match(/sessions\/([A-Za-z0-9_]+)$/);
    if (!m) throw new Error(`URL de paiement inattendue : ${url}`);
    return m[1];
  };

  const completeSimulated = (sessionRef: string, outcome: string) =>
    api()
      .post(`/${GlobalPrefix}/payments/simulated/sessions/${sessionRef}/complete`)
      .send({ outcome });

  /** Recharge ENCAISSÉE (simulateur) : SUCCEEDED + crédit wallet. */
  async function settledTopup(
    amountCents: number,
    key: string,
  ): Promise<{ reference: string; id: string; paymentRef: string | null }> {
    const opened = await createTopup(amountCents, key);
    if (opened.status !== 201 && opened.status !== 200) {
      throw new Error(`ouverture recharge ${opened.status} : ${JSON.stringify(opened.body)}`);
    }
    await completeSimulated(sessionRefOf(opened.body.checkoutUrl), 'success');
    const row = await paymentRow(String(opened.body.reference));
    if (!row || row.status !== CardPaymentStatus.SUCCEEDED) {
      throw new Error(`recharge non encaissée (${row?.status ?? 'absente'})`);
    }
    return { reference: row.reference, id: row.id, paymentRef: row.providerPaymentRef };
  }

  /** Remboursement carte ADMIN (Idempotency-Key requis). */
  const adminRefund = (cardPaymentId: string, amountCents: number, key: string) =>
    api()
      .post(`/${GlobalPrefix}/store/admin/payments/card-payments/${cardPaymentId}/refunds`)
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({ amountCents, reason: 'GO §2 test' });

  const resolveIntervention = (cardPaymentId: string, note: string) =>
    api()
      .post(`/${GlobalPrefix}/store/admin/payments/card-payments/${cardPaymentId}/intervention`)
      .set(auth(adminToken))
      .send({ note });

  async function postWebhook(
    rawBody: string,
    secret: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await api()
      .post(`/${GlobalPrefix}/payments/webhook`)
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signStripeWebhook({ rawBody, secret }))
      .set('x-provider-code', 'simulated')
      .send(rawBody);
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  const event = (id: string, type: string, obj: Record<string, unknown>): string =>
    JSON.stringify({ id, type, livemode: false, data: { object: obj } });

  /** `charge.refunded` : plancher observé du PRESTATAIRE (amount_refunded). */
  const chargeRefunded = (
    evtId: string,
    paymentRef: string,
    amountRefundedCents: number,
    refundIds: string[] = [],
  ) =>
    postWebhook(
      event(evtId, 'charge.refunded', {
        id: `ch_${evtId}`,
        object: 'charge',
        payment_intent: paymentRef,
        amount_refunded: amountRefundedCents,
        refunds: { data: refundIds.map((id) => ({ id })) },
      }),
      secret,
    );

  /**
   * `refund.*` : un remboursement INCONNU n'est rattaché au paiement que par
   * `payment_intent` (la référence locale n'existe pas encore) — indispensable
   * pour les scénarios « webhook avant persistance » (§2.2) et « inconnu non
   * soldé » (§2.5). Un remboursement CONNU est acquitté par `providerRef`.
   */
  const refundEvent = (
    evtId: string,
    type: 'refund.created' | 'refund.updated' | 'refund.failed' | 'refund.canceled',
    providerRef: string,
    amountCents: number,
    status: string,
    paymentRef?: string,
  ) =>
    postWebhook(
      event(evtId, type, {
        id: providerRef,
        object: 'refund',
        ...(paymentRef ? { payment_intent: paymentRef } : {}),
        amount: amountCents,
        status,
      }),
      secret,
    );

  /** §4.5 — référence prestataire DÉTERMINISTE que le simulateur produira. */
  const simulatedRefundRef = (idempotencyKey: string) =>
    `re_sim_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 20)}`;

  let secret = '';

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
    crypto = moduleRef.get(CryptoService);
    limiter.reset();

    // §4.5 — materialise la configuration « simulated » (secret inclus) AVANT
    // toute lecture : la ligne n'est créée paresseusement qu'au premier
    // `resolve()` du fournisseur de paiement.
    await moduleRef.get(PaymentProviderService).resolve();

    await prisma.paymentSettings.upsert({
      where: { id: 'singleton' },
      // Ne touche PAS `cardOrderPaymentEnabled` (partagé avec d'autres suites).
      update: { walletPaymentEnabled: true, cardTopupEnabled: true },
      create: { id: 'singleton', walletPaymentEnabled: true, cardTopupEnabled: true },
    });

    await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Admin Refund Accounting',
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
      },
    });
    await prisma.user.create({
      data: {
        email: clientEmail,
        name: 'Client Refund Accounting',
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.USER,
      },
    });
    adminToken = await login(adminEmail);
    clientToken = await login(clientEmail);

    const row = await prisma.paymentProviderSetting.findUnique({
      where: { code: 'simulated' },
    });
    if (!row?.webhookSecretEnc) throw new Error('Secret simulateur absent.');
    secret = crypto.decrypt(row.webhookSecretEnc);
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
    const refundRows = await prisma.refund.findMany({
      where: { cardPaymentId: { in: ids } },
      select: { id: true },
    });
    await prisma.paymentWebhookEvent.deleteMany({
      where: { OR: [{ cardPaymentId: { in: ids } }, { eventId: { contains: uid } }] },
    });
    await prisma.refund.deleteMany({ where: { id: { in: refundRows.map((r) => r.id) } } });
    await prisma.cardPayment.deleteMany({ where: { id: { in: ids } } });
    await prisma.walletTransaction.deleteMany({
      where: { customer: { email: { in: emails } } },
    });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { actorEmail: { in: emails } },
          { resourceId: { in: ids } },
          { resourceId: { in: refundRows.map((r) => r.id) } },
        ],
      },
    });
    await prisma.customer.deleteMany({ where: { email: { in: emails } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await prisma.paymentProviderSetting
      .deleteMany({ where: { code: 'simulated' } })
      .catch(() => undefined);
    delete process.env[PAYMENT_SIMULATOR_ENABLED_ENV];
    await app.close();
  });

  // ── §2.1 — la même opération, API puis webhook, UNE seule fois ────────────

  it('§2.1 : API puis charge.refunded (même opération) → 1000, JAMAIS 2000 (rejeu inclus)', async () => {
    const balBefore = await balanceOf(clientEmail);
    const pay = await settledTopup(1000, `ra-k1-${uid}`);
    expect((await paymentRow(pay.reference))?.refundedCents).toBe(0);

    const created = await adminRefund(pay.id, 1000, `ra-r1-${uid}`);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: RefundStatus.SUCCEEDED, amountCents: 1000 });
    const providerRef = String(created.body.providerRef);
    expect(providerRef).toBeTruthy();
    expect((await paymentRow(pay.reference))?.refundedCents).toBe(1000);

    // charge.refunded signale le MÊME remboursement (cumul prestataire 1000).
    const wh1 = await chargeRefunded(`evt_c21_a-${uid}`, pay.paymentRef!, 1000, [providerRef]);
    expect(wh1.status).toBe(200);
    expect((await paymentRow(pay.reference))?.refundedCents).toBe(1000);

    // Rejeu (nouvel eventId, même teneur) : inchangé.
    const wh2 = await chargeRefunded(`evt_c21_b-${uid}`, pay.paymentRef!, 1000, [providerRef]);
    expect(wh2.status).toBe(200);
    // Rejeu du refund.updated connu : CAS déjà soldé, aucun second avancement.
    const wh3 = await refundEvent(`evt_c21_c-${uid}`, 'refund.updated', providerRef, 1000, 'succeeded');
    expect(wh3.status).toBe(200);
    expect(wh3.body).toMatchObject({ result: 'processed' });

    const row = await paymentRow(pay.reference);
    expect(row?.refundedCents).toBe(1000);
    expect(row?.status).toBe(CardPaymentStatus.REFUNDED);
    expect(row?.interventionNeeded).toBe(false);
    // ZÉRO mouvement wallet supplémentaire : crédit recharge − débit remboursement.
    expect(await balanceOf(clientEmail)).toBe(balBefore);
  });

  // ── §2.2 — C2.5 : webhook AVANT persistance de la référence locale ────────

  it('§2.2 : webhook succeeded AVANT la référence locale, puis reprise (même opération) → compté UNE fois', async () => {
    const balBefore = await balanceOf(clientEmail);
    const pay = await settledTopup(1000, `ra-k2-${uid}`);
    const payRow = (await paymentRow(pay.reference))!;
    const adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });

    // Intention en vol : ligne PENDING créée par la préparation admin, appel
    // prestataire DISPATCHÉ, réponse perdue (providerRef non encore persisté).
    const key = `ra-r2-${uid}`;
    const pending = await prisma.refund.create({
      data: {
        cardPaymentId: pay.id,
        kind: RefundKind.EXTERNAL_CARD,
        status: RefundStatus.PENDING,
        amountCents: 600,
        currency: payRow.currency,
        idempotencyKey: key,
        dispatchedAt: new Date(),
        createdByUserId: adminUser!.id,
        createdByEmail: adminEmail,
      },
    });
    // Effets déjà appliqués par la préparation (réversation wallet + réservation).
    await prisma.customer.update({
      where: { email: clientEmail },
      data: { walletBalanceCents: { decrement: 600 } },
    });
    await prisma.cardPayment.update({
      where: { id: pay.id },
      data: { pendingRefundCents: { increment: 600 } },
    });

    // Le webhook PRESTATAIRE arrive AVANT la persistance de la référence
    // locale : inconnu pour la plateforme → plancher `succeeded` 600.
    const futureRef = simulatedRefundRef(key);
    const early = await refundEvent(
      `evt_c22_a-${uid}`,
      'refund.updated',
      futureRef,
      600,
      'succeeded',
      pay.paymentRef!,
    );
    expect(early.status).toBe(200);
    expect(early.body).toMatchObject({ result: 'processed' });
    let row = await paymentRow(pay.reference);
    expect(row?.refundedCents).toBe(600);
    expect(row?.status).toBe(CardPaymentStatus.PARTIALLY_REFUNDED);
    // Signal VISIBLE tant que la référence locale n'est pas rattachée.
    expect(row?.interventionNeeded).toBe(true);
    // Le webhook ne touche JAMAIS le solde (l'intention est déjà réversée).
    expect(await balanceOf(clientEmail)).toBe(balBefore + 400);

    // La référence locale RATTRAPPE : reprise (MÊME clé) → MÊME opération.
    const retried = await api()
      .post(`/${GlobalPrefix}/store/admin/payments/refunds/${pending.id}/retry`)
      .set(auth(adminToken));
    expect(retried.status).toBe(201);
    expect(retried.body).toMatchObject({
      status: RefundStatus.SUCCEEDED,
      providerRef: futureRef,
      amountCents: 600,
    });
    row = await paymentRow(pay.reference);
    expect(row?.refundedCents).toBe(600); // JAMAIS 1200 : UNE opération.
    expect(row?.pendingRefundCents).toBe(0);

    // Un cumul prestataire confirmant la même opération ne double pas non plus.
    const cumul = await chargeRefunded(`evt_c22_b-${uid}`, pay.paymentRef!, 600, [futureRef]);
    expect(cumul.status).toBe(200);
    row = await paymentRow(pay.reference);
    expect(row?.refundedCents).toBe(600);

    // Issue établie → l'admin lève le signal (l'historique est conservé).
    const resolved = await resolveIntervention(
      pay.id,
      'Rattachement webhook confirmé : même opération, une seule fois.',
    );
    expect(resolved.status).toBe(201);
    row = await paymentRow(pay.reference);
    expect(row?.interventionNeeded).toBe(false);
    expect(row?.status).toBe(CardPaymentStatus.PARTIALLY_REFUNDED); // jamais redescendu
    expect(await balanceOf(clientEmail)).toBe(balBefore + 400);
  });

  // ── §2.5 — inconnu non soldé : JAMAIS compté ──────────────────────────────

  it('§2.5 : remboursement inconnu pending/failed/canceled → zéro effet comptable, zéro alerte', async () => {
    const balBefore = await balanceOf(clientEmail);
    const pay = await settledTopup(1000, `ra-k3-${uid}`);

    const p = await refundEvent(`evt_c25_a-${uid}`, 'refund.created', `re_np_${uid}`, 700, 'pending', pay.paymentRef!);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ result: 'processed' });
    const f = await refundEvent(`evt_c25_b-${uid}`, 'refund.failed', `re_nf_${uid}`, 700, 'failed', pay.paymentRef!);
    expect(f.status).toBe(200);
    expect(f.body).toMatchObject({ result: 'processed' });
    const c = await refundEvent(`evt_c25_c-${uid}`, 'refund.canceled', `re_nc_${uid}`, 700, 'canceled', pay.paymentRef!);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ result: 'processed' });

    const row = await paymentRow(pay.reference);
    expect(row?.refundedCents).toBe(0);
    expect(row?.status).toBe(CardPaymentStatus.SUCCEEDED);
    expect(row?.interventionNeeded).toBe(false);
    // Seul le crédit de recharge bouge (aucun remboursement n'entre au compteur).
    expect(await balanceOf(clientEmail)).toBe(balBefore + 1000);
  });

  // ── §2.7 — partiels : le compteur suit le réel, sans plafond masqué ──────

  it('§2.7 : partiels 300+300 internes puis plancher 700 puis 1000 → REFUNDED exact', async () => {
    const pay = await settledTopup(1000, `ra-k4-${uid}`);

    const r1 = await adminRefund(pay.id, 300, `ra-r4a-${uid}`);
    expect(r1.status).toBe(201);
    expect((await paymentRow(pay.reference))?.refundedCents).toBe(300);
    const r2 = await adminRefund(pay.id, 300, `ra-r4b-${uid}`);
    expect(r2.status).toBe(201);
    expect((await paymentRow(pay.reference))?.refundedCents).toBe(600);

    await chargeRefunded(`evt_c27_a-${uid}`, pay.paymentRef!, 700, [
      String(r1.body.providerRef),
      String(r2.body.providerRef),
    ]);
    expect((await paymentRow(pay.reference))?.refundedCents).toBe(700);

    await chargeRefunded(`evt_c27_b-${uid}`, pay.paymentRef!, 1000, [
      String(r1.body.providerRef),
      String(r2.body.providerRef),
    ]);
    const row = await paymentRow(pay.reference);
    expect(row?.refundedCents).toBe(1000);
    expect(row?.status).toBe(CardPaymentStatus.REFUNDED);
  });

  // ── §2.4 — concurrence : deux observations simultanées, UNE avance ────────

  it('§2.4 : deux charge.refunded concurrents (même cumul) → une seule avance, déterministe', async () => {
    const pay = await settledTopup(1000, `ra-k5-${uid}`);
    const r = await adminRefund(pay.id, 300, `ra-r5-${uid}`);
    expect(r.status).toBe(201);

    const [a, b] = await Promise.all([
      chargeRefunded(`evt_c24_a-${uid}`, pay.paymentRef!, 300, [String(r.body.providerRef)]),
      chargeRefunded(`evt_c24_b-${uid}`, pay.paymentRef!, 300, [String(r.body.providerRef)]),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await paymentRow(pay.reference))?.refundedCents).toBe(300);
  });

  // ── §2.8 + §4.8 — dépassement signalé, encaissements bloqués ─────────────

  it('§2.8/§4.8 : dépassement → NEEDS_REVIEW + blocage, levé par l’admin → rétabli', async () => {
    const pay = await settledTopup(1000, `ra-k6-${uid}`);
    const r = await adminRefund(pay.id, 1000, `ra-r6-${uid}`);
    expect(r.status).toBe(201);

    // Preuve prestataire supérieure au montant encaissé : signal, jamais lissé.
    const over = await chargeRefunded(`evt_c28_${uid}`, pay.paymentRef!, 1200, [String(r.body.providerRef)]);
    expect(over.status).toBe(200);
    let row = await paymentRow(pay.reference);
    expect(row?.status).toBe(CardPaymentStatus.NEEDS_REVIEW);
    expect(row?.interventionNeeded).toBe(true);
    expect(row?.refundedCents).toBe(1200);

    // §4.8 — AUCUN nouvel encaissement tant que l'alerte est ouverte.
    const blocked = await createTopup(500, `ra-k6b-${uid}`);
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('non résolu');

    // Levée admin après vérification → rétabli.
    const resolved = await resolveIntervention(
      pay.id,
      'Vérifié : remboursement prestataire constaté, wallet conforme.',
    );
    expect(resolved.status).toBe(201);
    row = await paymentRow(pay.reference);
    expect(row?.interventionNeeded).toBe(false);
    // L'historique NEEDS_REVIEW est conservé (jamais redescendu).
    expect(row?.status).toBe(CardPaymentStatus.NEEDS_REVIEW);

    const ok = await createTopup(500, `ra-k6c-${uid}`);
    expect(ok.status).toBe(201);
  });

  // ── §2.9 — CONTRE-EXEMPLE : deux remboursements EXTERNES distincts ───────
  // Avant correction : `refund.updated` était traité comme un plancher
  // individuel → max(300, 400) = 400 au lieu de l'UNION 700.

  it('§2.9 : deux remboursements externes distincts (300 puis 400), avant tout charge.refunded → UNION 700', async () => {
    const balBefore = await balanceOf(clientEmail);
    const pay = await settledTopup(1000, `ra-k9-${uid}`);

    const w1 = await refundEvent(`evt_c29_a-${uid}`, 'refund.updated', `re_ext_a_${uid}`, 300, 'succeeded', pay.paymentRef!);
    expect(w1.status).toBe(200);
    expect(w1.body).toMatchObject({ result: 'processed' });
    expect((await paymentRow(pay.reference))?.refundedCents).toBe(300);

    const w2 = await refundEvent(`evt_c29_b-${uid}`, 'refund.updated', `re_ext_b_${uid}`, 400, 'succeeded', pay.paymentRef!);
    expect(w2.status).toBe(200);
    expect(w2.body).toMatchObject({ result: 'processed' });

    // UNION des IDENTITÉS distinctes (re_ext_a ∪ re_ext_b) = 700, jamais 400.
    const row = await paymentRow(pay.reference);
    expect(row?.refundedCents).toBe(700);
    expect(row?.status).toBe(CardPaymentStatus.PARTIALLY_REFUNDED);

    // Rejeu de la même identité (re_ext_a) : inchangé (idempotent par identité).
    const replay = await refundEvent(`evt_c29_c-${uid}`, 'refund.updated', `re_ext_a_${uid}`, 300, 'succeeded', pay.paymentRef!);
    expect(replay.status).toBe(200);
    expect((await paymentRow(pay.reference))?.refundedCents).toBe(700);

    // Aucun mouvement wallet : observations prestataire hors plateforme.
    expect(await balanceOf(clientEmail)).toBe(balBefore + 1000);
  });

  // ── §2.10 — CONTRE-EXEMPLE : externe 300 observé puis interne distinct 400 ─
  // Avant correction : max(courant 300, internes 400, plancher 0) = 400.

  it('§2.10 : externe 300 observé puis remboursement interne distinct 400 → UNION 700', async () => {
    const balBefore = await balanceOf(clientEmail);
    const pay = await settledTopup(1000, `ra-k10-${uid}`);

    const ext = await refundEvent(`evt_c210_a-${uid}`, 'refund.updated', `re_ext_c_${uid}`, 300, 'succeeded', pay.paymentRef!);
    expect(ext.status).toBe(200);
    expect((await paymentRow(pay.reference))?.refundedCents).toBe(300);
    const balanceAfterObs = await balanceOf(clientEmail);

    const r = await adminRefund(pay.id, 400, `ra-r10-${uid}`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: RefundStatus.SUCCEEDED, amountCents: 400 });

    // UNION externe 300 ∪ interne 400 = 700 (jamais max → 400).
    const row = await paymentRow(pay.reference);
    expect(row?.refundedCents).toBe(700);
    expect(row?.status).toBe(CardPaymentStatus.PARTIALLY_REFUNDED);

    // Seul le remboursement INTERNE bouge le wallet (l'observation non).
    expect(await balanceOf(clientEmail)).toBe(balanceAfterObs - 400);
    expect(await balanceOf(clientEmail)).toBe(balBefore + 1000 - 400);
  });

  // ── §2.11 — observation SANS montant : incertitude explicite + blocage ───

  it('§2.11 : observation succeeded sans montant → incertitude conservée, plafond bloqué jusqu’au rapprochement', async () => {
    const pay = await settledTopup(1000, `ra-k11-${uid}`);

    const noAmount = await postWebhook(
      event(`evt_c211_${uid}`, 'refund.updated', {
        id: `re_noamt_${uid}`,
        object: 'refund',
        payment_intent: pay.paymentRef,
        status: 'succeeded',
        // montant ABSENT : impossible d'calculer exactement le cumul.
      }),
      secret,
    );
    expect(noAmount.status).toBe(200);

    const row = await paymentRow(pay.reference);
    // L'incertitude est explicite et visible, jamais lissée.
    expect(row?.interventionNeeded).toBe(true);
    expect(String(row?.interventionReason)).toContain('rapprochement');

    // Opération dépendante du plafond REFUSÉE tant que non rapprochée.
    const blocked = await adminRefund(pay.id, 100, `ra-r11-${uid}`);
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('rapprochement');

    // Rapprochement admin → rétabli (l'observation est acquittée).
    const resolved = await resolveIntervention(pay.id, 'Observation rapprochée chez le prestataire.');
    expect(resolved.status).toBe(201);

    const ok = await adminRefund(pay.id, 100, `ra-r11b-${uid}`);
    expect(ok.status).toBe(201);
    expect((await paymentRow(pay.reference))?.refundedCents).toBe(100);
  });

  // ── §2.12 — ordres inversés + rejeu + concurrence réelle ─────────────────

  it('§2.12 : charge.refunded (cumul 700) PUIS les refund.updated distincts (300, 400) → 700 stable', async () => {
    const pay = await settledTopup(1000, `ra-k12-${uid}`);

    // Ordre inverse : le CUMUL prestataire arrive en premier.
    const c = await chargeRefunded(`evt_c212_a-${uid}`, pay.paymentRef!, 700, [`re_x_${uid}`, `re_y_${uid}`]);
    expect(c.status).toBe(200);
    expect((await paymentRow(pay.reference))?.refundedCents).toBe(700);

    // Puis les identités individuelles arrivent : la UNION ne bouge pas.
    await refundEvent(`evt_c212_b-${uid}`, 'refund.updated', `re_x_${uid}`, 300, 'succeeded', pay.paymentRef!);
    await refundEvent(`evt_c212_c-${uid}`, 'refund.updated', `re_y_${uid}`, 400, 'succeeded', pay.paymentRef!);
    expect((await paymentRow(pay.reference))?.refundedCents).toBe(700);

    // Concurrence réelle : deux identités distinctes traitées en parallèle.
    const pay2 = await settledTopup(1000, `ra-k12b-${uid}`);
    const [a, b] = await Promise.all([
      refundEvent(`evt_c212_d-${uid}`, 'refund.updated', `re_p_${uid}`, 300, 'succeeded', pay2.paymentRef!),
      refundEvent(`evt_c212_e-${uid}`, 'refund.updated', `re_q_${uid}`, 400, 'succeeded', pay2.paymentRef!),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await paymentRow(pay2.reference))?.refundedCents).toBe(700);
  });

  // ── §2.13 — VRAIE course croisée : charge.refunded ∥ refund.updated ──────
  // GO revue §6a — §2.4 ne lançait que DEUX charge.refunded identiques : il
  // prouvait la dédup du plancher, PAS la course des deux FACES d'un même
  // remboursement (cumul de charge vs identité individuelle). Ici les deux
  // événements partent réellement en parallèle (Promise.all, PG réelle) et
  // décrivent le MÊME remboursement externe : une seule comptabilisation.

  it('§2.13 : course croisée charge.refunded ∥ refund.updated (même remboursement externe) → 300, JAMAIS 600', async () => {
    const balBefore = await balanceOf(clientEmail);
    const pay = await settledTopup(1000, `ra-k13-${uid}`);
    const extRef = `re_cross_${uid}`;

    const [c, w] = await Promise.all([
      chargeRefunded(`evt_c213_a-${uid}`, pay.paymentRef!, 300, [extRef]),
      refundEvent(`evt_c213_b-${uid}`, 'refund.updated', extRef, 300, 'succeeded', pay.paymentRef!),
    ]);
    expect(c.status).toBe(200);
    expect(w.status).toBe(200);

    // Identité UNIQUE (re_cross) : UNION = 300 quelle que soit la file d'arrivée.
    const row = await paymentRow(pay.reference);
    expect(row?.refundedCents).toBe(300);
    expect(row?.status).toBe(CardPaymentStatus.PARTIALLY_REFUNDED);
    // Remboursement hors plateforme : signal visible + AUCUN mouvement wallet.
    expect(row?.interventionNeeded).toBe(true);
    expect(await balanceOf(clientEmail)).toBe(balBefore + 1000);
  });

  // ── §4.1 + §4.5 + §4.8 — dispatchedAt immuable, reprise déterministe ─────

  it('§4 : UNCERTAIN → blocage, reprise MÊME session (dispatchedAt immuable), puis rétabli', async () => {
    const opened = await createTopup(800, `ra-k7-${uid}`);
    expect(opened.status).toBe(201);
    const reference = String(opened.body.reference);
    const before = await paymentRow(reference);
    expect(before?.status).toBe(CardPaymentStatus.CREATED);
    expect(before?.dispatchedAt).toBeInstanceOf(Date);
    const firstDispatchedAt = before!.dispatchedAt!;
    const sessionRef = sessionRefOf(opened.body.checkoutUrl);

    // Simule un appel resté sans réponse concluante (crash/persistance perdue).
    await prisma.cardPayment.update({
      where: { id: before!.id },
      data: { providerCallState: 'UNCERTAIN', checkoutUrl: null },
    });

    // §4.8 — nouvel encaissement REFUSÉ tant que l'issue n'est pas établie.
    const blocked = await createTopup(500, `ra-k7b-${uid}`);
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('non résolu');

    // §4.5 — reprise avec la MÊME clé : déterministe → MÊME session (pas de
    // seconde session), et le store base relit l'état (« redémarrage » OK).
    const replay = await createTopup(800, `ra-k7-${uid}`);
    expect(replay.status).toBe(201);
    expect(sessionRefOf(replay.body.checkoutUrl)).toBe(sessionRef);
    const afterReplay = await paymentRow(reference);
    expect(afterReplay?.providerCallState).toBe('RESOLVED');
    // §4.1 — le PREMIER envoi reste la référence de la fenêtre de reprise.
    expect(afterReplay?.dispatchedAt?.getTime()).toBe(firstDispatchedAt.getTime());

    // Issue établie → nouvel encaissement rétabli.
    const ok = await createTopup(500, `ra-k7c-${uid}`);
    expect(ok.status).toBe(201);

    // Encaissement complet de la session relancée : UNE confirmation.
    await completeSimulated(sessionRef, 'success');
    const settled = await paymentRow(reference);
    expect(settled?.status).toBe(CardPaymentStatus.SUCCEEDED);
  });
});
