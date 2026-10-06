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
} from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { RenewalService } from '../src/store/renewal.service';
import {
  acquireRenewalChainBarrier,
  renewalChainRootId,
} from '../src/store/renewal-chain-barrier';
import { acceptanceFor, preloadAcceptance } from './pricing-acceptance.fixture';
import {
  PanelTransport,
  PanelTransportFactory,
} from './../src/servers/panel-transport.factory';

// Sweeps (timers) OFF : les passages sont déclenchés à la demande.
process.env.ORDER_SWEEP_ENABLED = 'false';
process.env.RENEWAL_SWEEP_ENABLED = 'false';

/**
 * GO fenêtres résiduelles R1 — barrière transactionnelle commune entre la
 * CRÉATION DE DESCENDANTS (`createRenewalOrderInTx`) et la RÉVOCATION DE
 * CHAÎNE (`setMyOrderRenewal`), sur PostgreSQL réel (icode_host_pro_socle) :
 *
 * Fenêtre close : la révocation marchait la descendance puis lançait un
 * `updateMany` SÉPARÉ — une fille G committée entre les deux n'était ni vue
 * ni désarmée (G restait `autoRenew=true` → un sweep ultérieur la débiterait).
 * Les deux voies acquièrent MAINTENANT `pg_advisory_xact_lock` sur la racine
 * de la chaîne, EN PREMIER dans leur transaction.
 *
 * Les DEUX ordres d'exécution sont imposés EXPLICITEMENT (barrière + état de
 * verrou constaté dans `pg_locks`), jamais par `Promise.all` ni par une
 * temporisation supposant l'ordre :
 *
 *  (1) renouvellement d'abord : la tx de création tient la barrière avec F
 *      flip + G inséré NON committé → la révocation depuis R est constatée
 *      EN ATTENTE sur le verrou advisory (`granted=false`) → commit de A →
 *      la révocation découvre F **et** G et désarme toute la chaîne ;
 *      aucun sweep ne peut ensuite débiter G ;
 *  (2) révocation d'abord : elle termine, puis la création acquiert la
 *      barrière et son CAS `autoRenew=true` échoue (COUNT 0) → aucune fille
 *      n'est créée ni armée.
 *
 * Conservés : paiement manuel (sans option de consentement) toujours ouvert,
 * idempotence des CAS (seconde révocation = no-op), zéro réseau réel
 * (MailTransportFactory + PanelTransportFactory stubbés).
 *
 * GO limite de chaîne (suite) : chaînes SYNTHÉTIQUES de 49 / 50 / 51 liens
 * (racine commune + révocation complète des descendants), preuve d'attente
 * sur la CLÉ COMMUNE dérivée depuis la feuille à 51 liens, et chaînes
 * INVALIDES (cycle, mère orpheline) → refus explicite + rollback complet.
 */
