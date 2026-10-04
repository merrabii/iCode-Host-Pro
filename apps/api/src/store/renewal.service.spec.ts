import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  BillingCycle,
  InvoiceStatus,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { MailSettingsService } from '../mail/mail-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { CheckoutService } from './checkout.service';
import { addBillingCycle } from './billing-cycle';
import { SuspensionEffectsService } from './suspension-effects.service';
import { RENEWAL_SCHEMA } from './sweep-guards';
import {
  RENEWAL_SWEEP_ENABLED_ENV,
  RENEWAL_SWEEP_MS_ENV,
  RenewalService,
} from './renewal.service';

/**
 * P8 (lot D2) + Q-A (GO items 1/4) + Q5/Q6 — matrice de décision du scheduler :
 *   - arrêt de chaîne (aucune souscription liée / produit changé) CAS idempotent ;
 *   - suspension admin = on n'arrête JAMAIS la chaîne (résumable) ;
 *   - création + paiement ATOMIQUE (`checkout.payOrderWithWallet` = débit +
 *     confirmation dans UNE tx, clé `wallet-pay:<orderId>`) ;
 *   - solde insuffisant → facture reste impayée, AUCUN crédit compensatoire ;
 *   - reprise : garde RE-VALIDÉE avant tout débit (jamais de prélèvement sur
 *     une chaîne close/suspendue/produit changé depuis la création) ;
 *   - dunning : UNE relance (CAS `dunningRemindedAt`) ;
 *   - suspension Q5 (GO item 5) : portée stricte facture → SON abonnement,
 *     verrous `FOR UPDATE` facture puis abonnement (course paiement/suspension
 *     sérialisée), services hébergement dans la MÊME tx, effets provider
 *     post-commit via SuspensionEffectsService (arrêt réversible, aucune
 *     suppression), email SANS revendication d'« accès suspendu » ;
 *   - Q6 (GO item 6) : timer OFF par défaut (activation explicite `=true`),
 *     prérequis de schéma avant toute mutation, exclusion multi-processus par
 *     lease `SweepLease` en base (le booléen `running` local n'est qu'une
 *     passe rapide) + coupe-timer d'isolement de test.
 */
