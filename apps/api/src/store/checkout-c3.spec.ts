import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { CheckoutService, CheckoutReplaySignal } from './checkout.service';

/**
 * 17B.4F-C3 — checkout sous garde ON : capability LIVE, fast-fails AVANT toute
 * écriture, verrou `User` + rejeu sous verrou + recheck d'abonnement DANS la
 * transaction, intention figée `OrderProvisioningTracking` + `HostingService`
 * (snapshots pack) écrits dans la MÊME transaction que la commande. OFF :
 * comportement legacy byte-identique (aucune écriture C3, aucune capability).
 */
describe('checkout C3 (17B.4F-C3)', () => {
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
    preReplay: Record<string, unknown> | null;
    ordersById: Record<string, Record<string, unknown>>;
    txDup: Record<string, unknown> | null;
    preSub: Record<string, unknown> | null;
    txSub: Record<string, unknown> | null;
    user: Record<string, unknown> | null;
    txUserLock: Array<{ id: string }>;
  };

  const defaultState = (): State => ({
    product,
    catalog,
    preReplay: null,
    ordersById: {},
    txDup: null,
    preSub: null,
    txSub: null,
    user: null,
    txUserLock: [{ id: 'u1' }],
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
        findUnique: jest.fn(async ({ where }: any) =>
          where.idempotencyKey ? state.txDup : null,
        ),
        create: jest.fn(async ({ data }: any) => ({ id: 'ord-new', ...data })),
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
          if (where.idempotencyKey) return state.preReplay;
          if (where.id) return state.ordersById[where.id] ?? null;
          return null;
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

  beforeEach(() => {
    delete process.env[C3_ENV];
    make();
  });

  afterEach(() => {
    delete process.env[C3_ENV];
  });

  const provisioning = () =>
    (svc as never as { provisioning: { provisionOrder: jest.Mock } }).provisioning;

  // ── OFF : legacy inchangé ──────────────────────────────────────────────────

  it('OFF : aucune capability, aucune écriture C3, checkout legacy intact', async () => {
    const out = await svc.checkoutGuest(dto());
    expect(out.orderId).toBe('ord-new');
    expect(c3.operational).not.toHaveBeenCalled();
    expect(tx.orderProvisioningTracking.create).not.toHaveBeenCalled();
    expect(tx.hostingService.create).not.toHaveBeenCalled();
    expect(prisma.product.findUnique).not.toHaveBeenCalled(); // pas de catalogue C3
    expect(provisioning().provisionOrder).toHaveBeenCalledWith('ord-new');
  });

  // ── ON : fast-fails avant toute écriture ───────────────────────────────────

  it('ON + schéma indisponible ⇒ 503 AVANT toute transaction', async () => {
    process.env[C3_ENV] = 'true';
    c3.operational.mockResolvedValue(false);
    await expect(svc.checkoutGuest(dto())).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.product.findUnique).not.toHaveBeenCalled(); // stoppe dès la capability
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
    state.preReplay = { id: 'ord-exist', status: 'PAID' };
    const out = await svc.checkoutGuest(dto(), undefined, jwtMember());
    expect(out.orderId).toBe('ord-exist'); // …mais le rejeu gagne
    expect(c3.operational).not.toHaveBeenCalled(); // ni capability, ni refus
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('double-clic concurrent (dup détecté SOUS verrou) ⇒ rejeu, pas de refus', async () => {
    process.env[C3_ENV] = 'true';
    member();
    state.txDup = { id: 'ord-tx', status: 'PAID' };
    state.ordersById['ord-tx'] = { id: 'ord-tx', status: 'PAID' };
    const out = await svc.checkoutGuest(dto(), undefined, jwtMember());
    expect(out.orderId).toBe('ord-tx');
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.orderProvisioningTracking.create).not.toHaveBeenCalled();
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
    expect(tx.orderProvisioningTracking.create).not.toHaveBeenCalled();
    expect(tx.hostingService.create).not.toHaveBeenCalled();
  });

  // ── ON : écritures dans la transaction ─────────────────────────────────────

  it('ON + invité pack : intention figée + HostingService dans la MÊME transaction', async () => {
    process.env[C3_ENV] = 'true';
    const out = await svc.checkoutGuest(dto({ subdomain: undefined }));
    expect(out.orderId).toBe('ord-new');

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

    // Écritures dans l'ordre : commande → tracking → service → facture.
    const orderIdx = tx.order.create.mock.invocationCallOrder[0];
    const trkIdx = tx.orderProvisioningTracking.create.mock.invocationCallOrder[0];
    const svcIdx = tx.hostingService.create.mock.invocationCallOrder[0];
    const invIdx = tx.invoice.create.mock.invocationCallOrder[0];
    expect(orderIdx).toBeLessThan(trkIdx);
    expect(trkIdx).toBeLessThan(svcIdx);
    expect(svcIdx).toBeLessThan(invIdx);

    expect(provisioning().provisionOrder).toHaveBeenCalledWith('ord-new');
    expect(prisma.product.findUnique).toHaveBeenCalled(); // catalogue C3 lu sous ON
  });

  it('ON + membre pack : verrou User + aucun upgrade, abonnement créé, tracking u1', async () => {
    process.env[C3_ENV] = 'true';
    member();
    const out = await svc.checkoutGuest(dto(), undefined, jwtMember());
    expect(out.orderId).toBe('ord-new');
    const lockSql = (tx.$queryRaw.mock.calls[0] as TemplateStringsArray[])[0]?.join(' ') ?? '';
    expect(lockSql).toContain('FOR UPDATE');
    expect(tx.subscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', orderId: 'ord-new' }),
    });
    expect(tx.hostingService.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1' }),
    });
  });

  it('ON + produit sans pack (frais) : ON validé mais AUCUNE écriture C3', async () => {
    process.env[C3_ENV] = 'true';
    state.product = { ...product, packId: null, priceHtCents: 990, name: 'Installation' };
    const out = await svc.checkoutGuest(dto());
    expect(out.orderId).toBe('ord-new');
    expect(c3.operational).toHaveBeenCalled();
    expect(tx.orderProvisioningTracking.create).not.toHaveBeenCalled();
    expect(tx.hostingService.create).not.toHaveBeenCalled();
    expect(tx.subscription.create).not.toHaveBeenCalled();
  });

  it('signal de rejeu in-tx est reconnu (classe exportée)', () => {
    expect(new CheckoutReplaySignal('ord1').orderId).toBe('ord1');
    expect(new CheckoutReplaySignal('ord1')).toBeInstanceOf(Error);
    expect(new ConflictException('x').getStatus()).toBe(409);
  });
});
