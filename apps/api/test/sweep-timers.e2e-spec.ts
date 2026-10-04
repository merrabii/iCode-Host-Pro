import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import {
  BillingCycle,
  InvoiceLineKind,
  InvoiceStatus,
  OrderStatus,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { AuditService } from './../src/audit/audit.service';
import { CheckoutService } from './../src/store/checkout.service';
import { MailSettingsService } from './../src/mail/mail-settings.service';
import { SuspensionEffectsService } from './../src/store/suspension-effects.service';
import { ProvisioningService } from './../src/store/provisioning.service';
import { RenewalService } from './../src/store/renewal.service';
import { OrderLifecycleService } from './../src/store/order-lifecycle.service';
import {
  acquireSweepLease,
  releaseSweepLease,
} from './../src/store/sweep-guards';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import {
  PanelTarget,
  PanelTransport,
  PanelTransportFactory,
} from './../src/servers/panel-transport.factory';

// Q6 (GO item 6) : configuration ABSENTE = cas nominal testé ici. Aucune
// valeur ne doit rester d'une spec précédente (worker partagé en runInBand).
delete process.env.ORDER_SWEEP_ENABLED;
delete process.env.RENEWAL_SWEEP_ENABLED;
delete process.env.HOSTING_C4_ENABLED;

/**
 * Q6 (GO item 6) — automatismes OFF par défaut + garde multi-processus (e2e) :
 *
 *  1. **Démarrage avec configuration absente** : aucun timer, et AUCUNE
 *     mutation automatique — rien qui n'expire, ne débite, ne suspende ni ne
 *     provisionne une commande au boot (fixtures créées AVANT `app.init()`).
 *  2. **Lease multi-processus** (`SweepLease` en base) : un passe tenu par un
 *     AUTRE porteur bloque le passage (zéro passe) ; la passe repart après
 *     libération.
 *  3. **Deux processus concurrents** (2 instances `RenewalService` réelles,
 *     même base) : le renouvellement n'est créé QU'UNE fois, la suspension
 *     UNE fois, le dunning UNE fois — invariants garantis par les CAS par
 *     ligne, pas par le booléen local.
 *  4. **Expiration** : deux instances `OrderLifecycleService` concurrentes →
 *     UNE seule transition sur la commande, **UN SEUL audit** `order.expired`
 *     (le perdant n'aude pas une transition qu'il n'a pas faite).
 *
 * Aucun réseau réel : MailTransportFactory + PanelTransportFactory stubbés,
 * PrismaService RÉEL sur la base dédiée (icode_host_pro_socle).
 */
describe('Sweeps — OFF par défaut + garde multi-processus (e2e, Q6)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let provisionSpy: jest.SpyInstance;

  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stamp = uid;

  const momEmail = `q6mom_${stamp}@example.com`;
  const staleEmail = `q6stale_${stamp}@example.com`;
  const password = 'password123';

  let momUserId = '';
  let momCustomerId = '';
  let staleUserId = '';
  let staleCustomerId = '';
  let productId = '';
  let motherOrderId = '';
  let staleOrderId = '';
  let subRenewId = '';
  let subSuspendId = '';
  let createdMailId: string | null = null;
  const motherNumber = `Q6-M-${stamp}`;
  const staleNumber = `Q6-S-${stamp}`;
  const overdueNumber = `Q6-O-${stamp}`;

  const mailTransportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const mailFactoryStub = { create: jest.fn().mockReturnValue(mailTransportStub) };
  const fakeTransport = {
    stopApplication: jest.fn(async (_t: PanelTarget, _u: string) => undefined),
    startApplication: jest.fn(async (_t: PanelTarget, _u: string) => undefined),
    deleteApplication: jest.fn(async (_u: string) => {
      throw new Error('SUPPRESSION INTERDITE EN Q6');
    }),
  };
  const fakePanelFactory = {
    create: () => fakeTransport,
  } as unknown as PanelTransportFactory;

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  /** Une instance FRAÎCHE du scheduler (« un autre processus »). */
  function makeRenewalInstance(): RenewalService {
    return new RenewalService(
      prisma,
      app.get(AuditService),
      app.get(CheckoutService),
      app.get(MailSettingsService),
      app.get(SuspensionEffectsService),
    );
  }

  function makeLifecycleInstance(): OrderLifecycleService {
    return new OrderLifecycleService(
      prisma,
      app.get(AuditService),
      app.get(ProvisioningService),
    );
  }

  // ── Boot : fixtures AVANT init pour prouver que le démarrage ne bouge rien ─
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

    prisma = moduleRef.get(PrismaService);

    // ── Fixtures AVANT app.init() : le boot doit les laisser INTACTES ──────
    const mkUser = async (email: string, name: string) =>
      (
        await prisma.user.create({
          data: { email, name, passwordHash: await bcrypt.hash(password, 10), role: Role.USER },
        })
      ).id;
    momUserId = await mkUser(momEmail, 'Mom Q6');
    staleUserId = await mkUser(staleEmail, 'Stale Q6');
    momCustomerId = (
      await prisma.customer.create({
        data: { userId: momUserId, email: momEmail, name: 'Mom Q6' },
      })
    ).id;
    staleCustomerId = (
      await prisma.customer.create({
        data: { userId: staleUserId, email: staleEmail, name: 'Stale Q6' },
      })
    ).id;

    productId = (
      await prisma.product.create({
        data: {
          name: `Q6 prod ${stamp}`,
          billingCycle: BillingCycle.MONTHLY,
          priceHtCents: 1000,
        },
      })
    ).id;

    // Échéance de renouvellement : mère ACTIVE autoRenew + consentement échu,
    // facture mère réglée avec UNE ligne récurrente, abonnement lié ACTIVE.
    motherOrderId = (
      await prisma.order.create({
        data: {
          customerId: momCustomerId,
          customerName: 'Mom Q6',
          customerEmail: momEmail,
          productId,
          productName: `Q6 prod ${stamp}`,
          status: OrderStatus.ACTIVE,
          billingCycle: BillingCycle.MONTHLY,
          currency: 'USD',
          taxRatePercent: 20,
          amountHtCents: 1000,
          taxAmountCents: 200,
          amountTtcCents: 1200,
          autoRenew: true,
          renewalConsentAt: daysAgo(30),
          nextBillingDate: daysAgo(1),
        },
      })
    ).id;
    await prisma.invoice.create({
      data: {
        number: motherNumber,
        orderId: motherOrderId,
        customerId: momCustomerId,
        status: InvoiceStatus.PAID,
        paidAt: daysAgo(30),
        currency: 'USD',
        taxRatePercent: 20,
        amountHtCents: 1000,
        taxAmountCents: 200,
        amountTtcCents: 1200,
        issuedAt: daysAgo(30),
        lines: {
          create: [
            {
              kind: InvoiceLineKind.PRODUCT,
              label: 'Q6 produit récurrent',
              qty: 1,
              unitPriceHtCents: 1000,
              taxRatePercent: 20,
              taxAmountCents: 200,
              totalTtcCents: 1200,
              sortOrder: 0,
            },
          ],
        },
      },
    });
    subRenewId = (
      await prisma.subscription.create({
        data: {
          userId: momUserId,
          productId,
          orderId: motherOrderId,
          status: SubscriptionStatus.ACTIVE,
        },
      })
    ).id;

    // Impayé au-delà du grâce → suspension (abonnement SÉPARÉ du renouvellement).
    subSuspendId = (
      await prisma.subscription.create({
        data: { userId: momUserId, productId, status: SubscriptionStatus.ACTIVE },
      })
    ).id;
    await prisma.invoice.create({
      data: {
        number: overdueNumber,
        customerId: momCustomerId,
        subscriptionId: subSuspendId,
        status: InvoiceStatus.UNPAID,
        currency: 'USD',
        taxRatePercent: 20,
        amountHtCents: 1000,
        taxAmountCents: 200,
        amountTtcCents: 1200,
        issuedAt: daysAgo(40),
        dueDate: daysAgo(20), // > grâce (14 j) → suspendable ; aussi < horizon dunning
      },
    });

    // Commande périmée > 48 h → expiration (OrderLifecycleService).
    staleOrderId = (
      await prisma.order.create({
        data: {
          customerId: staleCustomerId,
          customerName: 'Stale Q6',
          customerEmail: staleEmail,
          productId,
          productName: `Q6 prod ${stamp}`,
          status: OrderStatus.PENDING_PAYMENT,
          billingCycle: BillingCycle.MONTHLY,
          currency: 'USD',
          taxRatePercent: 20,
          amountHtCents: 1000,
          taxAmountCents: 200,
          amountTtcCents: 1200,
          createdAt: daysAgo(3),
        },
      })
    ).id;
    await prisma.invoice.create({
      data: {
        number: staleNumber,
        orderId: staleOrderId,
        customerId: staleCustomerId,
        status: InvoiceStatus.UNPAID,
        currency: 'USD',
        taxRatePercent: 20,
        amountHtCents: 1000,
        taxAmountCents: 200,
        amountTtcCents: 1200,
        issuedAt: daysAgo(3),
        // dueDate NUL : hors périmètre dunning + suspension (le scan ne vise
        // que les échéances datées) — cette facture ne sert QUE l'expiration.
        dueDate: null,
      },
    });

    // Spy de provisioning : le boot NE DOIT RIEN lancer.
    provisionSpy = jest
      .spyOn(moduleRef.get(ProvisioningService), 'provisionOrder')
      .mockResolvedValue({ orderId: 'x', status: 'ACTIVE', fqdn: null, steps: [] });

    // ── BOOT (timers : configuration absente → OFF) ─────────────────────────
    await app.init();

    // Config SMTP minimale (sendPlain lève sans elle) — créée si absente.
    const priorMail = await prisma.mailSetting.findFirst();
    if (!priorMail || !priorMail.host || !priorMail.fromEmail) {
      createdMailId = (
        await prisma.mailSetting.create({
          data: {
            host: 'smtp.test.local',
            fromEmail: `noreply-${stamp}@test.local`,
            fromName: 'Code Diali Q6',
          },
        })
      ).id;
    }
  });

  afterAll(async () => {
    try {
      if (prisma) {
        const q6Orders = await prisma.order.findMany({
          where: { customerEmail: { in: [momEmail, staleEmail] } },
          select: { id: true },
        });
        const orderIds = q6Orders.map((o) => o.id);
        await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.subscription.deleteMany({ where: { productId } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
        await prisma.customer.deleteMany({ where: { email: { in: [momEmail, staleEmail] } } });
        await prisma.user.deleteMany({ where: { email: { in: [momEmail, staleEmail] } } });
        await prisma.product.delete({ where: { id: productId } });
        // Les rows de lease de CE test (infra globale : on ne touche que si
        // nommées comme les nôtres et vides d'autres porteurs — deleteMany
        // conditionné par les deux noms de sweep du dépôt).
        await prisma.sweepLease.deleteMany({
          where: { name: { in: ['renewal', 'order-lifecycle'] } },
        });
        if (createdMailId) await prisma.mailSetting.delete({ where: { id: createdMailId } });
      }
    } finally {
      await app.close();
    }
  });

  // ── 1. Démarrage configuration absente ────────────────────────────────────

  it('Q6 : démarrage sans configuration → timers absents + AUCUNE mutation', async () => {
    const renewal = app.get(RenewalService);
    const lifecycle = app.get(OrderLifecycleService);
    expect((renewal as unknown as { timer: unknown }).timer).toBeNull();
    expect((lifecycle as unknown as { timer: unknown }).timer).toBeNull();

    // Fenêtre d'observation : sans timer, rien ne s'exécute tout seul.
    await new Promise((r) => setTimeout(r, 250));

    const stale = await prisma.order.findUnique({ where: { id: staleOrderId } });
    expect(stale?.status).toBe(OrderStatus.PENDING_PAYMENT); // n'expire PAS
    const staleInv = await prisma.invoice.findUnique({ where: { number: staleNumber } });
    expect(staleInv?.status).toBe(InvoiceStatus.UNPAID);

    const overdue = await prisma.invoice.findUnique({ where: { number: overdueNumber } });
    expect(overdue?.status).toBe(InvoiceStatus.UNPAID); // ne débite/suspend PAS
    const subSuspend = await prisma.subscription.findUnique({ where: { id: subSuspendId } });
    expect(subSuspend?.status).toBe(SubscriptionStatus.ACTIVE);

    const mother = await prisma.order.findUnique({ where: { id: motherOrderId } });
    expect(mother?.autoRenew).toBe(true); // ne renouvelle PAS
    const children = await prisma.order.count({ where: { renewsOrderId: motherOrderId } });
    expect(children).toBe(0);

    expect(provisionSpy).not.toHaveBeenCalled(); // ne provisionne PAS
  });

  // ── 2. Lease multi-processus ──────────────────────────────────────────────

  it('Q6 : passe tenue par un AUTRE porteur → sweep refusé (zéro passe, fixtures intactes)', async () => {
    const held = await acquireSweepLease(prisma, 'renewal');
    expect(held).toEqual(expect.any(String));
    try {
      const svc = makeRenewalInstance();
      const res = await svc.sweep();

      expect(res).toEqual({ created: 0, paid: 0, pending: 0, reminded: 0, suspended: 0, stopped: 0 });
      // Aucune passe n'a tourné : l'impayé et la mère sont intacts.
      const overdue = await prisma.invoice.findUnique({ where: { number: overdueNumber } });
      expect(overdue?.status).toBe(InvoiceStatus.UNPAID);
      const subSuspend = await prisma.subscription.findUnique({ where: { id: subSuspendId } });
      expect(subSuspend?.status).toBe(SubscriptionStatus.ACTIVE);
      const children = await prisma.order.count({ where: { renewsOrderId: motherOrderId } });
      expect(children).toBe(0);
      // Le perdant n'a PAS libéré le lease d'un autre porteur.
      const row = await prisma.sweepLease.findUnique({ where: { name: 'renewal' } });
      expect(row?.holder).toBe(held);
      expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await releaseSweepLease(prisma, 'renewal', held!);
    }
  });

  // ── 3. Deux « processus » concurrents : invariants par CAS ────────────────

  it('Q6 : 2 instances RenewalService concurrentes → renouvellement/suspension/dunning UNE seule fois', async () => {
    const a = makeRenewalInstance();
    const b = makeRenewalInstance();

    const [ra, rb] = await Promise.all([a.sweep(), b.sweep()]);

    // Invariants : une SEULE création, UNE seule suspension, UNE seule relance.
    expect(ra.created + rb.created).toBe(1);
    expect(ra.suspended + rb.suspended).toBe(1);
    expect(ra.reminded + rb.reminded).toBe(1);
    expect(ra.paid + rb.paid).toBe(0); // solde à 0 → aucun débit possible

    const children = await prisma.order.findMany({
      where: { renewsOrderId: motherOrderId },
      select: { id: true },
    });
    expect(children.length).toBe(1); // JAMAIS deux renouvellements pour une mère

    const subSuspend = await prisma.subscription.findUnique({ where: { id: subSuspendId } });
    expect(subSuspend?.status).toBe(SubscriptionStatus.SUSPENDED);
    const autoSuspendAudits = await prisma.auditLog.count({
      where: { action: 'subscription.auto_suspend', resourceId: subSuspendId },
    });
    expect(autoSuspendAudits).toBe(1); // UNE transition = UNE trace

    const overdue = await prisma.invoice.findUnique({ where: { number: overdueNumber } });
    expect(overdue?.dunningRemindedAt).not.toBeNull(); // dunning fait UNE fois

    // La mère est close (autoRenew=false) : idempotent pour les sweeps suivants.
    const mother = await prisma.order.findUnique({ where: { id: motherOrderId } });
    expect(mother?.autoRenew).toBe(false);

    // Rejeu immédiat : aucun RENOUVELLEMENT/SUSPENSION/DUNNING/DÉBIT nouveau.
    // `pending` re-compte le renouvellement ENCORE impayé : re-tenter un
    // renouvellement en attente EST la passe `payPendingRenewals` par
    // conception (clé wallet idempotente → jamais de double débit).
    const c = makeRenewalInstance();
    const rc = await c.sweep();
    expect(rc).toMatchObject({
      created: 0,
      paid: 0,
      reminded: 0,
      suspended: 0,
      stopped: 0,
    });
    expect(rc.pending).toBe(1); // le renouvellement reste impayé (solde 0)
    expect(await prisma.order.count({ where: { renewsOrderId: motherOrderId } })).toBe(1);
  });

  // ── 4. Expiration : deux instances concurrentes, un seul audit ────────────

  it('Q6 : 2 instances OrderLifecycleService concurrentes → UNE expiration, UN SEUL audit', async () => {
    const a = makeLifecycleInstance();
    const b = makeLifecycleInstance();

    const [ra, rb] = await Promise.all([a.sweep(), b.sweep()]);

    expect(ra.expired + rb.expired).toBeGreaterThanOrEqual(1);

    const stale = await prisma.order.findUnique({ where: { id: staleOrderId } });
    expect(stale?.status).toBe(OrderStatus.CANCELLED); // CAS : basculé UNE fois
    const staleInv = await prisma.invoice.findUnique({ where: { number: staleNumber } });
    expect(staleInv?.status).toBe(InvoiceStatus.CANCELLED);

    // La preuve Q6 : le perdant n'AUDITE PAS la transition de l'autre.
    const expiredAudits = await prisma.auditLog.count({
      where: { action: 'order.expired', resourceId: staleOrderId },
    });
    expect(expiredAudits).toBe(1);
    const cancelledHistory = await prisma.orderStatusHistory.count({
      where: { orderId: staleOrderId, status: OrderStatus.CANCELLED },
    });
    expect(cancelledHistory).toBe(1);
  });
});
