import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ProvisionAction } from '@prisma/client';
import { ProvisioningService, C3WorkerGuardError } from './provisioning.service';

/**
 * 17B.4F-C3 — orchestration du provisioning C3 (`provisionC3`) + routage
 * (`provisionOrder`). Contrats couverts (plan C3) :
 *  - routage : OFF ⇒ refus explicite des commandes trackées (aucun repli legacy),
 *    legacy inchangé sinon ; ON ⇒ capability LIVE (503 sans schéma) puis C3 ;
 *  - TX-A : verrous ordre, décisions sur états existants SANS takeover
 *    (terminal / bound / uncertain / releasing / busy / noop / cancelled),
 *    claim token+lease, réservation, B0 AVANT intention, Order→PROVISIONING,
 *    intention DERNIÈRE ;
 *  - garde : identité token sÉparée du lease, renouvellement CAS ;
 *  - provider TOUJOURS hors transaction ; échec d'étape ⇒ STOP (aucun appel
 *    suivant) ; row Deployment créée avant le 1ᵉʳ appel provider (PENDING) et
 *    son update passe limitsStatus null → APPLIED ;
 *  - TX-E markBound, preuve, TX-B activation (token + CAS) + effets post-commit.
 */
describe('provisionC3 / routage C3 (17B.4F-C3)', () => {
  const now = Date.now();
  const C3_ENV = 'HOSTING_C3_ENABLED';

  const coolifyServer = {
    id: 'srv-coolify',
    panelProvider: 'COOLIFY',
    apiBaseUrl: 'http://panel.test:8000/api/v1',
    apiTokenEnc: 'enc:tok',
    strictTls: true,
    hostname: 'panel.test',
    coolifyProjectUuid: 'proj-1',
    coolifyServerUuid: 'srv-1',
  };

  const intent = {
    business: { productId: 'prod1', packId: 'pack1', amountTtcCents: 4900 },
    environment: { repoUrl: 'https://github.com/acme/site.git' },
  };

  type State = {
    orderExists: boolean;
    orderStatus: string;
    fqdn: string | null;
    trackingPresent: boolean;
    claimToken: string | null;
    leaseUntil: Date | null;
    alloc: Record<string, unknown> | null;
    depRow: Record<string, unknown> | null;
    depStatus: string;
    logs: Record<string, unknown>[];
    logSeq: number;
    history: Record<string, unknown>[];
    casCount: number;
    service: Record<string, unknown> | null;
  };

  const defaultState = (): State => ({
    orderExists: true,
    orderStatus: 'PAID',
    fqdn: null,
    trackingPresent: true,
    claimToken: null,
    leaseUntil: null,
    alloc: null,
    depRow: null,
    depStatus: 'PENDING',
    logs: [],
    logSeq: 0,
    history: [],
    casCount: 1,
    service: { id: 'hs1', orderId: 'ord1', userId: 'u1', status: 'PROVISIONING' },
  });

  const orderFixture = (over: Record<string, unknown> = {}) => ({
    id: 'ord1',
    status: 'PAID',
    domainValue: null,
    customerEmail: 'client@example.com',
    customerName: 'Client Test',
    productId: 'prod1',
    product: {
      name: 'Site Starter',
      moduleParams: {
        repoUrl: 'https://github.com/acme/site.git',
        branch: 'main',
        buildPack: 'static',
        appName: 'site',
        publishDirectory: 'dist',
        isStatic: true,
      },
      provisionModule: { name: 'coolify-store', actions: [ProvisionAction.CREATE_APP] },
      pack: {
        id: 'pack1',
        name: 'Starter',
        ramMb: 512,
        cpuCores: 1,
        storageLimit: null,
        maxApps: 2,
        status: 'ACTIVE',
        deploymentModule: {
          id: 'mod1',
          kind: 'SHARED_PROJECT',
          sharedProjectUuid: 'proj-1',
          overrideRamMb: null,
          overrideCpuCores: null,
          overrideStorageLimit: null,
          server: coolifyServer,
        },
      },
    },
    customer: { userId: 'u1' },
    ...over,
  });

  let state: State;
  let tx: Record<string, any>;
  let prisma: Record<string, any>;
  let transport: Record<string, any>;
  let hosting: Record<string, jest.Mock>;
  let svc: ProvisioningService;
  let auditMock: { record: jest.Mock };
  let txDepth: number;
  let providerTxDepth: number[];

  const make = () => {
    state = defaultState();
    txDepth = 0;
    providerTxDepth = [];

    const q = (sql: string): unknown => {
      if (sql.includes('FROM "OrderProvisioningTracking"')) {
        return state.trackingPresent
          ? [{ intent, claimToken: state.claimToken, leaseUntil: state.leaseUntil }]
          : [];
      }
      if (sql.includes('FROM "HostingService"')) {
        return state.service
          ? [{ id: state.service.id, status: state.service.status }]
          : [];
      }
      if (sql.includes('FROM "Order"')) {
        return state.orderExists
          ? [{ id: 'ord1', status: state.orderStatus, domainValue: state.fqdn }]
          : [];
      }
      return [];
    };

    tx = {
      $queryRaw: jest.fn((strings: TemplateStringsArray) => q(strings.join(' '))),
      order: {
        findUnique: jest.fn(async () => ({ status: state.orderStatus })),
        update: jest.fn(async ({ data }: any) => {
          if (data.status) state.orderStatus = data.status;
          return { id: 'ord1', ...data };
        }),
        updateMany: jest.fn(async ({ data }: any) => {
          if (data.status) state.orderStatus = data.status;
          return { count: 1 };
        }),
      },
      deployment: {
        findUnique: jest.fn(async () => state.depRow),
        findFirst: jest.fn(async () =>
          state.depRow ? { id: state.depRow.id, status: state.depStatus } : null,
        ),
        create: jest.fn(async ({ data }: any) => {
          state.depRow = { id: 'dep1', limitsStatus: null, ...data };
          if (data.status) state.depStatus = data.status;
          return state.depRow;
        }),
        update: jest.fn(async ({ data }: any) => {
          state.depRow = { ...(state.depRow ?? {}), ...data };
          if (data.status) state.depStatus = data.status;
          return state.depRow;
        }),
        updateMany: jest.fn(async ({ data }: any) => {
          if (data.status) state.depStatus = data.status;
          return { count: 1 };
        }),
      },
      orderStatusHistory: {
        create: jest.fn(async ({ data }: any) => {
          state.history.push(data);
          return data;
        }),
      },
      provisioningLog: {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `log${++state.logSeq}`, message: null, ...data };
          state.logs.push(row);
          return row;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row = state.logs.find((l) => l.id === where.id) as any;
          if (row) Object.assign(row, data);
          return row ?? data;
        }),
      },
      hostingServiceAllocation: {
        findUnique: jest.fn(async () => state.alloc),
      },
      hostingService: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (state.service && state.service.id === where.id && state.service.status === where.status) {
            state.service.status = data.status;
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
      orderProvisioningTracking: {
        update: jest.fn(async ({ data }: any) => {
          if ('claimToken' in data) {
            state.claimToken = data.claimToken ?? null;
            state.leaseUntil = data.leaseUntil ?? null;
          }
          return {};
        }),
        updateMany: jest.fn(async () => ({ count: state.casCount })),
      },
    };

    transport = {
      createGitApp: jest.fn(async () => {
        providerTxDepth.push(txDepth);
        return { uuid: 'app-9' };
      }),
      deployApp: jest.fn(async () => {
        providerTxDepth.push(txDepth);
      }),
      applyAppLimits: jest.fn(async () => {
        providerTxDepth.push(txDepth);
      }),
      setAppDomain: jest.fn(async () => undefined),
      resolveExposedPort: jest.fn(async () => null),
      applyNodePort: jest.fn(async () => undefined),
    };

    hosting = {
      reserveForOrderInTx: jest.fn(async () => ({ allocation: { id: 'alloc1' } })),
      markIntentInTx: jest.fn(async () => ({ applied: true })),
      releasePreProviderInTx: jest.fn(async () => ({ applied: true })),
      markBoundInTx: jest.fn(async () => ({ applied: true })),
    };

    prisma = {
      $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) => {
        txDepth++;
        try {
          return await cb(tx);
        } finally {
          txDepth--;
        }
      }),
      hostingService: {
        findUnique: jest.fn(async () => state.service),
      },
      order: {
        findUnique: jest.fn(async () => orderFixture()),
        update: jest.fn(async () => ({})),
      },
      deployment: {
        findFirst: jest.fn(async () => state.depRow),
        findUnique: jest.fn(async () => state.depRow),
        create: jest.fn(async (args: any) => tx.deployment.create(args)),
        update: jest.fn(async (args: any) => tx.deployment.update(args)),
      },
      provisioningLog: {
        findMany: jest.fn(async () => state.logs),
      },
      clientSubdomain: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => null),
        updateMany: jest.fn(async () => ({ count: 0 })),
        update: jest.fn(async () => ({})),
      },
    };

    auditMock = { record: jest.fn() };
    svc = new ProvisioningService(
      prisma as never,
      auditMock as never,
      { decrypt: () => 'tok', encrypt: jest.fn() } as never,
      { sendPlain: jest.fn() } as never,
      {
        findActiveRootDomain: jest.fn(),
        allocateClientSubdomain: jest.fn(),
        resolveEffectiveRoot: jest.fn(),
        checkSubdomainAvailability: jest.fn(),
      } as never,
      { create: () => transport } as never,
      { getOrCreateClientProject: jest.fn() } as never,
      { isServed: jest.fn() } as never,
      hosting as never,
      { resolveTracking: jest.fn(), operational: jest.fn() } as never,
      {} as never,
      { assertOperational: jest.fn().mockResolvedValue(undefined) } as never,
    );
    jest.spyOn(svc as never as { awaitAppReady: () => Promise<boolean> }, 'awaitAppReady').mockResolvedValue(true);
  };

  const run = (over: Record<string, unknown> = {}, tracked: { intent: unknown } = { intent }) =>
    (svc as never as {
      provisionC3: (o: unknown, t: unknown, opts?: unknown) => Promise<{ status: string; fqdn: string | null; steps: unknown[] }>;
    }).provisionC3(orderFixture(over), tracked);

  beforeEach(() => {
    delete process.env[C3_ENV];
    make();
  });

  afterEach(() => {
    delete process.env[C3_ENV];
    jest.restoreAllMocks();
  });

  // ── Routage (provisionOrder) ───────────────────────────────────────────────

  describe('routage de provisionOrder', () => {
    const c3 = () => (svc as never as { c3: { resolveTracking: jest.Mock; operational: jest.Mock } }).c3;

    const orderRead = (status: string) => {
      prisma.order.findUnique.mockResolvedValue({ ...orderFixture(), status });
    };

    it('OFF + commande trackée ⇒ 409, AUCUN repli legacy, aucun appel provider (T-a.2)', async () => {
      orderRead('PAID');
      c3().resolveTracking.mockResolvedValue({ intent });
      await expect(svc.provisionOrder('ord1')).rejects.toThrow(/C3/);
      expect(c3().operational).not.toHaveBeenCalled(); // OFF : jamais de capability
      expect(prisma.provisioningLog.findMany).not.toHaveBeenCalled(); // pas d'idempotent-return
      expect(transport.createGitApp).not.toHaveBeenCalled();
    });

    it('OFF + sans tracking ⇒ parcours legacy inchangé (idempotent-return conservé)', async () => {
      orderRead('PROVISIONING');
      c3().resolveTracking.mockResolvedValue(null);
      state.logs.push({ id: 'log1', step: 'create_app', status: 'SUCCESS', message: null });
      const out = await svc.provisionOrder('ord1');
      expect(out.status).toBe('PROVISIONING');
      expect(c3().resolveTracking).toHaveBeenCalledWith('ord1'); // sonde LIVE à chaque appel
      expect(prisma.provisioningLog.findMany).toHaveBeenCalled();
      expect(transport.createGitApp).not.toHaveBeenCalled();
    });

    it('ON + schéma indisponible ⇒ 503 fail-closed AVANT toute écriture', async () => {
      process.env[C3_ENV] = 'true';
      orderRead('PAID');
      c3().operational.mockResolvedValue(false);
      await expect(svc.provisionOrder('ord1')).rejects.toThrow(ServiceUnavailableException);
      expect(c3().resolveTracking).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ON + trackée ⇒ capability puis provisionC3 (et non le legacy)', async () => {
      process.env[C3_ENV] = 'true';
      orderRead('PAID');
      c3().operational.mockResolvedValue(true);
      c3().resolveTracking.mockResolvedValue({ intent });
      const spy = jest
        .spyOn(svc as never as { provisionC3: () => Promise<unknown> }, 'provisionC3')
        .mockResolvedValue({ orderId: 'ord1', status: 'ACTIVE', fqdn: null, steps: [] });
      const out = await svc.provisionOrder('ord1', { force: true });
      expect(out.status).toBe('ACTIVE');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(c3().operational.mock.invocationCallOrder[0]).toBeLessThan(
        c3().resolveTracking.mock.invocationCallOrder[0],
      );
    });

    it('ON + sans tracking (ancien achat) ⇒ legacy sécurisé, inchangé', async () => {
      process.env[C3_ENV] = 'true';
      orderRead('PROVISIONING');
      c3().operational.mockResolvedValue(true);
      c3().resolveTracking.mockResolvedValue(null);
      state.logs.push({ id: 'log1', step: 'create_app', status: 'SUCCESS', message: null });
      const out = await svc.provisionOrder('ord1');
      expect(out.status).toBe('PROVISIONING');
      expect(c3().operational).toHaveBeenCalled();
    });
  });

  // ── Garde token/lease ──────────────────────────────────────────────────────

  describe('c3Guard (identité séparée du lease)', () => {
    const guard = (token: string) =>
      (svc as never as { c3Guard: (id: string, t: string) => (fn: (t: unknown) => Promise<unknown>) => Promise<unknown> }).c3Guard(
        'ord1',
        token,
      );

    it('identité fausse ⇒ refus 409 (aucune écriture exécutée)', async () => {
      state.claimToken = 'tokA';
      state.leaseUntil = new Date(now + 60_000);
      let ran = false;
      await expect(
        guard('tokB')(async () => {
          ran = true;
        }),
      ).rejects.toThrow(C3WorkerGuardError);
      expect(ran).toBe(false);
      const e = (await guard('tokB')(async () => undefined).catch(
        (err: unknown) => err,
      )) as { getStatus?: () => number };
      expect(typeof e.getStatus === 'function' && e.getStatus()).toBe(409);
    });

    it('lease valide + bon token ⇒ écriture exécutée SANS renouvellement', async () => {
      state.claimToken = 'tokA';
      state.leaseUntil = new Date(now + 60_000);
      let ran = false;
      await guard('tokA')(async () => {
        ran = true;
      });
      expect(ran).toBe(true);
      expect(tx.orderProvisioningTracking.updateMany).not.toHaveBeenCalled();
    });

    it('lease expirée + bon token ⇒ renouvellement CAS (token+expiré), écriture exécutée', async () => {
      state.claimToken = 'tokA';
      state.leaseUntil = new Date(now - 1_000);
      let ran = false;
      await guard('tokA')(async () => {
        ran = true;
      });
      expect(ran).toBe(true);
      expect(tx.orderProvisioningTracking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ orderId: 'ord1', claimToken: 'tokA' }),
        }),
      );
    });

    it('renouvellement CAS count ≠ 1 ⇒ refus (jamais contourné)', async () => {
      state.claimToken = 'tokA';
      state.leaseUntil = new Date(now - 1_000);
      state.casCount = 0;
      let ran = false;
      await expect(
        guard('tokA')(async () => {
          ran = true;
        }),
      ).rejects.toThrow(/Lease non renouvelable/);
      expect(ran).toBe(false);
    });

    it('commande disparue sous le worker ⇒ refus explicite', async () => {
      state.claimToken = 'tokA';
      state.orderExists = false;
      await expect(guard('tokA')(async () => undefined)).rejects.toThrow(/introuvable \(worker/);
    });
  });

  // ── Décisions TX-A (aucun takeover, lecture seule ou refus) ────────────────

  describe('décisions sur états existants (TX-A)', () => {
    it('service hébergement absent ⇒ 409, aucune transaction ouverte', async () => {
      state.service = null;
      await expect(run()).rejects.toThrow(/Service hébergement absent/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('tracking absent sous ON ⇒ 503 fail-closed (aucune écriture)', async () => {
      state.trackingPresent = false;
      await expect(run()).rejects.toThrow(ServiceUnavailableException);
      expect(tx.orderProvisioningTracking.update).not.toHaveBeenCalled();
      expect(hosting.reserveForOrderInTx).not.toHaveBeenCalled();
    });

    it('Order CANCELLED live ⇒ 409 (jamais re-provisionné, même force)', async () => {
      state.orderStatus = 'CANCELLED';
      await expect(run()).rejects.toThrow(/CANCELLED/);
      expect(transport.createGitApp).not.toHaveBeenCalled();
    });

    it('allocation RELEASED (terminal) ⇒ lecture seule, 0 appel, 0 token', async () => {
      state.alloc = { id: 'a1', status: 'RELEASED', providerIntentAt: null, deploymentId: null };
      const out = await run();
      expect(out.status).toBe('PAID');
      expect(state.claimToken).toBeNull();
      expect(hosting.reserveForOrderInTx).not.toHaveBeenCalled();
      expect(transport.createGitApp).not.toHaveBeenCalled();
    });

    it('fenêtre bind committé (BOUND + deploymentId) ⇒ état réel en lecture seule (T-fen.1)', async () => {
      state.alloc = { id: 'a1', status: 'BOUND', providerIntentAt: new Date(), deploymentId: 'dep-x' };
      state.orderStatus = 'PROVISIONING';
      const out = await run();
      expect(out.status).toBe('PROVISIONING');
      expect(state.claimToken).toBeNull();
      expect(hosting.markBoundInTx).not.toHaveBeenCalled();
      expect(transport.createGitApp).not.toHaveBeenCalled();
    });

    it('intention engagée sans bind (RESERVED + providerIntentAt) ⇒ 409, AUCUN takeover', async () => {
      state.alloc = { id: 'a1', status: 'RESERVED', providerIntentAt: new Date(), deploymentId: null };
      await expect(run()).rejects.toThrow(/Intention provider déjà engagée/);
      expect(state.claimToken).toBeNull(); // aucun écrit de token
      expect(hosting.markIntentInTx).not.toHaveBeenCalled();
    });

    it('RELEASING ⇒ 409 (reprise refusée)', async () => {
      state.alloc = { id: 'a1', status: 'RELEASING', providerIntentAt: null, deploymentId: null };
      await expect(run()).rejects.toThrow(/Libération en cours/);
      expect(state.claimToken).toBeNull();
    });

    it('Order ACTIVE sans allocation ⇒ noop en lecture seule', async () => {
      state.orderStatus = 'ACTIVE';
      const out = await run();
      expect(out.status).toBe('ACTIVE');
      expect(state.claimToken).toBeNull();
      expect(transport.createGitApp).not.toHaveBeenCalled();
    });

    it('lease encore valide (worker en cours) ⇒ 409 busy, aucun double claim', async () => {
      state.claimToken = 'w1';
      state.leaseUntil = new Date(now + 60_000);
      await expect(run()).rejects.toThrow(/déjà en cours/);
      expect(state.claimToken).toBe('w1'); // inchangé
      expect(hosting.reserveForOrderInTx).not.toHaveBeenCalled();
    });

    it('reprise pré-intention à lease expirée ⇒ nouveau claim + parcours complet', async () => {
      state.claimToken = 'old';
      state.leaseUntil = new Date(now - 1_000);
      const out = await run();
      expect(out.status).toBe('ACTIVE');
      expect(state.claimToken).not.toBe('old');
      expect(state.orderStatus).toBe('ACTIVE');
    });
  });

  // ── TX-A happy path + ordre des écritures ──────────────────────────────────

  describe('claim, réservation, B0 et intention (TX-A)', () => {
    it('claim → réservation → intention DERNIÈRE (ordre des écritures)', async () => {
      const out = await run();
      expect(out.status).toBe('ACTIVE');
      const claimOrder = tx.orderProvisioningTracking.update.mock.invocationCallOrder[0];
      const reserveOrder = hosting.reserveForOrderInTx.mock.invocationCallOrder[0];
      const intentOrder = hosting.markIntentInTx.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(reserveOrder);
      expect(reserveOrder).toBeLessThan(intentOrder);
      expect(hosting.reserveForOrderInTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ payload: intent }),
      );
      // Order → PROVISIONING (depuis PAID) écrit dans la TX-A, avant intention.
      expect(state.history.some((h) => h.status === 'PROVISIONING')).toBe(true);
    });

    it('B0 en échec ⇒ libération pré-provider + token effacé + Order reste PAID, 0 intention', async () => {
      const noRepo = orderFixture();
      (noRepo.product as any).moduleParams = { branch: 'main' }; // repoUrl absent
      const out = await (svc as never as {
        provisionC3: (o: unknown, t: unknown) => Promise<{ status: string }>;
      }).provisionC3(noRepo, { intent });
      expect(out.status).toBe('PAID'); // état réel, lecture seule
      expect(hosting.releasePreProviderInTx).toHaveBeenCalledTimes(1);
      expect(hosting.markIntentInTx).not.toHaveBeenCalled(); // B0 AVANT intention
      expect(state.claimToken).toBeNull(); // token effacé avant commit
      expect(state.orderStatus).toBe('PAID'); // jamais passé PROVISIONING
      expect(state.history.some((h) => String(h.note).includes('B0'))).toBe(true);
      expect(transport.createGitApp).not.toHaveBeenCalled();
    });

    it('intention non applicable ⇒ refus 409 (réservation conservée, aucun appel)', async () => {
      hosting.markIntentInTx.mockResolvedValue({ applied: false, reason: 'already' });
      await expect(run()).rejects.toThrow(/Intention provider non applicable/);
      expect(transport.createGitApp).not.toHaveBeenCalled();
    });
  });

  // ── Exécution : provider hors tx, échec ⇒ stop, activation ────────────────

  describe('exécution des actions', () => {
    it('parcours complet : row PENDING avant provider, limitsStatus null → APPLIED, activation', async () => {
      const out = await run();
      expect(out.status).toBe('ACTIVE');
      // provider JAMAIS à l'intérieur d'une transaction (depth 0).
      expect(providerTxDepth.length).toBeGreaterThan(0);
      expect(providerTxDepth.every((d) => d === 0)).toBe(true);
      // Row créée en TX-C avant l'appel provider, puis mise à jour (uuid + DEPLOYING).
      expect(state.depRow).toMatchObject({
        coolifyUuid: 'app-9',
        status: 'DEPLOYING',
        limitsStatus: 'APPLIED',
        limitsRamMb: 512,
        limitsCpu: 1,
      });
      // TX-E : allocation liée au déploiement.
      expect(hosting.markBoundInTx).toHaveBeenCalledTimes(1);
      // TX-B : activation Order + Deployment + history ACTIVE.
      expect(state.orderStatus).toBe('ACTIVE');
      expect(state.depStatus).toBe('ACTIVE');
      expect(state.history.some((h) => h.status === 'ACTIVE')).toBe(true);
      expect(state.logs.every((l) => l.status === 'SUCCESS')).toBe(true);
      // Le service hébergement suit l'activation (fin du parcours C3).
      expect(state.service).toMatchObject({ status: 'ACTIVE' });
      expect(tx.hostingService.updateMany).toHaveBeenCalledWith({
        where: { id: 'hs1', status: 'PROVISIONING' },
        data: { status: 'ACTIVE' },
      });
      // P9 (E1/M-05) — transitions claim + activation journalisées (AuditLog).
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'order.transition',
          resourceId: 'ord1',
          details: expect.objectContaining({ from: 'PAID', to: 'PROVISIONING', via: 'c3_claim' }),
        }),
      );
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'order.transition',
          resourceId: 'ord1',
          details: expect.objectContaining({ from: 'PROVISIONING', to: 'ACTIVE', via: 'activation_proof' }),
        }),
      );
    });

    it('retry après crash (activation déjà committée) ⇒ flip idempotent du service', async () => {
      // Convergence : Order+Deployment déjà actifs (noop already_active) alors
      // que le flip de service n'avait pas été committé — TX-B le complète.
      jest
        .spyOn(
          svc as never as { activateOrderInTx: (...args: unknown[]) => Promise<unknown> },
          'activateOrderInTx',
        )
        .mockResolvedValue({
          orderIsActive: true,
          deploymentIsActive: true,
          orderActivated: false,
          deploymentActivated: false,
          noop: true,
          reason: 'already_active',
        } as never);
      const out = await run();
      expect(out.status).toBe('ACTIVE');
      expect(state.service).toMatchObject({ status: 'ACTIVE' });
      expect(tx.hostingService.updateMany).toHaveBeenCalledTimes(1);
    });

    it('activation no-op impossible (état final partiel) ⇒ AUCUN flip du service', async () => {
      jest
        .spyOn(
          svc as never as { activateOrderInTx: (...args: unknown[]) => Promise<unknown> },
          'activateOrderInTx',
        )
        .mockResolvedValue({
          orderIsActive: false,
          deploymentIsActive: false,
          orderActivated: false,
          deploymentActivated: false,
          noop: true,
          reason: 'deployment_status_FAILED',
        } as never);
      const out = await run();
      expect(out.status).toBe('PROVISIONING');
      expect(state.service).toMatchObject({ status: 'PROVISIONING' });
      expect(tx.hostingService.updateMany).not.toHaveBeenCalled();
    });

    it('échec d’1ʳᵉ étape ⇒ STOP : aucun appel provider suivant, Order reste PROVISIONING', async () => {
      const withDns = orderFixture();
      (withDns.product as any).provisionModule = {
        name: 'coolify-store',
        actions: [ProvisionAction.CONFIGURE_DNS, ProvisionAction.CREATE_APP],
      };
      const cloudflare = (svc as never as { cloudflare: { allocateClientSubdomain: jest.Mock } }).cloudflare;
      cloudflare.allocateClientSubdomain.mockRejectedValue(new Error('CF down'));
      const out = await (svc as never as {
        provisionC3: (o: unknown, t: unknown) => Promise<{ status: string }>;
      }).provisionC3(withDns, { intent });
      expect(out.status).toBe('PROVISIONING');
      expect(transport.createGitApp).not.toHaveBeenCalled(); // STOP avant CREATE_APP
      expect(state.logs.some((l) => l.status === 'FAILED')).toBe(true);
      expect(state.orderStatus).toBe('PROVISIONING');
      expect(hosting.markBoundInTx).not.toHaveBeenCalled();
      // Échec ⇒ jamais d'activation du service hébergement.
      expect(state.service).toMatchObject({ status: 'PROVISIONING' });
      expect(tx.hostingService.updateMany).not.toHaveBeenCalled();
    });

    it('sans app créée ⇒ JAMAIS ACTIVE (garde identique au legacy)', async () => {
      transport.createGitApp.mockRejectedValue(new Error('panel down'));
      const out = await run();
      expect(out.status).toBe('PROVISIONING');
      expect(state.orderStatus).toBe('PROVISIONING');
      expect(state.history.some((h) => h.status === 'ACTIVE')).toBe(false);
    });

    it('preuve absente (awaitAppReady false) ⇒ PROVISIONING + échéance de réconciliation', async () => {
      jest
        .spyOn(svc as never as { awaitAppReady: () => Promise<boolean> }, 'awaitAppReady')
        .mockResolvedValue(false);
      const out = await run();
      expect(out.status).toBe('PROVISIONING');
      expect(state.orderStatus).toBe('PROVISIONING');
      expect(state.depStatus).toBe('DEPLOYING'); // pas de faux ACTIVE
      expect(tx.deployment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ reconcileNextAt: null }),
        }),
      );
      expect(state.history.some((h) => h.status === 'ACTIVE')).toBe(false);
      // Preuve absente ⇒ service hébergement reste réservable-bas (PROVISIONING).
      expect(state.service).toMatchObject({ status: 'PROVISIONING' });
      expect(tx.hostingService.updateMany).not.toHaveBeenCalled();
    });
  });
});