describe('RenewalService (D2 — échéances, renouvellement, dunning)', () => {
  let prisma: {
    order: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
    };
    subscription: { findFirst: jest.Mock; updateMany: jest.Mock };
    invoice: { findMany: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock };
    walletTransaction: { findFirst: jest.Mock };
    billingSetting: { findFirst: jest.Mock };
    orderStatusHistory: { create: jest.Mock };
    sweepLease: { updateMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let wallet: { debit: jest.Mock; credit: jest.Mock };
  let checkout: {
    confirmOrderPaid: jest.Mock;
    payOrderWithWallet: jest.Mock;
  };
  let mail: { sendPlain: jest.Mock };
  let effects: { suspendApps: jest.Mock; resumeApps: jest.Mock };
  let svc: RenewalService;
  let lastTx: ReturnType<typeof txStub> | null = null;

  const head = (over: Record<string, unknown> = {}) => ({
    id: 'mother-1',
    renewsOrderId: null,
    customerId: 'cus-1',
    customerName: 'Alice',
    customerEmail: 'alice@test.local',
    customerPhone: null,
    productId: 'prod-1',
    productName: 'Hébergement Pro',
    packId: 'pack-1',
    billingCycle: BillingCycle.MONTHLY,
    currency: 'USD',
    taxRatePercent: 20,
    amountHtCents: 1000,
    taxAmountCents: 200,
    amountTtcCents: 1200,
    paymentMethodId: null,
    paymentMethodName: null,
    optionsSnapshot: null,
    addonsSnapshot: null,
    nextBillingDate: new Date('2026-09-01T00:00:00.000Z'),
    renewalConsentAt: new Date('2026-08-01T00:00:00.000Z'),
    customer: { userId: 'user-1' },
    ...over,
  });

  const settings = (over: Record<string, unknown> = {}) => ({
    id: 'billing-settings',
    invoiceDueDays: 14,
    dunningReminderDays: 3,
    dunningGraceDays: 14,
    currency: 'USD',
    ...over,
  });

  /** Transaction interne factice (création renouvellement + claim séquence). */
  const txStub = (renewalOver: Record<string, unknown> = {}) => ({
    order: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(async () => ({ id: 'renewal-1', ...renewalOver })),
    },
    invoice: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'inv-renewal-1',
        amountTtcCents: (args.data.amountTtcCents as number) ?? 0,
        number: (args.data.number as string) ?? '',
      })),
    },
    orderStatusHistory: { create: jest.fn(async () => ({})) },
    billingSetting: { findFirst: jest.fn(async () => settings()) },
    $queryRaw: jest.fn(async () => [{ next: 42 }]),
  });

  beforeEach(async () => {
    delete process.env[RENEWAL_SWEEP_ENABLED_ENV]; // héréditarité d'un worker
    prisma = {
      order: {
        findMany: jest.fn(async () => []),
        findUnique: jest.fn(async () => null), // remontée de chaîne renewsOrderId
        updateMany: jest.fn(async () => ({ count: 1 })),
        create: jest.fn(),
      },
      subscription: { findFirst: jest.fn(async () => null), updateMany: jest.fn(async () => ({ count: 1 })) },
      invoice: { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 1 })), findUnique: jest.fn(), create: jest.fn() },
      walletTransaction: { findFirst: jest.fn(async () => null) },
      billingSetting: { findFirst: jest.fn(async () => settings()) },
      orderStatusHistory: { create: jest.fn() },
      // Q6 : lease de passe multi-processus (par défaut = pas de row → création → token).
      sweepLease: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => ({})),
      },
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = txStub();
        lastTx = tx;
        return cb(tx);
      }),
      // Q6 : probe `information_schema` des prérequis (les autres requêtes
      // raw du domaine passent par les TX mockées ci-dessous).
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join(' ');
        if (sql.includes('information_schema.columns')) {
          const table = String(values[0]);
          const req = RENEWAL_SCHEMA.find((r) => r.table === table);
          if (!req) return [];
          return (req.columns ?? ['id']).map((c) => ({ column_name: c }));
        }
        return [{ next: 42 }];
      }),
    };
    lastTx = null;
    audit = { record: jest.fn(async () => undefined) };
    wallet = { debit: jest.fn(async () => ({ ok: true })), credit: jest.fn(async () => ({ ok: true })) };
    checkout = {
      confirmOrderPaid: jest.fn(async () => ({ alreadyConfirmed: false })),
      payOrderWithWallet: jest.fn(async () => ({
        orderId: 'x',
        status: 'PAID',
        balanceCents: 500,
        amountTtcCents: 1200,
        replayed: false,
        alreadyConfirmed: false,
      })),
    };
    mail = { sendPlain: jest.fn(async () => undefined) };
    effects = {
      suspendApps: jest.fn(async () => ({ apps: 0, done: 0, blocked: 0, failed: 0 })),
      resumeApps: jest.fn(async () => ({ apps: 0, done: 0, blocked: 0, failed: 0 })),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: WalletService, useValue: wallet },
        { provide: CheckoutService, useValue: checkout },
        { provide: MailSettingsService, useValue: mail },
        { provide: SuspensionEffectsService, useValue: effects },
        RenewalService,
      ],
    }).compile();
    svc = moduleRef.get(RenewalService);
  });

  // ── 1. Renouvellement : création + paiement ────────────────────────────────

  it('crée la commande de renouvellement, paie ATOMIQUEMENT (débit+confirm en une tx)', async () => {
    prisma.order.findMany.mockResolvedValueOnce([head()]); // échéances
    prisma.order.findMany.mockResolvedValueOnce([]); // payPending
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'sub-1',
      productId: 'prod-1',
      status: SubscriptionStatus.ACTIVE,
    });

    const res = await svc.sweep();

    expect(res).toMatchObject({ created: 1, paid: 1, pending: 0, stopped: 0, reminded: 0, suspended: 0 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // La mère bascule autoRenew=false par CAS dans LA MÊME transaction.
    expect(lastTx?.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'mother-1', autoRenew: true },
      data: { autoRenew: false },
    });
    // Q-A (item 1) : paiement ATOMIQUE — plus de débit séparé + confirmation.
    expect(checkout.payOrderWithWallet).toHaveBeenCalledTimes(1);
    expect(checkout.payOrderWithWallet).toHaveBeenCalledWith('renewal-1', {
      sub: 'user-1',
      email: 'alice@test.local',
      role: Role.USER,
    });
    expect(wallet.debit).not.toHaveBeenCalled();
    expect(checkout.confirmOrderPaid).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'subscription.renewal_created',
      resourceId: 'renewal-1',
    }));
  });

  it('solde insuffisant → renouvellement PENDING (aucune confirmation, aucun crédit fabriqué)', async () => {
    prisma.order.findMany.mockResolvedValueOnce([head()]);
    prisma.order.findMany.mockResolvedValueOnce([]);
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'sub-1',
      productId: 'prod-1',
      status: SubscriptionStatus.ACTIVE,
    });
    checkout.payOrderWithWallet.mockRejectedValueOnce(new ConflictException('Solde insuffisant.'));

    const res = await svc.sweep();

    expect(res).toMatchObject({ created: 1, paid: 0, pending: 1 });
    expect(checkout.confirmOrderPaid).not.toHaveBeenCalled();
    expect(wallet.credit).not.toHaveBeenCalled();
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  // ── 1b. Gardes d'éligibilité ───────────────────────────────────────────────

  it('aucune souscription active → arrêt définitif de la chaîne (CAS + audit), rien de créé', async () => {
    prisma.order.findMany.mockResolvedValueOnce([head()]);
    prisma.subscription.findFirst.mockResolvedValue(null);

    const res = await svc.sweep();

    expect(res).toMatchObject({ created: 0, stopped: 1 });
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'mother-1', autoRenew: true },
      data: { autoRenew: false },
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'renewal.chain_stopped',
      details: expect.objectContaining({ reason: 'no_active_subscription' }),
    }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('produit changé (upgrade) → arrêt avec raison product_changed', async () => {
    prisma.order.findMany.mockResolvedValueOnce([head()]);
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'sub-1',
      productId: 'autre-produit',
      status: SubscriptionStatus.ACTIVE,
    });

    const res = await svc.sweep();

    expect(res.stopped).toBe(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'renewal.chain_stopped',
      details: expect.objectContaining({ reason: 'product_changed' }),
    }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('souscription suspendue → on N\u2019arrête PAS la chaîne (résumable, aucun flip)', async () => {
    prisma.order.findMany.mockResolvedValueOnce([head()]);
    prisma.subscription.findFirst
      .mockResolvedValueOnce(null) // chaîne : aucun abonnement lié
      .mockResolvedValueOnce(null) // fallback : pas d'ACTIVE
      .mockResolvedValueOnce({ status: SubscriptionStatus.SUSPENDED }); // dernière connue

    const res = await svc.sweep();

    expect(res).toMatchObject({ created: 0, stopped: 0 });
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('aucune échéance → aucune écriture', async () => {
    prisma.order.findMany.mockResolvedValueOnce([]);
    prisma.order.findMany.mockResolvedValueOnce([]);
    const res = await svc.sweep();
    expect(res).toMatchObject({ created: 0, paid: 0, pending: 0, reminded: 0, suspended: 0, stopped: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  // ── 2. Reprise de paiement ────────────────────────────────────────────────

  it('renouvellement PENDING → reprise ATOMIQUE (garde re-validée, aucun débit isolé)', async () => {
    prisma.order.findMany.mockResolvedValueOnce([]); // aucune échéance
    prisma.order.findMany.mockResolvedValueOnce([{
      id: 'renewal-1',
      renewsOrderId: 'mother-1',
      productId: 'prod-1',
      amountTtcCents: 1200,
      customerEmail: 'alice@test.local',
      customer: { userId: 'user-1' },
      invoice: { number: '2026-0041' },
    }]);
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'sub-1',
      productId: 'prod-1',
      status: SubscriptionStatus.ACTIVE,
    });

    const res = await svc.sweep();

    expect(res).toMatchObject({ paid: 1, pending: 0 });
    // Q-A : le « déjà prélevé → re-confirmé sans 2e débit » vit MAINTENANT
    // dans payOrderWithWallet (net des débits non compensés, e2e PG).
    expect(checkout.payOrderWithWallet).toHaveBeenCalledTimes(1);
    expect(wallet.debit).not.toHaveBeenCalled();
    expect(checkout.confirmOrderPaid).not.toHaveBeenCalled();
  });

  it('renouvellement impayé sans débit → nouvel essai de prélèvement (recharge tardive)', async () => {
    prisma.order.findMany.mockResolvedValueOnce([]);
    prisma.order.findMany.mockResolvedValueOnce([{
      id: 'renewal-1',
      renewsOrderId: 'mother-1',
      productId: 'prod-1',
      amountTtcCents: 1200,
      customerEmail: 'alice@test.local',
      customer: { userId: 'user-1' },
      invoice: { number: '2026-0041' },
    }]);
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'sub-1',
      productId: 'prod-1',
      status: SubscriptionStatus.ACTIVE,
    });
    checkout.payOrderWithWallet.mockRejectedValueOnce(new ConflictException('Solde insuffisant.'));

    const res = await svc.sweep();

    expect(res).toMatchObject({ paid: 0, pending: 1 });
    expect(checkout.payOrderWithWallet).toHaveBeenCalledTimes(1);
    expect(checkout.confirmOrderPaid).not.toHaveBeenCalled();
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('Q-A : chaîne close depuis la création → AUCUN débit à la reprise (garde re-validée)', async () => {
    prisma.order.findMany.mockResolvedValueOnce([]);
    prisma.order.findMany.mockResolvedValueOnce([{
      id: 'renewal-1',
      renewsOrderId: 'mother-1',
      productId: 'prod-1',
      amountTtcCents: 1200,
      customerEmail: 'alice@test.local',
      customer: { userId: 'user-1' },
      invoice: { number: '2026-0041' },
    }]);
    // Garde : plus d'abonnement lié (annulé entre-temps) → stop.
    prisma.subscription.findFirst.mockResolvedValue(null);

    const res = await svc.sweep();

    expect(res).toMatchObject({ paid: 0, pending: 1 });
    expect(checkout.payOrderWithWallet).not.toHaveBeenCalled();
    expect(wallet.debit).not.toHaveBeenCalled();
    expect(checkout.confirmOrderPaid).not.toHaveBeenCalled();
  });

  // ── 3. Dunning : relance unique ───────────────────────────────────────────

  it('relance d\u2019impayé UNE fois (CAS dunningRemindedAt), puis jamais plus', async () => {
    const inv = {
      id: 'inv-unpaid',
      number: '2026-0042',
      dueDate: new Date('2026-10-01T00:00:00.000Z'),
      amountTtcCents: 1200,
      currency: 'USD',
      customer: { email: 'alice@test.local', name: 'Alice' },
    };
    prisma.order.findMany.mockResolvedValueOnce([]);
    prisma.order.findMany.mockResolvedValueOnce([]);
    prisma.invoice.findMany.mockResolvedValueOnce([inv]); // dunning

    const res1 = await svc.sweep();
    expect(res1.reminded).toBe(1);
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'inv-unpaid', status: InvoiceStatus.UNPAID, dunningRemindedAt: null },
      data: { dunningRemindedAt: expect.any(Date) },
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.dunning_reminder',
      resourceId: 'inv-unpaid',
    }));
    expect(mail.sendPlain).toHaveBeenCalledTimes(1);

    // 2e passage : CAS perd (déjà rappelée) → aucune seconde relance.
    prisma.invoice.updateMany.mockResolvedValueOnce({ count: 0 });
    const res2 = await svc.sweep();
    expect(res2.reminded).toBe(0);
    expect(mail.sendPlain).toHaveBeenCalledTimes(1);
  });

  // ── 4. Suspension à échéance Q5 (portée stricte, verrous, effets) ────────

  /** Facture impayée liée à SON abonnement (les 3 champs de résolution Q5). */
  const overdueInvoice = (over: Record<string, unknown> = {}) => ({
    id: 'inv-overdue',
    number: '2026-0042',
    dueDate: new Date('2026-01-01T00:00:00.000Z'),
    amountTtcCents: 1200,
    currency: 'USD',
    subscriptionId: 'sub-1',
    orderId: 'ord-1',
    customer: { userId: 'user-1', email: 'alice@test.local', name: 'Alice' },
    ...over,
  });

  /** Les 4 passes de sweep : échéances, payPending, dunning, suspension. */
  const stubSweepPasses = (overdue: unknown[]) => {
    prisma.order.findMany.mockResolvedValueOnce([]); // échéances
    prisma.order.findMany.mockResolvedValueOnce([]); // payPending
    prisma.invoice.findMany.mockResolvedValueOnce([]); // dunning
    prisma.invoice.findMany.mockResolvedValueOnce(overdue); // suspension
  };

  /** TX de suspension Q5 : verrou Invoice → résolution → verrou Subscription
   *  → sonde HostingService → CAS. L'ordre des `$queryRaw` suit l'appel réel. */
  const suspendTx = (opts: {
    invoiceRow?: Record<string, unknown> | null;
    subRow?: Record<string, unknown> | null;
    subResolve?: { id: string } | null;
    probe?: boolean;
    casCount?: number;
  } = {}) => {
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([opts.invoiceRow ?? null]) // verrou Invoice
        .mockResolvedValueOnce([opts.subRow ?? null]) // verrou Subscription
        .mockResolvedValue([{ exists: opts.probe ?? false }]), // sonde HostingService
      subscription: {
        findFirst: jest.fn(async () => opts.subResolve ?? null),
        updateMany: jest.fn(async () => ({ count: opts.casCount ?? 1 })),
      },
      hostingService: { updateMany: jest.fn(async () => ({ count: 1 })) },
      order: { findUnique: jest.fn(async () => null) },
    };
    prisma.$transaction.mockImplementationOnce(
      async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    );
    return tx;
  };

  it('impayé au-delà du grâce → SON abonnement suspendu (verrous + CAS), services + effets réversibles', async () => {
    stubSweepPasses([overdueInvoice()]);
    const tx = suspendTx({
      invoiceRow: {
        id: 'inv-overdue',
        status: 'UNPAID',
        dueDate: new Date('2026-01-01T00:00:00.000Z'),
        subscriptionId: 'sub-1',
        orderId: 'ord-1',
      },
      subRow: { id: 'sub-1', status: 'ACTIVE', orderId: 'ord-1' },
      subResolve: { id: 'sub-1' },
      probe: true,
    });

    const res = await svc.sweep();

    expect(res.suspended).toBe(1);
    expect(tx.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: 'sub-1', status: SubscriptionStatus.ACTIVE },
      data: { status: SubscriptionStatus.SUSPENDED },
    });
    // Services hébergement du SEUL abonnement concerné, MÊME transaction.
    expect(tx.hostingService.updateMany).toHaveBeenCalledWith({
      where: { subscriptionId: 'sub-1', status: 'ACTIVE' },
      data: { status: 'SUSPENDED' },
    });
    // Effets provider post-commit via SuspensionEffectsService (aucune suppression).
    expect(effects.suspendApps).toHaveBeenCalledWith({
      subscriptionId: 'sub-1',
      holder: 'system:renewal-sweep',
      orderId: 'ord-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'subscription.auto_suspend',
        resourceId: 'sub-1',
        details: expect.objectContaining({
          reason: 'invoice_overdue',
          scope: 'invoice_subscription',
        }),
      }),
    );
    expect(mail.sendPlain).toHaveBeenCalledTimes(1);
    const text = mail.sendPlain.mock.calls[0][0].text as string;
    expect(text).toContain('Votre abonnement est suspendu');
    expect(text).not.toMatch(/acc[eè]s est suspendu/);
    // Aucun accès direct provisioning/panel sur le service : tout passe par
    // SuspensionEffectsService (mocké ci-dessus).
    expect((svc as unknown as Record<string, unknown>).provisioning).toBeUndefined();
    expect((svc as unknown as Record<string, unknown>).panel).toBeUndefined();
  });

  it('Q5 : facture réglée sous verrou (course paiement/suspension) → AUCUNE suspension', async () => {
    stubSweepPasses([overdueInvoice()]);
    const tx = suspendTx({
      invoiceRow: {
        id: 'inv-overdue',
        status: 'PAID', // le paiement a committé avant notre verrou
        dueDate: new Date('2026-01-01T00:00:00.000Z'),
        subscriptionId: 'sub-1',
        orderId: 'ord-1',
      },
    });

    const res = await svc.sweep();

    expect(res.suspended).toBe(0);
    expect(tx.subscription.updateMany).not.toHaveBeenCalled();
    expect(effects.suspendApps).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subscription.auto_suspend' }),
    );
    expect(mail.sendPlain).not.toHaveBeenCalled();
  });

  it('Q5 : facture SANS lien d\u2019abonnement → AUCUNE autre souscription du client touch\u00e9e (port\u00e9e stricte)', async () => {
    // L'ancien défaut suspendait « le dernier ACTIVE du client » : le
    // r\u00e9gression doit prouver qu'aucune souscription n'est m\u00eame lue.
    stubSweepPasses([overdueInvoice({ subscriptionId: null, orderId: null })]);
    const tx = suspendTx({
      invoiceRow: {
        id: 'inv-overdue',
        status: 'UNPAID',
        dueDate: new Date('2026-01-01T00:00:00.000Z'),
        subscriptionId: null,
        orderId: null,
      },
    });

    const res = await svc.sweep();

    expect(res.suspended).toBe(0);
    expect(tx.subscription.findFirst).not.toHaveBeenCalled();
    expect(tx.subscription.updateMany).not.toHaveBeenCalled();
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
    expect(effects.suspendApps).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subscription.auto_suspend' }),
    );
    expect(mail.sendPlain).not.toHaveBeenCalled();
  });

  it('souscription d\u00e9j\u00e0 suspendue \u2192 idempotent (aucun double audit, aucun effet)', async () => {
    stubSweepPasses([overdueInvoice()]);
    const tx = suspendTx({
      invoiceRow: {
        id: 'inv-overdue',
        status: 'UNPAID',
        dueDate: new Date('2026-01-01T00:00:00.000Z'),
        subscriptionId: 'sub-1',
        orderId: 'ord-1',
      },
      subRow: { id: 'sub-1', status: 'SUSPENDED', orderId: 'ord-1' },
      subResolve: { id: 'sub-1' },
    });

    const res = await svc.sweep();

    expect(res.suspended).toBe(0);
    expect(tx.subscription.updateMany).not.toHaveBeenCalled();
    expect(effects.suspendApps).not.toHaveBeenCalled();
    expect(mail.sendPlain).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subscription.auto_suspend' }),
    );
  });

  it('Q5 : arr\u00eats bloqu\u00e9s/\u00e9chou\u00e9s \u2192 email honn\u00eate (jamais « acc\u00e8s suspendu »)', async () => {
    stubSweepPasses([overdueInvoice()]);
    suspendTx({
      invoiceRow: {
        id: 'inv-overdue',
        status: 'UNPAID',
        dueDate: new Date('2026-01-01T00:00:00.000Z'),
        subscriptionId: 'sub-1',
        orderId: 'ord-1',
      },
      subRow: { id: 'sub-1', status: 'ACTIVE', orderId: 'ord-1' },
      subResolve: { id: 'sub-1' },
    });
    effects.suspendApps.mockResolvedValueOnce({ apps: 2, done: 0, blocked: 1, failed: 1 });

    const res = await svc.sweep();

    expect(res.suspended).toBe(1);
    const text = mail.sendPlain.mock.calls[0][0].text as string;
    expect(text).toMatch(/bloqu\u00e9 ou en \u00e9chec/);
    expect(text).not.toMatch(/acc[eè]s est suspendu/);
  });

  it('Q5 : \u00e9chec des effets provider \u2192 suspension maintenue, sweep non cass\u00e9', async () => {
    stubSweepPasses([overdueInvoice()]);
    suspendTx({
      invoiceRow: {
        id: 'inv-overdue',
        status: 'UNPAID',
        dueDate: new Date('2026-01-01T00:00:00.000Z'),
        subscriptionId: 'sub-1',
        orderId: 'ord-1',
      },
      subRow: { id: 'sub-1', status: 'ACTIVE', orderId: 'ord-1' },
      subResolve: { id: 'sub-1' },
    });
    effects.suspendApps.mockRejectedValueOnce(new Error('panel down'));

    const res = await svc.sweep();

    expect(res.suspended).toBe(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subscription.auto_suspend' }),
    );
    expect(mail.sendPlain).toHaveBeenCalledTimes(1);
  });

  // ── 5. Ordonnanceur ───────────────────────────────────────────────────────

  it('anti-chevauchement : un 2e sweep pendant un sweep en vol retourne des zéros', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    prisma.order.findMany.mockImplementationOnce(async () => {
      await gate;
      return [];
    });

    const first = svc.sweep();
    const second = await svc.sweep();
    expect(second).toEqual({ created: 0, paid: 0, pending: 0, reminded: 0, suspended: 0, stopped: 0 });
    release();
    await first;
  });

  // ── Q6 (GO item 6) : activation explicite + prérequis + lease ─────────────

  it('Q6 : configuration ABSENTE → aucun timer au démarrage (aucune mutation auto)', () => {
    delete process.env[RENEWAL_SWEEP_ENABLED_ENV];
    const spy = jest.spyOn(global, 'setInterval');
    try {
      svc.onModuleInit();
      expect(spy).not.toHaveBeenCalled();
      expect((svc as unknown as { timer: unknown }).timer).toBeNull();
      // Aucune lecture/écriture immédiate au boot : zéro expiration, zéro
      // débit, zéro suspension, zéro provisionnement.
      expect(prisma.order.findMany).not.toHaveBeenCalled();
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('RENEWAL_SWEEP_ENABLED=false → aucun timer au démarrage', () => {
    process.env[RENEWAL_SWEEP_ENABLED_ENV] = 'false';
    const spy = jest.spyOn(global, 'setInterval');
    try {
      svc.onModuleInit();
      expect(spy).not.toHaveBeenCalled();
      expect((svc as unknown as { timer: unknown }).timer).toBeNull();
    } finally {
      spy.mockRestore();
      delete process.env[RENEWAL_SWEEP_ENABLED_ENV];
    }
  });

  it('Q6 : activation explicite =true → timer planifié à l’intervalle, arrêt propre', () => {
    process.env[RENEWAL_SWEEP_ENABLED_ENV] = 'true';
    process.env[RENEWAL_SWEEP_MS_ENV] = '123456';
    const spy = jest.spyOn(global, 'setInterval');
    try {
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 123456);
      expect((svc as unknown as { timer: unknown }).timer).not.toBeNull();
    } finally {
      svc.onModuleDestroy();
      spy.mockRestore();
      delete process.env[RENEWAL_SWEEP_ENABLED_ENV];
      delete process.env[RENEWAL_SWEEP_MS_ENV];
    }
    expect((svc as unknown as { timer: unknown }).timer).toBeNull();
  });

  it('Q6 : prérequis de schéma absents → AUCUNE mutation (zéro passe, zéro lease)', async () => {
    // La probe `information_schema` ne voit pas les colonnes exigées.
    prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join(' ').includes('information_schema.columns')) return [];
      return [{ next: 42 }];
    });

    const res = await svc.sweep();

    expect(res).toEqual({ created: 0, paid: 0, pending: 0, reminded: 0, suspended: 0, stopped: 0 });
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(prisma.billingSetting.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.sweepLease.updateMany).not.toHaveBeenCalled(); // même le lease n'est pas écrit
    expect(prisma.sweepLease.create).not.toHaveBeenCalled();
  });

  it('Q6 : lease tenu par un AUTRE processus → passage refusé (aucune passe)', async () => {
    prisma.sweepLease.updateMany.mockResolvedValueOnce({ count: 0 }); // steal : row vivante
    prisma.sweepLease.findUnique.mockResolvedValueOnce({
      name: 'renewal',
      holder: 'process- autre',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await svc.sweep();

    expect(res).toEqual({ created: 0, paid: 0, pending: 0, reminded: 0, suspended: 0, stopped: 0 });
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    // Le perdant ne libère PAS le lease d'un autre porteur.
    expect(prisma.sweepLease.updateMany).toHaveBeenCalledTimes(1);
  });

  it('Q6 : lease non acquérable (base indisponible / course de création) → aucun passage', async () => {
    // Course de création : steal 0, pas de row, la création échoue (P2002).
    prisma.sweepLease.create.mockRejectedValueOnce(new Error('duplicate key'));

    const res = await svc.sweep();

    expect(res).toEqual({ created: 0, paid: 0, pending: 0, reminded: 0, suspended: 0, stopped: 0 });
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(prisma.sweepLease.updateMany).toHaveBeenCalledTimes(1); // steal seulement, pas de release
  });

  it('Q6 : lease acquis puis LIBÉRÉ en fin de passage (finally)', async () => {
    stubSweepPasses([]);

    await svc.sweep();

    // Release : row conditionnée par le jeton du porteur, expiration à l'époque.
    expect(prisma.sweepLease.updateMany).toHaveBeenCalledWith({
      where: { name: 'renewal', holder: expect.any(String) },
      data: { expiresAt: new Date(0) },
    });
  });

  it('Q6 : échec d’une passe → lease LIBÉRÉ et running réinitialisé (finally)', async () => {
    prisma.order.findMany.mockRejectedValueOnce(new Error('db down'));

    await expect(svc.sweep()).rejects.toThrow('db down');

    expect(prisma.sweepLease.updateMany).toHaveBeenCalledWith({
      where: { name: 'renewal', holder: expect.any(String) },
      data: { expiresAt: new Date(0) },
    });
    // Le verrou local est relâché : le sweep suivant repasse les gardes.
    stubSweepPasses([]);
    await expect(svc.sweep()).resolves.toEqual({
      created: 0,
      paid: 0,
      pending: 0,
      reminded: 0,
      suspended: 0,
      stopped: 0,
    });
  });
});