describe('R1 — barrière chaîne création/révocation (e2e PG déterministe)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;
  let renewal: RenewalService;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const adminEmail = `r1admin_${stamp}@example.com`;
  const t1Email = `r1t1_${stamp}@example.com`;
  const t2Email = `r1t2_${stamp}@example.com`;
  const t3Email = `r1t3_${stamp}@example.com`;
  const password = 'password123';

  let adminToken = '';
  let t1Token = '';
  let t2Token = '';
  let t3Token = '';
  let t1UserId = '';
  let t2UserId = '';
  let t3UserId = '';
  let t3CustomerId = '';

  let packId = '';
  let monthlyProductId = '';
  let monthlySlug = '';
  let monthlyName = '';
  let virId = '';
  let createdMailId: string | null = null;
  const orderIds: string[] = [];

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

  /** Suit une promesse en vol : `flag.settled === false` = encore en attente. */
  function track<T>(p: PromiseLike<T>) {
    const flag = { settled: false };
    const promise = Promise.resolve(p).then((r) => {
      flag.settled = true;
      return r;
    });
    promise.catch(() => undefined);
    return { flag, promise };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email, password })
      .expect(201);
    return res.body.accessToken as string;
  }

  function checkout(email: string, name: string, token: string) {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/checkout`)
      .send({
        productSlug: monthlySlug,
        name,
        email,
        paymentMethodId: virId,
        renewalConsent: true,
        ...(acceptanceFor(monthlySlug, virId) ?? {}),
      })
      .set('Authorization', `Bearer ${token}`);
  }

  function confirm(orderId: string) {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/orders/${orderId}/confirm-payment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reference: `R1-RECETTE-${stamp}` });
  }

  function sweep() {
    return request(app.getHttpServer())
      .post(`/${GlobalPrefix}/store/admin/renewal/sweep`)
      .set('Authorization', `Bearer ${adminToken}`);
  }

  function toggleRenewal(orderId: string, enabled: boolean, token: string) {
    return request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/client/orders/${orderId}/renewal`)
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled });
  }

  // ── GO limite de chaîne : chaînes SYNTHÉTIQUES (49/50/51 liens) ──────────
  let chainSeq = 0;

  /**
   * Chaîne linéaire de `edges` LIENS : ids[0] = racine (sans mère) →
   * ids[edges] = feuille ; `renewsOrderId` unique ⇒ au plus UNE fille par
   * mère. Toutes armées (`autoRenew=true`) pour mesurer la révocation.
   */
  async function seedChain(edges: number): Promise<string[]> {
    const ids: string[] = [];
    let motherId: string | null = null;
    for (let i = 0; i <= edges; i++) {
      chainSeq += 1;
      const order = await prisma.order.create({
        data: {
          customerId: t3CustomerId,
          customerName: 'Chaîne R1-3',
          customerEmail: t3Email,
          productId: monthlyProductId,
          productName: monthlyName,
          packId,
          status: OrderStatus.ACTIVE,
          billingCycle: BillingCycle.MONTHLY,
          currency: 'USD',
          taxRatePercent: 0,
          amountHtCents: 5_000,
          taxAmountCents: 0,
          amountTtcCents: 5_000,
          paymentMethodId: virId,
          paymentMethodName: 'Virement bancaire',
          idempotencyKey: `r1-chain-${stamp}-${chainSeq}`,
          renewsOrderId: motherId,
          renewalConsentAt: daysAgo(30),
          autoRenew: true,
          paidAt: daysAgo(30),
        },
      });
      ids.push(order.id);
      motherId = order.id;
      orderIds.push(order.id);
    }
    return ids;
  }

  /** Commande isolée (références orphelines / cycles), même dossier client. */
  async function seedLoneOrder(renewsOrderId: string | null): Promise<string> {
    chainSeq += 1;
    const order = await prisma.order.create({
      data: {
        customerId: t3CustomerId,
        customerName: 'Chaîne R1-3',
        customerEmail: t3Email,
        productId: monthlyProductId,
        productName: monthlyName,
        packId,
        status: OrderStatus.ACTIVE,
        billingCycle: BillingCycle.MONTHLY,
        currency: 'USD',
        taxRatePercent: 0,
        amountHtCents: 5_000,
        taxAmountCents: 0,
        amountTtcCents: 5_000,
        paymentMethodId: virId,
        paymentMethodName: 'Virement bancaire',
        idempotencyKey: `r1-chain-${stamp}-${chainSeq}`,
        renewsOrderId,
        renewalConsentAt: daysAgo(30),
        autoRenew: true,
        paidAt: daysAgo(30),
      },
    });
    orderIds.push(order.id);
    return order.id;
  }

  /** autoRenew de TOUS les maillons (ids), dans l'ordre de la chaîne. */
  async function armedOf(ids: string[]): Promise<boolean[]> {
    const rows = await prisma.order.findMany({
      where: { id: { in: ids } },
      select: { id: true, autoRenew: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.autoRenew]));
    return ids.map((id) => byId.get(id) ?? false);
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
      .send({ bankRef: `BANK-R1-FUND-${created.body.id}` })
      .expect(201);
  }

  /** Horloge accélérée : échéance rétrogradée en base (jamais de fausse date). */
  async function makeDue(orderId: string, when: Date) {
    await prisma.order.update({
      where: { id: orderId },
      data: { autoRenew: true, nextBillingDate: when },
    });
  }

  /**
   * Chaîne R → F réelle (checkout + 1ᵉʳ sweep qui fabrique et PAIE F) :
   * R.autoRenew=false (flip de création), F.autoRenew=true (consentement
   * copié), F échue = tête du sweep suivant.
   */
  async function makeChain(
    email: string,
    name: string,
    token: string,
    userId: string,
  ): Promise<{ R: string; F: string }> {
    const res = await checkout(email, name, token).expect(201);
    const R = (res.body as { orderId: string }).orderId;
    orderIds.push(R);
    await confirm(R).expect(201);
    await fundWallet(token, 100_000);
    await makeDue(R, daysAgo(1));
    const sw = await sweep().expect(201);
    const f = await prisma.order.findFirst({
      where: { renewsOrderId: R },
      orderBy: { createdAt: 'asc' },
    });
    if (!f) {
      // Diagnostic : pourquoi le 1ᵉʳ passage n'a-t-il pas fabriqué F ?
      const r0 = await prisma.order.findUniqueOrThrow({ where: { id: R } });
      const subs = await prisma.subscription.findMany({
        where: { userId },
        select: { orderId: true, status: true, productId: true },
      });
      const heads = await renewal.dueRenewalHeads(new Date());
      const invs = await prisma.invoice.findMany({
        where: { orderId: R },
        select: { id: true, lines: { select: { kind: true, totalTtcCents: true } } },
      });
      const hist = await prisma.orderStatusHistory.findMany({
        where: { orderId: R },
        select: { status: true, note: true },
      });
      let directErr = 'none';
      let directMade = 'n/a';
      try {
        const head2 = heads.find((h) => h.id === R);
        if (head2) {
          directMade = JSON.stringify(
            await prisma.$transaction((tx) =>
              renewal.createRenewalOrderInTx(tx, head2 as never, new Date()),
            ),
          );
        } else {
          directMade = 'head absent';
        }
      } catch (e) {
        directErr = String(e);
      }
      throw new Error(
        `makeChain: aucune fille pour ${R} — sweep=${JSON.stringify(sw.body)} ` +
          `R(status=${r0.status}, consent=${r0.renewalConsentAt?.toISOString() ?? 'null'}, ` +
          `cycle=${r0.billingCycle}, autoRenew=${r0.autoRenew}, next=${r0.nextBillingDate?.toISOString() ?? 'null'}) ` +
          `subs=${JSON.stringify(subs)} heads=${JSON.stringify(heads.map((h) => h.id))} ` +
          `invs=${JSON.stringify(invs)} hist=${JSON.stringify(hist)} ` +
          `directMade=${directMade} directErr=${directErr}`,
      );
    }
    // Tête du prochain passage : échue + consentement + famille payée.
    await makeDue(f.id, daysAgo(1));
    const r0 = await prisma.order.findUniqueOrThrow({
      where: { id: R },
      select: { autoRenew: true },
    });
    expect(r0.autoRenew).toBe(false);
    const f0 = await prisma.order.findUniqueOrThrow({
      where: { id: f.id },
      select: { autoRenew: true },
    });
    expect(f0.autoRenew).toBe(true);
    expect(userId).toBeTruthy();
    return { R, F: f.id };
  }

  /**
   * Preuve EXPLICITE d'attente sur la barrière : un verrou advisory n'est
   * pas encore accordé (la révocation est bloquée sur la clé de la chaîne).
   * Ni `Promise.all`, ni une temporisation supposant l'ordre.
   */
  async function waitForWaitingChainLock(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND granted = false`;
      if ((rows[0]?.n ?? 0) >= 1) return;
      await sleep(100);
    }
    throw new Error(
      'Aucun verrou advisory en attente : la révocation n a pas rejoint la barrière de chaîne.',
    );
  }

  const balanceOf = async (userId: string) =>
    (
      await prisma.customer.findUniqueOrThrow({ where: { userId } })
    ).walletBalanceCents;

  // ── Boot + fixtures ──────────────────────────────────────────────────────
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
    renewal = moduleRef.get(RenewalService);
    limiter.reset();

    const mkUser = async (email: string, role: Role, name: string) => {
      await prisma.user.create({
        data: { email, name, passwordHash: await bcrypt.hash(password, 10), role },
      });
    };
    await mkUser(adminEmail, Role.ADMIN, 'Admin R1');
    await mkUser(t1Email, Role.USER, 'Chaîne R1-1');
    await mkUser(t2Email, Role.USER, 'Chaîne R1-2');
    await mkUser(t3Email, Role.USER, 'Chaîne R1-3');
    adminToken = await login(adminEmail);
    t1Token = await login(t1Email);
    t2Token = await login(t2Email);
    t3Token = await login(t3Email);
    t1UserId = (await prisma.user.findUniqueOrThrow({ where: { email: t1Email } })).id;
    t2UserId = (await prisma.user.findUniqueOrThrow({ where: { email: t2Email } })).id;
    const t3User = await prisma.user.findUniqueOrThrow({ where: { email: t3Email } });
    t3UserId = t3User.id;
    // Dossier client SYNTHÉTIQUE (GO limite de chaîne) : les chaînes de
    // 49/50/51 liens sont créées directement en base, sans checkout.
    t3CustomerId = (
      await prisma.customer.create({
        data: { email: t3Email, name: 'Chaîne R1-3', userId: t3UserId },
      })
    ).id;
    expect(t3UserId).toBeTruthy();

    const pack = await prisma.hostingPack.create({
      data: { name: `r1-pack-${stamp}`, ramMb: 512 },
    });
    packId = pack.id;
    const monthly = await prisma.product.create({
      data: {
        name: `r1-monthly-${stamp}`,
        slug: `r1-monthly-${stamp}`,
        status: 'ACTIVE',
        hidden: false,
        priceHtCents: 5000,
        billingCycle: BillingCycle.MONTHLY,
        packId,
      },
    });
    monthlyProductId = monthly.id;
    monthlySlug = monthly.slug!;
    monthlyName = monthly.name ?? `r1-monthly-${stamp}`;
    const vir = await prisma.paymentMethod.create({
      data: { name: `VIR-R1-${stamp}`, type: PaymentMethodType.BANK_TRANSFER, isActive: true },
    });
    virId = vir.id;

    const priorMail = await prisma.mailSetting.findFirst();
    if (!priorMail || !priorMail.host || !priorMail.fromEmail) {
      createdMailId = (
        await prisma.mailSetting.create({
          data: {
            host: 'smtp.test.local',
            fromEmail: `noreply-${stamp}@test.local`,
            fromName: 'Code Diali R1',
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
    const allEmails = [adminEmail, t1Email, t2Email, t3Email];
    let customers: Array<{ id: string }> = [];
    try {
      customers = await prisma.customer
        .findMany({ where: { email: { in: allEmails } }, select: { id: true } })
        .catch(() => [] as { id: string }[]);
      const txs = await prisma.walletTransaction
        .findMany({
          where: { customerId: { in: customers.map((c) => c.id) } },
          select: { proofPath: true },
        })
        .catch(() => [] as { proofPath: string | null }[]);
      for (const t of txs) {
        if (t.proofPath) {
          try {
            const { unlinkSync } = await import('node:fs');
            const { resolve } = await import('node:path');
            unlinkSync(
              resolve(process.cwd(), 'public', 'wallet-proofs', t.proofPath.replace(/^.*[\\/]/, '')),
            );
          } catch {
            /* déjà parti */
          }
        }
      }
    } catch {
      /* best-effort */
    }

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
    await prisma.product.deleteMany({ where: { id: monthlyProductId } }).catch(() => {});
    await prisma.hostingPack.deleteMany({ where: { id: packId } }).catch(() => {});
    await prisma.paymentMethod.deleteMany({ where: { id: virId } }).catch(() => {});
    if (createdMailId) {
      await prisma.mailSetting.delete({ where: { id: createdMailId } }).catch(() => {});
    }
    await app?.close();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (1) ordre EXPLICITE : renouvellement d'abord (tx en vol) → révocation
  //     attend la barrière → commit → révocation désarme F ET G
  // ═══════════════════════════════════════════════════════════════════════
  it('ordre 1 : création de G en vol sous barrière → révocation en attente explicite puis toute la chaîne désarmée', async () => {
    const { R, F } = await makeChain(t1Email, 'Chaîne R1-1', t1Token, t1UserId);

    // Tête échue = F (consentement + échéance + famille payée).
    const heads = await renewal.dueRenewalHeads(new Date());
    const fHead = heads.find((h) => h.id === F);
    expect(fHead).toBeTruthy();

    // ── (A) Renouvellement : UNE tx tenant la barrière, F flip + G inséré,
    //      NON committé (le gate est tenu DANS la transaction).
    let inTx!: () => void;
    const inTxP = new Promise<void>((r) => {
      inTx = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const txP = prisma.$transaction(
      async (tx) => {
        const made = await renewal.createRenewalOrderInTx(tx, fHead!, new Date());
        expect(made).not.toBeNull(); // G préparé sous barrière
        inTx();
        await gate;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    txP.catch(() => undefined);
    await inTxP;

    // Fenêtre observée depuis l'extérieur : G invisible, F encore armé
    // (le flip de A n'est pas committé).
    expect(await prisma.order.count({ where: { renewsOrderId: F } })).toBe(0);
    const fMid = await prisma.order.findUniqueOrThrow({
      where: { id: F },
      select: { autoRenew: true },
    });
    expect(fMid.autoRenew).toBe(true);

    // ── (B) Révocation depuis R : constatée EN ATTENTE sur la barrière.
    const rev = track(toggleRenewal(R, false, t1Token).expect(200));
    await waitForWaitingChainLock(); // preuve d'attente EXPLICITE (pg_locks)
    expect(rev.flag.settled).toBe(false); // toujours en vol pendant l'attente
    expect(await prisma.order.count({ where: { renewsOrderId: F } })).toBe(0);

    // ── (C) Commit de A → la révocation termine sur l'état complet.
    release();
    await txP;
    const revRes = await rev.promise;
    expect(revRes.body.autoRenew).toBe(false);

    // Attendu : AUCUNE commande de la chaîne ne reste armée (R, F, G).
    const r1 = await prisma.order.findUniqueOrThrow({
      where: { id: R },
      select: { autoRenew: true },
    });
    const f1 = await prisma.order.findUniqueOrThrow({
      where: { id: F },
      select: { autoRenew: true },
    });
    expect(r1.autoRenew).toBe(false);
    expect(f1.autoRenew).toBe(false);
    const g = await prisma.order.findFirstOrThrow({
      where: { renewsOrderId: F },
      orderBy: { createdAt: 'asc' },
    });
    expect(g.autoRenew).toBe(false); // G découvert SOUS barrière puis désarmé
    expect(g.status).toBe(OrderStatus.PENDING_PAYMENT);

    // La révocation a compté G comme descendant désarmé (audit).
    const toggleAudit = await prisma.auditLog.findFirst({
      where: { action: 'subscription.renewal_toggled', resourceId: R },
      orderBy: { createdAt: 'desc' },
    });
    expect(toggleAudit).not.toBeNull();
    expect(
      (toggleAudit!.details as { revokedDescendants?: number }).revokedDescendants,
    ).toBe(1);

    // ── (D) Aucun prochain sweep ne peut débiter G.
    const headsAfter = await renewal.dueRenewalHeads(new Date());
    expect(headsAfter.some((h) => h.id === g.id)).toBe(false);
    expect(headsAfter.some((h) => h.id === F)).toBe(false);
    const balanceBefore = await balanceOf(t1UserId);
    const sw = await sweep().expect(201);
    expect(sw.body).toMatchObject({ created: 0, paid: 0 });
    expect(await balanceOf(t1UserId)).toBe(balanceBefore); // zéro débit
    const gAfter = await prisma.order.findUniqueOrThrow({ where: { id: g.id } });
    expect(gAfter.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(gAfter.paidAt).toBeNull();
    expect(
      (await prisma.invoice.findFirstOrThrow({ where: { orderId: g.id } })).status,
    ).toBe(InvoiceStatus.UNPAID);
    expect(
      await prisma.walletTransaction.count({ where: { orderId: g.id } }),
    ).toBe(0);

    // ── (E) Idempotence : seconde révocation = no-op sûr (aucun réarmement).
    const rev2 = await toggleRenewal(R, false, t1Token).expect(200);
    expect(rev2.body.autoRenew).toBe(false);
    const g2 = await prisma.order.findUniqueOrThrow({ where: { id: g.id } });
    expect(g2.autoRenew).toBe(false);
    const toggleAudit2 = await prisma.auditLog.findFirst({
      where: { action: 'subscription.renewal_toggled', resourceId: R },
      orderBy: { createdAt: 'desc' },
    });
    expect(
      (toggleAudit2!.details as { revokedDescendants?: number }).revokedDescendants,
    ).toBe(0);

    // ── (F) Paiement MANUEL conservé (jamais soumis au consentement) :
    //      révoquer n'empêche pas de régler volontairement, sans réarmer.
    const manual = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/orders/${g.id}/pay-with-wallet`)
      .set('Authorization', `Bearer ${t1Token}`)
      .expect(201);
    expect(manual.body.status).toBe(OrderStatus.ACTIVE);
    const gPaid = await prisma.order.findUniqueOrThrow({ where: { id: g.id } });
    expect(gPaid.autoRenew).toBe(false); // JAMAIS réarmé par un règlement manuel
    expect(gPaid.nextBillingDate).toBeNull();
    expect(
      (await prisma.invoice.findFirstOrThrow({ where: { orderId: g.id } })).status,
    ).toBe(InvoiceStatus.PAID);
    expect(await balanceOf(t1UserId)).toBe(balanceBefore - g.amountTtcCents);
    expect(
      await prisma.walletTransaction.count({ where: { orderId: g.id, type: 'DEBIT' } }),
    ).toBe(1);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (2) ordre EXPLICITE : révocation d'abord → la création acquiert la
  //     barrière, CAS échoue → aucune fille créée ni armée
  // ═══════════════════════════════════════════════════════════════════════
  it('ordre 2 : révocation d’abord → création sous barrière refusée (CAS COUNT 0), aucune fille armée', async () => {
    const { R, F } = await makeChain(t2Email, 'Chaîne R1-2', t2Token, t2UserId);

    // Snapshot de la tête AVANT révocation (F est armé, échu).
    const heads = await renewal.dueRenewalHeads(new Date());
    const fHead = heads.find((h) => h.id === F);
    expect(fHead).toBeTruthy();

    // ── (a) Révocation d'abord : se termine ENTIÈREMENT (walk sous barrière).
    const rev = await toggleRenewal(R, false, t2Token).expect(200);
    expect(rev.body.autoRenew).toBe(false);
    const f1 = await prisma.order.findUniqueOrThrow({
      where: { id: F },
      select: { autoRenew: true },
    });
    expect(f1.autoRenew).toBe(false); // F découvert et désarmé

    // ── (b) Le renouvellement qui avait vu F armé tente sa création :
    //      barrière acquise EN PREMIER, puis CAS `autoRenew=true` → COUNT 0
    //      → aucune fille n'est créée (null), jamais d'arme résiduelle.
    const made = await prisma.$transaction(
      (tx) => renewal.createRenewalOrderInTx(tx, fHead!, new Date()),
      { timeout: 30_000 },
    );
    expect(made).toBeNull();
    expect(await prisma.order.count({ where: { renewsOrderId: F } })).toBe(0);

    // ── (c) Prochain sweep : rien à créer, rien à débiter dans la chaîne.
    const sw = await sweep().expect(201);
    expect(sw.body).toMatchObject({ created: 0, paid: 0 });
    const balanceBefore = await balanceOf(t2UserId);
    expect(await balanceOf(t2UserId)).toBe(balanceBefore);
    const chain = await prisma.order.findMany({
      where: { OR: [{ id: R }, { id: F }, { renewsOrderId: F }] },
      select: { id: true, autoRenew: true },
    });
    expect(chain.filter((o) => o.autoRenew)).toHaveLength(0);

    // ── (d) Idempotence : seconde révocation = no-op sûr.
    const rev2 = await toggleRenewal(R, false, t2Token).expect(200);
    expect(rev2.body.autoRenew).toBe(false);
    const chain2 = await prisma.order.findMany({
      where: { OR: [{ id: R }, { id: F }, { renewsOrderId: F }] },
      select: { autoRenew: true },
    });
    expect(chain2.filter((o) => o.autoRenew)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GO limite de chaîne : 49 / 50 / 51 liens — racine commune + révocation
  // COMPLÈTE des descendants (l'ancienne « garde 50 » tronquait au-delà de
  // 50 liens : ancêtre intermédiaire comme racine + succès partiel).
  // ═══════════════════════════════════════════════════════════════════════
  for (const edges of [49, 50, 51]) {
    it(`limite ${edges} liens : racine commune + révocation complète de tous les descendants`, async () => {
      const ids = await seedChain(edges);
      const rootId = ids[0];
      const leafId = ids[edges];

      // Racine commune : la racine RÉELLE est la même depuis la feuille,
      // le milieu et la racine (parcours complet, jamais tronqué).
      const fromLeaf = await prisma.$transaction((tx) =>
        renewalChainRootId(tx, leafId),
      );
      const fromMid = await prisma.$transaction((tx) =>
        renewalChainRootId(tx, ids[Math.floor(edges / 2)]),
      );
      const fromRoot = await prisma.$transaction((tx) =>
        renewalChainRootId(tx, rootId),
      );
      expect(fromLeaf).toBe(rootId);
      expect(fromMid).toBe(rootId);
      expect(fromRoot).toBe(rootId);

      // Révocation depuis la racine : TOUS les descendants sont désarmés
      // (au-delà de 50 liens, l'ancien walk en perdait).
      const res = await toggleRenewal(rootId, false, t3Token).expect(200);
      expect(res.body.autoRenew).toBe(false);
      const armed = await armedOf(ids);
      expect(armed.filter(Boolean)).toHaveLength(0); // 0 maillon résiduel

      const toggleAudit = await prisma.auditLog.findFirst({
        where: { action: 'subscription.renewal_toggled', resourceId: rootId },
        orderBy: { createdAt: 'desc' },
      });
      expect(toggleAudit).not.toBeNull();
      expect(
        (toggleAudit!.details as { revokedDescendants?: number })
          .revokedDescendants,
      ).toBe(edges); // la racine + chacun des descendants désarmés

      // Idempotence conservée : seconde révocation = no-op sûr.
      const res2 = await toggleRenewal(rootId, false, t3Token).expect(200);
      expect(res2.body.autoRenew).toBe(false);
      expect((await armedOf(ids)).filter(Boolean)).toHaveLength(0);
    });
  }

  it('clé de verrou COMMUNE : révocation (racine) attend le verrou tenu depuis la feuille à 51 liens', async () => {
    const ids = await seedChain(51);
    const rootId = ids[0];
    const leafId = ids[51];

    // La racine dérivée depuis la FEUILLE est bien la racine de la chaîne.
    const ridFromLeaf = await prisma.$transaction((tx) =>
      renewalChainRootId(tx, leafId),
    );
    expect(ridFromLeaf).toBe(rootId);

    // Tx A : acquiert la barrière SUR CETTE racine (clé dérivée depuis la
    // feuille), reste ouverte (gate tenu DANS la transaction).
    let held!: () => void;
    const heldP = new Promise<void>((r) => {
      held = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const holdP = prisma.$transaction(
      async (tx) => {
        await acquireRenewalChainBarrier(tx, ridFromLeaf);
        held();
        await gate;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    holdP.catch(() => undefined);
    await heldP;

    // Révocation depuis la RACINE : même clé → constatée EN ATTENTE.
    const rev = track(toggleRenewal(rootId, false, t3Token).expect(200));
    await waitForWaitingChainLock();
    expect(rev.flag.settled).toBe(false);

    // Commit de A → la révocation complète la chaîne entière.
    release();
    await holdP;
    const revRes = await rev.promise;
    expect(revRes.body.autoRenew).toBe(false);
    expect((await armedOf(ids)).filter(Boolean)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Chaînes INVALIDES : refus explicite + rollback complet (jamais de
  // succès partiel après parcours tronqué).
  // ═══════════════════════════════════════════════════════════════════════
  it('cycle a↔b : refus explicite chaine_cyclique (409), AUCUN autoRenew touché', async () => {
    const a = await seedLoneOrder(null);
    const b = await seedLoneOrder(a);
    // Cycle : la racine de a remonte a → b → a.
    await prisma.order.update({
      where: { id: a },
      data: { renewsOrderId: b },
    });

    const res = await toggleRenewal(a, false, t3Token).expect(409);
    expect(String(res.body.message)).toContain('chaine_cyclique');

    // Rollback complet : le CAS n'a jamais été exécuté, rien n'est désarmé.
    expect(await armedOf([a, b])).toEqual([true, true]);
    expect(
      await prisma.auditLog.count({
        where: { action: 'subscription.renewal_toggled', resourceId: a },
      }),
    ).toBe(0);
  });

  it('référence manquante (mère orpheline) : refus explicite chaine_reference_absente (409), rien désarmé', async () => {
    const d = await seedLoneOrder(`ghost-${stamp}`);

    const res = await toggleRenewal(d, false, t3Token).expect(409);
    expect(String(res.body.message)).toContain('chaine_reference_absente');

    expect(await armedOf([d])).toEqual([true]);
    expect(
      await prisma.auditLog.count({
        where: { action: 'subscription.renewal_toggled', resourceId: d },
      }),
    ).toBe(0);
  });
});
