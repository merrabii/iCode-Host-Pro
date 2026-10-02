import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CheckoutService, CheckoutReplaySignal } from './checkout.service';

/**
 * 17B.4F-C3 + GO socle commercial — checkout sous garde ON :
 * capability LIVE + fast-fails AVANT toute écriture, verrou `User` + rejeu
 * sous verrou + recheck d'abonnement DANS la transaction.
 *
 * Sémantique de paiement (GO) : la commande est créée `PENDING_PAYMENT`
 * SANS aucune écriture de droits (ni abonnement, ni tracking C3, ni service,
 * ni provisioning). Les écritures de droits sont déplacées dans
 * `confirmOrderPaid` (confirmation serveur) — testé ici en différé.
 * OFF : comportement legacy inchangé (aucune écriture C3, aucune capability).
 */
describe('checkout C3 (17B.4F-C3) + confirmation de paiement', () => {
  const C3_ENV = 'HOSTING_C3_ENABLED';

  const product = {
    id: 'prod1',
    name: 'Site Starter',
    slug: 'site-starter',
    priceHtCents: 4900,
    billingCycle: 'MONTHLY',
    packId: 'pack1',
    options: [],
    addons: [],
    taxRate: null,
    installationFeeCents: 0,
    freeSubdomainRule: null,
  };

  const catalog = {
    packId: 'pack1',
    provisionModuleId: 'pm-mod1',
    moduleParams: {
      repoUrl: 'https://github.com/acme/site.git',
      branch: 'main',
      buildPack: 'static',
      appName: 'site',
      publishDirectory: 'dist',
      isStatic: true,
    },
    provisionModule: { actions: ['CREATE_APP'] },
    pack: {
      id: 'pack1',
      name: 'Starter',
      ramMb: 1024,
      cpuCores: 1,
      storageLimit: null,
      maxApps: 3,
      status: 'ACTIVE',
      deploymentModuleId: 'mod1',
    },
  };

  type State = {
    product: Record<string, unknown>;
    catalog: Record<string, unknown> | null;
    intentOrders: Array<Record<string, unknown>>;
    ordersById: Record<string, Record<string, unknown>>;
    txDup: Record<string, unknown> | null;
    txConfirmOrder: Record<string, any> | null;
    preSub: Record<string, unknown> | null;
    txSub: Record<string, unknown> | null;
    user: Record<string, unknown> | null;
    txUserLock: Array<{ id: string }>;
    simulateOrder: Record<string, any> | null;
  };

  const defaultState = (): State => ({
    product,
    catalog,
    intentOrders: [],
    ordersById: {},
    txDup: null,
    txConfirmOrder: null,
    preSub: null,
    txSub: null,
    user: null,
    txUserLock: [{ id: 'u1' }],
    simulateOrder: null,
  });

  let state: State;
  let tx: Record<string, any>;
  let prisma: Record<string, any>;
  let c3: Record<string, jest.Mock>;
  let svc: CheckoutService;

  const make = () => {
    state = defaultState();

    tx = {
      $queryRaw: jest.fn((strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('UPDATE "BillingSetting"')) return [{ next: 7 }];
        if (sql.includes('FROM "User"')) return state.txUserLock;
        return [];
      }),
      order: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.idempotencyKey) return state.txDup;
          if (where.id) return state.txConfirmOrder;
          return null;
        }),
        findMany: jest.fn(async () => []),
        create: jest.fn(async ({ data }: any) => ({ id: 'ord-new', ...data })),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const o = state.txConfirmOrder;
          if (!o || o.id !== where.id || o.status !== where.status) return { count: 0 };
          Object.assign(o, data ?? {});
          return { count: 1 };
        }),
      },
      subscription: {
        findFirst: jest.fn(async () => state.txSub),
        create: jest.fn(async ({ data }: any) => ({ id: 'sub1', ...data })),
        update: jest.fn(async ({ data }: any) => ({ id: 'sub1', ...data })),
      },
      billingSetting: {
        findFirst: jest.fn(async () => ({ id: 'b1', currency: 'EUR', invoiceSequence: 6 })),
        create: jest.fn(async () => ({ id: 'b1', currency: 'EUR', invoiceSequence: 0 })),
      },
      user: {
        create: jest.fn(async ({ data }: any) => ({ id: 'u-new', ...data })),
      },
      customer: {
        create: jest.fn(async ({ data }: any) => ({ id: 'c-new', ...data })),
      },
      orderProvisioningTracking: {
        create: jest.fn(async ({ data }: any) => ({ id: 'trk1', ...data })),
      },
      hostingService: {
        create: jest.fn(async ({ data }: any) => ({ id: 'hs1', ...data })),
      },
      invoice: {
        create: jest.fn(async ({ data }: any) => ({ id: 'inv1', ...data })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      orderStatusHistory: {
        create: jest.fn(async ({ data }: any) => ({ id: 'h1', ...data })),
      },
    };

    prisma = {
      $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
      paymentMethod: {
        findFirst: jest.fn(async () => ({ id: 'pm1', name: 'Carte', isActive: true })),
      },
      order: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.clientKey) return null;
          if (where.id) return state.ordersById[where.id] ?? null;
          return null;
        }),
        findMany: jest.fn(async () => state.intentOrders),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const o = state.simulateOrder;
          if (!o || o.id !== where.id || o.status !== where.status) return { count: 0 };
          Object.assign(o, data ?? {});
          return { count: 1 };
        }),
      },
      user: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id && state.user && where.id === state.user.id ? state.user : null,
        ),
      },
      customer: {
        findUnique: jest.fn(async () => ({ id: 'cust1' })),
      },
      subscription: {
        findFirst: jest.fn(async () => state.preSub),
      },
      product: {
        findUnique: jest.fn(async () => state.catalog),
      },
      invoice: {
        findUnique: jest.fn(async () => ({ number: '2026-0007' })),
      },
      domain: { findMany: jest.fn(async () => []) },
      cloudflareSetting: { findFirst: jest.fn(async () => null) },
    };

    c3 = {
      operational: jest.fn(async () => true),
      resolveTracking: jest.fn(async () => null),
    };

    svc = new CheckoutService(
      prisma as never,
      { findPublicBySlug: jest.fn(async () => state.product) } as never,
      { record: jest.fn(async () => undefined) } as never,
      { consume: jest.fn(() => ({ allowed: true, retryAfterMs: 0 })) } as never,
      { sendPlain: jest.fn(async () => undefined) } as never,
      {
        provisionOrder: jest.fn(async () => undefined),
        syncAppLimits: jest.fn(async () => undefined),
      } as never,
      { checkSubdomainAvailability: jest.fn(async () => ({ available: true, fqdn: 'x.y' })) } as never,
      c3 as never,
    );
  };

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      productSlug: 'site-starter',
      paymentMethodId: 'pm1',
      email: 'guest@example.com',
      name: 'Guest',
      ...over,
    }) as any;

  const member = () => {
    state.user = { id: 'u1', email: 'membre@example.com', name: 'Membre' };
  };

  /** JWT d'un membre connecté (authoritative `sub` du jeton). */
  const jwtMember = () => ({ sub: 'u1' }) as never;

  /** Commande prête à confirmer (PENDING_PAYMENT, compte lié). */
  const confirmable = (over: Record<string, unknown> = {}) => {
    state.txConfirmOrder = {
      id: 'ord-new',
      status: 'PENDING_PAYMENT',
      customerEmail: 'guest@example.com',
      customerName: 'Guest',
      productId: 'prod1',
      productName: 'Site Starter',
      packId: 'pack1',
      billingCycle: 'MONTHLY',
      currency: 'EUR',
      amountHtCents: 4900,
      taxAmountCents: 0,
      amountTtcCents: 4900,
      requestedSubdomain: null,
      requestedDomainId: null,
      customer: { userId: 'u-new' },
      ...over,
    } as any;
    return state.txConfirmOrder;
  };

  beforeEach(() => {
    delete process.env[C3_ENV];
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
    make();
  });

  afterEach(() => {
    delete process.env[C3_ENV];
    delete process.env.PAYMENT_SIMULATOR_ENABLED;
  });

  const provisioning = () =>
    (svc as never as { provisioning: { provisionOrder: jest.Mock } }).provisioning;

  // ── OFF : aucune ouverture de droit au checkout ────────────────────────────

  it('OFF : commande PENDING_PAYMENT, AUCUNE écriture C3/droit, provisioning NON lancé', async () => {
    const out = await svc.checkoutGuest(dto());
    expect(out.orderId).toBe('ord-new');
    expect(out.nextStep).toBe('payment-pending');
    expect(state.product).toBeTruthy();
    const created = tx.order.create.mock.calls[0][0].data;
    expect(created.status).toBe('PENDING_PAYMENT');
    expect(c3.operational).not.toHaveBeenCalled();
    expect(tx.orderProvisioningTracking.create).not.toHaveBeenCalled();
    expect(tx.hostingService.create).not.toHaveBeenCalled();
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(prisma.product.findUnique).not.toHaveBeenCalled(); // pas de catalogue C3
    expect(provisioning().provisionOrder).not.toHaveBeenCalled(); // après confirmation
    expect(tx.invoice.create.mock.calls[0][0].data.status).toBe('UNPAID');
  });

  // ── ON : fast-fails avant toute écriture ──────────────────────────────────

  it('ON + schéma indisponible ⇒ 503 AVANT toute transaction', async () => {
    process.env[C3_ENV] = 'true';
    c3.operational.mockResolvedValue(false);
    await expect(svc.checkoutGuest(dto())).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
  });

  it('ON + produit sans CREATE_APP ⇒ 409 (non provisionnable), 0 écriture', async () => {
    process.env[C3_ENV] = 'true';
    state.catalog = { ...catalog, provisionModule: { actions: ['CONFIGURE_DNS'] } };
    await expect(svc.checkoutGuest(dto())).rejects.toThrow(/CREATE_APP/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ON + pack produit sans row pack ⇒ 409, 0 écriture', async () => {
    process.env[C3_ENV] = 'true';
    state.catalog = { ...catalog, pack: null };
    await expect(svc.checkoutGuest(dto())).rejects.toThrow(/Pack produit introuvable/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ON + membre avec abonnement actif ⇒ 409 upgrade refusé, 0 transaction', async () => {
    process.env[C3_ENV] = 'true';
    member();
    state.preSub = { id: 'sub-actif', status: 'ACTIVE' };
    await expect(svc.checkoutGuest(dto(), undefined, jwtMember())).rejects.toThrow(
      /upgrade non pris en charge/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.subscription.findFirst).toHaveBeenCalled(); // recheck pré-tx
  });

  // ── ON : rejeu avant refus + rejeu sous verrou ─────────────────────────────

  it('rejeu pré-tx présent ⇒ commande renvoyée AVANT tout refus C3', async () => {
    process.env[C3_ENV] = 'true';
    member();
    state.preSub = { id: 'sub-actif', status: 'ACTIVE' }; // refuserait…
    state.intentOrders = [{ id: 'ord-exist', status: 'PENDING_PAYMENT' }];
    const out = await svc.checkoutGuest(dto(), undefined, jwtMember());
    expect(out.orderId).toBe('ord-exist'); // …mais le rejeu gagne
    expect(out.nextStep).toBe('payment-pending'); // honnête : pas encore payée
    expect(c3.operational).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('double-clic concurrent (dup détecté SOUS verrou) ⇒ rejeu, pas de refus', async () => {
    process.env[C3_ENV] = 'true';
    member();
    state.txDup = { id: 'ord-tx', status: 'PENDING_PAYMENT' };
    state.ordersById['ord-tx'] = { id: 'ord-tx', status: 'PENDING_PAYMENT' };
    const out = await svc.checkoutGuest(dto(), undefined, jwtMember());
    expect(out.orderId).toBe('ord-tx');
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(provisioning().provisionOrder).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled(); // la garde a bien tourné
    const lockSql = (tx.$queryRaw.mock.calls[0] as TemplateStringsArray[])[0]?.join(' ') ?? '';
    expect(lockSql).toContain('FOR UPDATE'); // verrou User du compte
  });

  it('abonnement devenu actif entre-temps ⇒ recheck sous verrou ⇒ 409, 0 écriture', async () => {
    process.env[C3_ENV] = 'true';
    member();
    state.preSub = null; // obsolète : passé au recheck pré-tx
    state.txSub = { id: 'sub-frais', status: 'ACTIVE' };
    await expect(svc.checkoutGuest(dto(), undefined, jwtMember())).rejects.toThrow(
      /upgrade non pris en charge/,
    );
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  // ── Droits DÉLÉGUÉS à la confirmation ──────────────────────────────────────

  it('ON + invité pack : checkout SANS tracking/service/abonnement (tout en différé)', async () => {
    process.env[C3_ENV] = 'true';
    const out = await svc.checkoutGuest(dto({ subdomain: undefined }));
    expect(out.orderId).toBe('ord-new');
    expect(out.nextStep).toBe('payment-pending');
    expect(tx.orderProvisioningTracking.create).not.toHaveBeenCalled();
    expect(tx.hostingService.create).not.toHaveBeenCalled();
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(provisioning().provisionOrder).not.toHaveBeenCalled();
    // Le catalogue n'est lu que pour les fast-fails (aucune écriture en découle) ;
    // le provisioning relira lui-même le catalogue à la confirmation.
    expect(prisma.product.findUnique).toHaveBeenCalled();
    expect(tx.orderProvisioningTracking.create).not.toHaveBeenCalled();
  });

  it('confirmOrderPaid : PENDING→PAID + facture + abonnement + intention + service, puis lancement', async () => {
    process.env[C3_ENV] = 'true';
    confirmable();
    const res = await svc.confirmOrderPaid('ord-new', {
      source: 'admin-transfer',
      actorEmail: 'admin@example.com',
      reference: 'VIR-2026-01',
    });
    expect(res.alreadyConfirmed).toBe(false);
    expect(res.status).toBe('PAID');
    expect(res.subscriptionAction).toBe('created');

    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ord-new', status: 'PENDING_PAYMENT' },
        data: expect.objectContaining({ status: 'PAID' }),
      }),
    );
    expect(tx.invoice.updateMany).toHaveBeenCalled();
    expect(tx.subscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u-new', orderId: 'ord-new' }),
    });
    expect(tx.orderStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ note: expect.stringContaining('VIR-2026-01') }),
      }),
    );
    expect(tx.orderProvisioningTracking.create).toHaveBeenCalledWith({
      data: {
        orderId: 'ord-new',
        intent: {
          business: {
            productId: 'prod1',
            packId: 'pack1',
            provisionModuleId: 'pm-mod1',
            billingCycle: 'MONTHLY',
            currency: 'EUR',
            amountTtcCents: 4900,
            requestedSubdomain: null,
            requestedDomainId: null,
          },
          environment: {
            repoUrl: 'https://github.com/acme/site.git',
            branch: 'main',
            buildPack: 'static',
            appName: 'site',
            publishDirectory: 'dist',
            isStatic: true,
          },
        },
      },
    });
    expect(tx.hostingService.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u-new',
        orderId: 'ord-new',
        productId: 'prod1',
        packId: 'pack1',
        deploymentModuleId: 'mod1',
        status: 'PROVISIONING',
        maxAppsSnapshot: 3,
        ramMbSnapshot: 1024,
        cpuCoresSnapshot: 1,
        storageLimitGbSnapshot: null,
        packNameSnapshot: 'Starter',
        productNameSnapshot: 'Site Starter',
      }),
    });
    expect(prisma.product.findUnique).toHaveBeenCalled(); // catalogue relu en confirm
    expect(provisioning().provisionOrder).toHaveBeenCalledWith('ord-new');
  });

  it('confirmOrderPaid idempotent : déjà confirmée ⇒ alreadyConfirmed, AUCUNE réécriture', async () => {
    confirmable({ status: 'ACTIVE' });
    const res = await svc.confirmOrderPaid('ord-new', { source: 'admin-transfer' });
    expect(res.alreadyConfirmed).toBe(true);
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(tx.orderProvisioningTracking.create).not.toHaveBeenCalled();
    expect(provisioning().provisionOrder).not.toHaveBeenCalled();
  });

  it('confirmOrderPaid sur commande annulée ⇒ 409 (aucun droit rétroactif)', async () => {
    confirmable({ status: 'CANCELLED' });
    await expect(
      svc.confirmOrderPaid('ord-new', { source: 'admin-transfer' }),
    ).rejects.toThrow(ConflictException);
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(provisioning().provisionOrder).not.toHaveBeenCalled();
  });

  it('ON + membre pack confirmé : abonnement créé pour u1, service userId u1', async () => {
    process.env[C3_ENV] = 'true';
    member();
    confirmable({ customer: { userId: 'u1' } });
    const res = await svc.confirmOrderPaid('ord-new', { source: 'admin-transfer' });
    expect(res.subscriptionAction).toBe('created');
    expect(tx.subscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', orderId: 'ord-new' }),
    });
    expect(tx.hostingService.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1' }),
    });
  });

  it('ON + produit sans pack confirmé : abonnement ni écriture C3', async () => {
    process.env[C3_ENV] = 'true';
    confirmable({ packId: null });
    const res = await svc.confirmOrderPaid('ord-new', { source: 'admin-transfer' });
    expect(res.subscriptionAction).toBeNull();
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(tx.orderProvisioningTracking.create).not.toHaveBeenCalled();
    expect(tx.hostingService.create).not.toHaveBeenCalled();
  });

  // ── Simulateur (gate explicite) ────────────────────────────────────────────

  it('simulateur sans activation explicite ⇒ refus net', async () => {
    await expect(
      svc.simulatePaymentOutcome('ord-x', 'success'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('simulateur désactivé EN PRODUCTION même si l’env est posé ⇒ refus', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_SIMULATOR_ENABLED = 'true';
    try {
      await expect(svc.simulatePaymentOutcome('ord-x', 'success')).rejects.toThrow(
        BadRequestException,
      );
    } finally {
      process.env.NODE_ENV = prev;
      delete process.env.PAYMENT_SIMULATOR_ENABLED;
    }
  });

  it('signal de rejeu in-tx est reconnu (classe exportée)', () => {
    expect(new CheckoutReplaySignal('ord1').orderId).toBe('ord1');
    expect(new CheckoutReplaySignal('ord1')).toBeInstanceOf(Error);
    expect(new ConflictException('x').getStatus()).toBe(409);
  });
});