describe('addBillingCycle — échéance du cycle (P8)', () => {
  it('ONETIME → null (aucune échéance, aucun renouvellement)', () => {
    expect(addBillingCycle(new Date('2026-10-03T10:00:00Z'), BillingCycle.ONETIME)).toBeNull();
  });

  it('MONTHLY : même jour mois suivant, ms exactes (d\u00e9terministe)', () => {
    const from = new Date('2026-10-03T14:30:15.123Z');
    expect(addBillingCycle(from, BillingCycle.MONTHLY)!.getTime()).toBe(
      Date.UTC(2026, 10, 3, 14, 30, 15, 123),
    );
  });

  it('MONTHLY clamp\u00e9 : 31 janvier \u2192 28 f\u00e9vrier (jamais de d\u00e9rive au 1er)', () => {
    expect(addBillingCycle(new Date('2026-01-31T09:00:00Z'), BillingCycle.MONTHLY)).toEqual(
      new Date('2026-02-28T09:00:00Z'),
    );
    // Bissextile : 31 janv. 2028 \u2192 29 f\u00e9vr. 2028.
    expect(addBillingCycle(new Date('2028-01-31T09:00:00Z'), BillingCycle.MONTHLY)).toEqual(
      new Date('2028-02-29T09:00:00Z'),
    );
    // Clamp aussi sur mois court : 31 ao\u00fbt \u2192 30 septembre.
    expect(addBillingCycle(new Date('2026-08-31T09:00:00Z'), BillingCycle.MONTHLY)).toEqual(
      new Date('2026-09-30T09:00:00Z'),
    );
  });

  it('YEARLY : m\u00eame jour l\u2019ann\u00e9e suivante (clamp f\u00e9vrier bissextile)', () => {
    expect(addBillingCycle(new Date('2026-07-15T12:00:00Z'), BillingCycle.YEARLY)).toEqual(
      new Date('2027-07-15T12:00:00Z'),
    );
    expect(addBillingCycle(new Date('2028-02-29T12:00:00Z'), BillingCycle.YEARLY)).toEqual(
      new Date('2029-02-28T12:00:00Z'),
    );
  });
});
