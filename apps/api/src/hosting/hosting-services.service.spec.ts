import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, PreconditionFailedException, ServiceUnavailableException } from '@nestjs/common';
import { HostingServiceAllocationStatus, HostingServiceStatus } from '@prisma/client';
import {
  CONSUMING_ALLOCATION_STATUSES,
  HostingServicesService,
  assertSnapshotsValid,
  consumesSlot,
  snapshotsFromPack,
} from './hosting-services.service';
import { computeFingerprint, loadKeyring } from './hosting-fingerprint';

/**
 * 17B.4F-B1+C1 — invariants de sécurité et de quotas du modèle HostingService,
 * réservation transactionnelle (verrou, quota, empreinte) et primitives
 * d'état C1 (aucun appel réseau, clés synthétiques uniquement).
 * (Les classes de classification legacy EXACT / LEGACY_SHARED / AMBIGUOUS /
 * ORPHAN sont couvertes dans legacy-classification.spec.ts.)
 */
describe('HostingServicesService (17B.4F-B1+C1)', () => {
  let service: HostingServicesService;
  const mockPrisma = {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    hostingService: { create: jest.fn(), findUnique: jest.fn() },
    hostingServiceAllocation: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    order: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    deployment: { findUnique: jest.fn() },
  };

  const ownedOrder = (orderId = 'order1', userId = 'user1') => ({
    id: orderId,
    customer: { userId },
  });

  // ── fixtures C1 : clés synthétiques + payloads (aucun secret réel) ────────
  const FP_KEY_V1 = Buffer.alloc(32, 9).toString('base64');
  const UUID = '123e4567-e89b-42d3-a456-426614174000';
  const payload = {
    business: { productId: 'p1', ramMb: 1024 },
    environment: { host: 'app.test', image: 'node:22' },
  };
  const reserveArgs = (
    over: Partial<{
      hostingServiceId: string;
      actorUserId: string;
      clientRequestId: string;
      payload: typeof payload;
    }> = {},
  ) => ({
    hostingServiceId: 'hs1',
    actorUserId: 'user1',
    clientRequestId: UUID,
    payload,
    ...over,
  });
  const fingerprint = () => computeFingerprint(payload, loadKeyring());
  const serviceRow = (over: Record<string, unknown> = {}) => ({
    id: 'hs1',
    userId: 'user1',
    status: HostingServiceStatus.ACTIVE,
    maxAppsSnapshot: 2,
    ...over,
  });
  const lockRow = (over: Record<string, unknown> = {}) => ({
    id: 'alloc1',
    hostingServiceId: 'hs1',
    deploymentId: null,
    idempotencyKey: `direct:v1:user1:hs1:${UUID}`,
    status: HostingServiceAllocationStatus.RESERVED,
    requestFingerprint: fingerprint(),
    providerIntentAt: null,
    reservedAt: new Date(),
    boundAt: null,
    releasedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ownerUserId: 'user1',
    ...over,
  });

  /**
   * Dispatch des verrous bruts PAR INSTRUCTION SQL (ordre déterministe du
   * moteur) : ① service (`s."userId"`), ② allocation (`a.*`), ③ déploiement
   * (`d."userId"`) ; tout autre SQL brut = verrou de service de `reserveSlot`.
   * Absence de branche → tableau vide (404), jamais un succès implicite.
   */
  const lockMocks = (
    over: {
      service?: Record<string, unknown> | null;
      allocation?: Record<string, unknown> | null;
      deployment?: Record<string, unknown> | null;
    } = {},
  ): void => {
    mockPrisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('d."userId"')) {
        return over.deployment ? [over.deployment] : [];
      }
      if (sql.includes('s."userId"')) {
        return over.service === null ? [] : [over.service ?? serviceRow()];
      }
      if (sql.includes('a.*')) {
        return over.allocation === null ? [] : [over.allocation ?? lockRow()];
      }
      return [serviceRow()];
    });
  };

  beforeAll(() => {
    process.env.HOSTING_FP_KEYS = JSON.stringify({ v1: FP_KEY_V1 });
  });

  afterAll(() => {
    delete process.env.HOSTING_FP_KEYS;
  });

  beforeEach(() => {
    service = new HostingServicesService(mockPrisma as never);
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mockPrisma),
    );
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.hostingServiceAllocation.findUnique.mockResolvedValue(null);
  });

  // ── 1-4 : snapshots ────────────────────────────────────────────────────────

  it('1. crée un service avec des snapshots valides figés à l’achat', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ownedOrder());
    mockPrisma.hostingService.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: 'hs1',
      ...args.data,
    }));

    const created = await service.create('user1', {
      orderId: 'order1',
      productId: 'prod1',
      packId: 'pack1',
      snapshots: {
        maxAppsSnapshot: 2,
        ramMbSnapshot: 1024,
        cpuCoresSnapshot: 1,
        storageLimitGbSnapshot: 20,
        packNameSnapshot: 'Starter',
        productNameSnapshot: 'Blog',
      },
    });

    expect(created.id).toBe('hs1');
    expect(mockPrisma.hostingService.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user1',
        orderId: 'order1',
        productId: 'prod1',
        packId: 'pack1',
        maxAppsSnapshot: 2,
        ramMbSnapshot: 1024,
        cpuCoresSnapshot: 1,
        storageLimitGbSnapshot: 20,
        packNameSnapshot: 'Starter',
        productNameSnapshot: 'Blog',
      }),
    });
  });

  it('2. maxAppsSnapshot = 0 est accepté (aucun slot)', async () => {
    mockPrisma.hostingService.create.mockResolvedValue({ id: 'hs0' });
    await expect(
      service.create('user1', {
        snapshots: { maxAppsSnapshot: 0, ramMbSnapshot: 512, cpuCoresSnapshot: 0.5, storageLimitGbSnapshot: null, packNameSnapshot: null, productNameSnapshot: null },
      }),
    ).resolves.toMatchObject({ id: 'hs0' });
    expect(mockPrisma.hostingService.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ maxAppsSnapshot: 0 }) }),
    );
  });

  it('3. maxAppsSnapshot = null est accepté (convention « illimité », non négative)', async () => {
    mockPrisma.hostingService.create.mockResolvedValue({ id: 'hsn' });
    await service.create('user1', {
      snapshots: { maxAppsSnapshot: null, ramMbSnapshot: 2048, cpuCoresSnapshot: 2, storageLimitGbSnapshot: null, packNameSnapshot: null, productNameSnapshot: null },
    });
    expect(mockPrisma.hostingService.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ maxAppsSnapshot: null }) }),
    );
    expect(() =>
      assertSnapshotsValid({ maxAppsSnapshot: null, ramMbSnapshot: 1, cpuCoresSnapshot: 1, storageLimitGbSnapshot: null, packNameSnapshot: null, productNameSnapshot: null }),
    ).not.toThrow();
  });

  it('4. toute valeur négative est refusée', async () => {
    const base = { maxAppsSnapshot: null, ramMbSnapshot: 1, cpuCoresSnapshot: 1, storageLimitGbSnapshot: null, packNameSnapshot: null, productNameSnapshot: null };
    expect(() => assertSnapshotsValid({ ...base, maxAppsSnapshot: -1 })).toThrow(BadRequestException);
    expect(() => assertSnapshotsValid({ ...base, ramMbSnapshot: -1 })).toThrow(BadRequestException);
    expect(() => assertSnapshotsValid({ ...base, cpuCoresSnapshot: -0.5 })).toThrow(BadRequestException);
    expect(() => assertSnapshotsValid({ ...base, storageLimitGbSnapshot: -1 })).toThrow(BadRequestException);
    await expect(
      service.create('user1', { snapshots: { ...base, maxAppsSnapshot: -1 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.hostingService.create).not.toHaveBeenCalled();
    // même garde-fou quand les snapshots dérivent d'un pack invalide
    expect(() =>
      snapshotsFromPack({ name: 'Bad', ramMb: -1, cpuCores: 1, storageLimit: null, maxApps: null }),
    ).toThrow(BadRequestException);
    expect(() =>
      snapshotsFromPack({ name: 'Bad', ramMb: 1024, cpuCores: 1, storageLimit: null, maxApps: -3 }),
    ).toThrow(BadRequestException);
  });

  // ── 5-7 : provenance et ownership ──────────────────────────────────────────

  it('5. lie exactement la commande du propriétaire (relation Order)', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ownedOrder('order9'));
    mockPrisma.hostingService.create.mockResolvedValue({ id: 'hs9' });
    await service.create('user1', {
      orderId: 'order9',
      snapshots: { maxAppsSnapshot: 1, ramMbSnapshot: 1024, cpuCoresSnapshot: 1, storageLimitGbSnapshot: null, packNameSnapshot: null, productNameSnapshot: null },
    });
    expect(mockPrisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'order9' },
      include: { customer: { select: { userId: true } } },
    });
    expect(mockPrisma.hostingService.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderId: 'order9' }) }),
    );
    // une commande inexistante n'est jamais liée
    mockPrisma.order.findUnique.mockResolvedValue(null);
    await expect(
      service.create('user1', {
        orderId: 'order-missing',
        snapshots: { maxAppsSnapshot: null, ramMbSnapshot: 1, cpuCoresSnapshot: 1, storageLimitGbSnapshot: null, packNameSnapshot: null, productNameSnapshot: null },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('6. lie exactement l’abonnement du propriétaire (relation Subscription)', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ownedOrder('order1'));
    mockPrisma.subscription.findUnique.mockResolvedValue({ id: 'sub1', userId: 'user1', orderId: 'order1' });
    mockPrisma.hostingService.create.mockResolvedValue({ id: 'hs-sub' });
    await service.create('user1', {
      subscriptionId: 'sub1',
      orderId: 'order1',
      snapshots: { maxAppsSnapshot: null, ramMbSnapshot: 1, cpuCoresSnapshot: 1, storageLimitGbSnapshot: null, packNameSnapshot: null, productNameSnapshot: null },
    });
    expect(mockPrisma.subscription.findUnique).toHaveBeenCalledWith({ where: { id: 'sub1' } });
    expect(mockPrisma.hostingService.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ subscriptionId: 'sub1', orderId: 'order1' }) }),
    );
    // incohérence commande/abonnement → refus (aucun croisement d'autorités)
    mockPrisma.subscription.findUnique.mockResolvedValue({ id: 'sub1', userId: 'user1', orderId: 'order-other' });
    await expect(
      service.create('user1', {
        subscriptionId: 'sub1',
        orderId: 'order1',
        snapshots: { maxAppsSnapshot: null, ramMbSnapshot: 1, cpuCoresSnapshot: 1, storageLimitGbSnapshot: null, packNameSnapshot: null, productNameSnapshot: null },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('7. ownership étranger refusé (404, jamais de fuite d’existence)', async () => {
    // (a) lecture d'un service d'un autre client
    mockPrisma.hostingService.findUnique.mockResolvedValue({ id: 'hs-foreign', userId: 'user2' });
    await expect(service.get('hs-foreign', 'user1')).rejects.toBeInstanceOf(NotFoundException);
    // (b) commande d'un autre client
    mockPrisma.order.findUnique.mockResolvedValue(ownedOrder('order-foreign', 'user2'));
    await expect(
      service.create('user1', {
        orderId: 'order-foreign',
        snapshots: { maxAppsSnapshot: null, ramMbSnapshot: 1, cpuCoresSnapshot: 1, storageLimitGbSnapshot: null, packNameSnapshot: null, productNameSnapshot: null },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // (c) abonnement d'un autre client
    mockPrisma.subscription.findUnique.mockResolvedValue({ id: 'sub-foreign', userId: 'user2', orderId: null });
    await expect(
      service.create('user1', {
        subscriptionId: 'sub-foreign',
        snapshots: { maxAppsSnapshot: null, ramMbSnapshot: 1, cpuCoresSnapshot: 1, storageLimitGbSnapshot: null, packNameSnapshot: null, productNameSnapshot: null },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // (d) réservation sur un service étranger (verrou FOR UPDATE → 0 ligne)
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await expect(service.reserveSlot(reserveArgs({ hostingServiceId: 'hs-foreign' }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // (e) liaison à un déploiement qui n'appartient pas au service
    lockMocks({ allocation: lockRow(), deployment: { userId: 'user2' } });
    await expect(
      service.markBound({
        allocationId: 'alloc1',
        actorUserId: 'user1',
        deploymentId: 'dep-foreign',
        proof: { providerProven: true },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(mockPrisma.hostingServiceAllocation.update).not.toHaveBeenCalled();
  });

  // ── 8-12 : réservation et consommation de slot ─────────────────────────────

  it('8. un service CANCELLED n’est jamais réservable', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      serviceRow({ id: 'hs-cancelled', status: HostingServiceStatus.CANCELLED, maxAppsSnapshot: 1 }),
    ]);
    await expect(
      service.reserveSlot(reserveArgs({ hostingServiceId: 'hs-cancelled' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPrisma.hostingServiceAllocation.create).not.toHaveBeenCalled();
  });

  it('9. une allocation RESERVED consomme un slot', async () => {
    expect(consumesSlot(HostingServiceAllocationStatus.RESERVED)).toBe(true);
    mockPrisma.hostingServiceAllocation.count.mockResolvedValue(2);
    await expect(service.countConsumingAllocations('hs1')).resolves.toBe(2);
    expect(mockPrisma.hostingServiceAllocation.count).toHaveBeenCalledWith({
      where: { hostingServiceId: 'hs1', status: { in: ['RESERVED', 'BOUND', 'RELEASING'] } },
    });
  });

  it('10. une allocation BOUND consomme un slot', () => {
    expect(consumesSlot(HostingServiceAllocationStatus.BOUND)).toBe(true);
    expect(CONSUMING_ALLOCATION_STATUSES).toContain(HostingServiceAllocationStatus.BOUND);
  });

  it('11. une allocation RELEASING consomme encore un slot (slot incertain)', () => {
    expect(consumesSlot(HostingServiceAllocationStatus.RELEASING)).toBe(true);
    expect(CONSUMING_ALLOCATION_STATUSES).toContain(HostingServiceAllocationStatus.RELEASING);
  });

  it('12. une allocation RELEASED ne consomme plus de slot', async () => {
    expect(consumesSlot(HostingServiceAllocationStatus.RELEASED)).toBe(false);
    expect(CONSUMING_ALLOCATION_STATUSES).not.toContain(HostingServiceAllocationStatus.RELEASED);
    mockPrisma.hostingServiceAllocation.count.mockResolvedValue(0);
    await service.countConsumingAllocations('hs1');
    const where = mockPrisma.hostingServiceAllocation.count.mock.calls[0][0].where;
    expect(where.status.in).not.toContain(HostingServiceAllocationStatus.RELEASED);
  });

  it('9b. réserve un slot en RESERVED sur un service actif (verrou + empreinte stockée)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([serviceRow()]);
    mockPrisma.hostingServiceAllocation.count.mockResolvedValue(0);
    mockPrisma.hostingServiceAllocation.create.mockResolvedValue({ id: 'alloc1', status: 'RESERVED' });
    await expect(service.reserveSlot(reserveArgs())).resolves.toMatchObject({
      allocation: { id: 'alloc1' },
      replayed: false,
    });
    expect(mockPrisma.hostingServiceAllocation.create).toHaveBeenCalledWith({
      data: {
        hostingServiceId: 'hs1',
        idempotencyKey: 'direct:v1:user1:hs1:' + UUID,
        status: HostingServiceAllocationStatus.RESERVED,
        requestFingerprint: fingerprint(),
      },
    });
    // le verrou porte l'ownership : id + userId + FOR UPDATE dans la requête
    const tag = mockPrisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray;
    expect(String(tag.join(''))).toContain('FOR UPDATE');
    expect(mockPrisma.$queryRaw.mock.calls[0]).toContain('hs1');
    expect(mockPrisma.$queryRaw.mock.calls[0]).toContain('user1');
  });

  // ── 13-14 : unicité ────────────────────────────────────────────────────────

  it('13. refuse une clé d’idempotence dupliquée (P2002 → 409)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([serviceRow()]);
    mockPrisma.hostingServiceAllocation.count.mockResolvedValue(0);
    mockPrisma.hostingServiceAllocation.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.reserveSlot(reserveArgs())).rejects.toBeInstanceOf(ConflictException);
  });

  it('14. refuse un Deployment déjà lié à une allocation (P2002 → 409)', async () => {
    lockMocks({ allocation: lockRow({ status: HostingServiceAllocationStatus.RESERVED }), deployment: { userId: 'user1' } });
    mockPrisma.hostingServiceAllocation.update.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.markBound({ allocationId: 'alloc1', actorUserId: 'user1', deploymentId: 'dep1', proof: { providerProven: true } }),
    ).rejects.toBeInstanceOf(ConflictException);
    // une allocation déjà liée à UN AUTRE déploiement est refusée avant écriture
    mockPrisma.hostingServiceAllocation.update.mockClear();
    lockMocks({ allocation: lockRow({ status: HostingServiceAllocationStatus.BOUND, deploymentId: 'dep2' }) });
    await expect(
      service.markBound({ allocationId: 'alloc1', actorUserId: 'user1', deploymentId: 'dep1', proof: { providerProven: true } }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mockPrisma.hostingServiceAllocation.update).not.toHaveBeenCalled();
  });

  // ── 21 : CPU strictement FINI (service) ───────────────────────────────────

  it('21. CPU fini : 0 et positifs acceptés, négatif/NaN/Infinity refusés sans fuite SQL', async () => {
    const base = { maxAppsSnapshot: null, ramMbSnapshot: 1, cpuCoresSnapshot: 1, storageLimitGbSnapshot: null, packNameSnapshot: null, productNameSnapshot: null };

    // acceptés : 0 (aucun CPU) et toute valeur finie positive, fractionnaire ou non
    expect(() => assertSnapshotsValid({ ...base, cpuCoresSnapshot: 0 })).not.toThrow();
    expect(() => assertSnapshotsValid({ ...base, cpuCoresSnapshot: 0.5 })).not.toThrow();
    expect(() => assertSnapshotsValid({ ...base, cpuCoresSnapshot: 2.75 })).not.toThrow();

    // refus explicites : négatif, NaN, +Infinity, -Infinity
    const refused = [-0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const cpuCoresSnapshot of refused) {
      expect(() => assertSnapshotsValid({ ...base, cpuCoresSnapshot })).toThrow(BadRequestException);
    }

    // dérivation depuis un pack au CPU non fini → refusée également
    expect(() => snapshotsFromPack({ name: 'BadCPU', ramMb: 1024, cpuCores: Number.NaN, storageLimit: null, maxApps: null })).toThrow(BadRequestException);
    expect(() => snapshotsFromPack({ name: 'BadCPU', ramMb: 1024, cpuCores: Number.POSITIVE_INFINITY, storageLimit: null, maxApps: null })).toThrow(BadRequestException);

    // AUCUNE écriture pour une valeur non finie (refus avant tout accès DB)
    mockPrisma.hostingService.create.mockClear();
    for (const cpuCoresSnapshot of refused) {
      await expect(service.create('user1', { snapshots: { ...base, cpuCoresSnapshot } })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(mockPrisma.hostingService.create).not.toHaveBeenCalled();

    // aucun message interne (SQL, contrainte, moteur) n'est exposé au client
    const failure = await service
      .create('user1', { snapshots: { ...base, cpuCoresSnapshot: Number.NaN } })
      .catch((error: unknown) => error as BadRequestException);
    expect(failure).toBeInstanceOf(BadRequestException);
    const message = (failure as BadRequestException).message;
    expect(message).toContain('Snapshot CPU');
    expect(message).not.toMatch(/select|insert|update|delete|check|constraint|relation|postgres|prisma|pg_|double precision|nan|infinity/i);
  });

  // ── 19-20 : gel des snapshots et absence totale d'action provider ─────────

  it('19. les snapshots ne sont jamais recalculés depuis un pack modifié', async () => {
    const pack = { id: 'pack1', name: 'Starter', ramMb: 1024, cpuCores: 1, storageLimit: 20, maxApps: 2 };
    const product = { name: 'Blog' };
    const snapshots = snapshotsFromPack(pack, product);
    expect(snapshots).toEqual({
      maxAppsSnapshot: 2,
      ramMbSnapshot: 1024,
      cpuCoresSnapshot: 1,
      storageLimitGbSnapshot: 20,
      packNameSnapshot: 'Starter',
      productNameSnapshot: 'Blog',
    });
    // Le catalogue change APRÈS l'achat : les valeurs déjà dérivées sont des
    // copies de valeurs, et le service ne lit JAMAIS le pack après création
    // (aucun délégué hostingPack n'existe d'ailleurs sur ce double de Prisma).
    pack.maxApps = 10;
    pack.ramMb = 4096;
    pack.name = 'Pro';
    expect(snapshots).toEqual({
      maxAppsSnapshot: 2,
      ramMbSnapshot: 1024,
      cpuCoresSnapshot: 1,
      storageLimitGbSnapshot: 20,
      packNameSnapshot: 'Starter',
      productNameSnapshot: 'Blog',
    });
    mockPrisma.hostingService.create.mockResolvedValue({ id: 'hs-frozen' });
    await service.create('user1', { packId: 'pack1', productId: 'prod1', snapshots });
    expect(mockPrisma.hostingService.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ maxAppsSnapshot: 2, ramMbSnapshot: 1024, packNameSnapshot: 'Starter' }) }),
    );
    expect((mockPrisma as Record<string, unknown>).hostingPack).toBeUndefined();
  });

  it('20. n’exécute aucune action provider (aucun transport panel/DNS injecté)', async () => {
    let guardedRef: unknown;
    const allocationRow = {
      id: 'alloc1',
      hostingServiceId: 'hs1',
      deploymentId: null,
      idempotencyKey: 'direct:v1:user1:hs1:' + UUID,
      status: HostingServiceAllocationStatus.RESERVED,
      requestFingerprint: null,
      providerIntentAt: null,
      reservedAt: new Date(),
      boundAt: null,
      releasedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ownerUserId: 'user1',
    };
    const real = {
      // verrous bruts dispatchés par instruction : ① service (s."userId"),
      // ② allocation (a.*), ③ déploiement (d."userId"), sinon verrou
      // de service de reserveSlot.
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('d."userId"')) {
          return [{ userId: 'user1' }];
        }
        if (sql.includes('s."userId"')) {
          return [{ userId: 'user1' }];
        }
        if (sql.includes('a.*')) {
          return [allocationRow];
        }
        return [{ id: 'hs1', userId: 'user1', status: HostingServiceStatus.ACTIVE, maxAppsSnapshot: 1 }];
      }),
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(guardedRef)),
      hostingService: {
        create: jest.fn().mockResolvedValue({ id: 'hs1' }),
        findUnique: jest.fn().mockResolvedValue({ id: 'hs1', userId: 'user1', status: HostingServiceStatus.ACTIVE }),
      },
      hostingServiceAllocation: {
        create: jest.fn().mockResolvedValue({ id: 'alloc1' }),
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'alloc1', status: HostingServiceAllocationStatus.BOUND }),
        update: jest.fn().mockResolvedValue({ id: 'alloc1', status: HostingServiceAllocationStatus.BOUND }),
        count: jest.fn().mockResolvedValue(0),
      },
      order: { findUnique: jest.fn().mockResolvedValue(ownedOrder()) },
      subscription: { findUnique: jest.fn().mockResolvedValue({ id: 'sub1', userId: 'user1', orderId: 'order1' }) },
    };
    const ALLOWED = Object.keys(real);
    const guarded = new Proxy({} as Record<string, unknown>, {
      get(_target, property: string) {
        if (!ALLOWED.includes(property)) {
          throw new Error(`délégué non autorisé : ${property}`);
        }
        return real[property as keyof typeof real];
      },
    });
    guardedRef = guarded;
    const guardedService = new HostingServicesService(guarded as never);

    const snapshots = { maxAppsSnapshot: 1, ramMbSnapshot: 1024, cpuCoresSnapshot: 1, storageLimitGbSnapshot: null, packNameSnapshot: 'Starter', productNameSnapshot: null };
    await guardedService.create('user1', { orderId: 'order1', subscriptionId: 'sub1', snapshots });
    await guardedService.get('hs1', 'user1');
    await guardedService.reserveSlot(reserveArgs());
    await guardedService.markBound({ allocationId: 'alloc1', actorUserId: 'user1', deploymentId: 'dep1', proof: { providerProven: true } });
    await guardedService.markProviderIntent({ allocationId: 'alloc1', actorUserId: 'user1' });
    await guardedService.releasePreProvider({ allocationId: 'alloc1', actorUserId: 'user1' });
    await guardedService.countConsumingAllocations('hs1');

    // Aucun transport (panel/Coolify, DNS/Cloudflare, Hestia…) n'est injecté :
    // le service ne connaît que les délégués Prisma du domaine.
    expect(Object.keys(guardedService)).toEqual(['prisma']);
    // 'deployment' RETIRÉ de la liste blanche : le service ne touche plus le
    // délégué Deployment (ownership vérifiée sous verrou SQL, pas de lecture
    // libre) — tout appel au délégué ferait échouer ce test.
    expect(ALLOWED).toEqual([
      '$queryRaw',
      '$transaction',
      'hostingService',
      'hostingServiceAllocation',
      'order',
      'subscription',
    ]);
  });

  // ── 17B.4F-C1 : moteur de réservation + primitives d'état (zéro réseau) ──

  describe('17B.4F-C1 (moteur local, aucun appel réseau)', () => {
    const existingAllocation = (over: Record<string, unknown> = {}) => ({
      id: 'alloc1',
      hostingServiceId: 'hs1',
      deploymentId: null,
      idempotencyKey: `direct:v1:user1:hs1:${UUID}`,
      status: HostingServiceAllocationStatus.RESERVED,
      requestFingerprint: fingerprint(),
      providerIntentAt: null,
      reservedAt: new Date(),
      boundAt: null,
      releasedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });
    const intentArgs = { allocationId: 'alloc1', actorUserId: 'user1' };

    beforeEach(() => {
      lockMocks();
    });

    it('C1.1 rejeu idempotent : même clé + même payload → MÊME allocation, une seule création', async () => {
      const created = existingAllocation();
      mockPrisma.hostingServiceAllocation.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(created);
      mockPrisma.hostingServiceAllocation.count.mockResolvedValue(1);
      mockPrisma.hostingServiceAllocation.create.mockResolvedValue(created);

      const first = await service.reserveSlot(reserveArgs());
      const second = await service.reserveSlot(reserveArgs());

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.allocation).toBe(created);
      expect(mockPrisma.hostingServiceAllocation.create).toHaveBeenCalledTimes(1);
      // le rejeu ne re-compte ni quota ni statut : 1 seul comptage au total
      expect(mockPrisma.hostingServiceAllocation.count).toHaveBeenCalledTimes(1);
    });

    it('C1.2 empreinte différente au rejeu → Conflict, aucune écriture', async () => {
      const alien = computeFingerprint(
        { business: { productId: 'autre-produit' }, environment: payload.environment },
        loadKeyring(),
      );
      mockPrisma.hostingServiceAllocation.findUnique.mockResolvedValue(
        existingAllocation({ requestFingerprint: alien }),
      );
      await expect(service.reserveSlot(reserveArgs())).rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.hostingServiceAllocation.create).not.toHaveBeenCalled();
      expect(mockPrisma.hostingServiceAllocation.count).not.toHaveBeenCalled();
    });

    it('C1.3 rejeu d’une allocation RELEASED → retournée telle quelle (terminal, jamais ressuscitée)', async () => {
      mockPrisma.hostingServiceAllocation.findUnique.mockResolvedValue(
        existingAllocation({ status: HostingServiceAllocationStatus.RELEASED, releasedAt: new Date() }),
      );
      const result = await service.reserveSlot(reserveArgs());
      expect(result.replayed).toBe(true);
      expect(result.allocation.status).toBe(HostingServiceAllocationStatus.RELEASED);
      expect(mockPrisma.hostingServiceAllocation.create).not.toHaveBeenCalled();
      expect(mockPrisma.hostingServiceAllocation.count).not.toHaveBeenCalled();
    });

    it('C1.4 quota atteint → Forbidden, aucune création', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([serviceRow({ maxAppsSnapshot: 1 })]);
      mockPrisma.hostingServiceAllocation.count.mockResolvedValue(1);
      await expect(service.reserveSlot(reserveArgs())).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.hostingServiceAllocation.create).not.toHaveBeenCalled();
    });

    it('C1.5 seul ACTIVE est réservable (SUSPENDED refusé)', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        serviceRow({ status: HostingServiceStatus.SUSPENDED }),
      ]);
      await expect(service.reserveSlot(reserveArgs())).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.hostingServiceAllocation.create).not.toHaveBeenCalled();
    });

    it('C1.6 clientRequestId non UUID v4 → BadRequest avant toute DB', async () => {
      await expect(service.reserveSlot(reserveArgs({ clientRequestId: 'key-1' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
      expect(mockPrisma.hostingServiceAllocation.create).not.toHaveBeenCalled();
    });

    it('C1.7 configuration d’empreinte absente → 503, aucune création', async () => {
      const savedKeys = process.env.HOSTING_FP_KEYS;
      const savedLegacy = process.env.ENCRYPTION_KEY;
      delete process.env.HOSTING_FP_KEYS;
      delete process.env.ENCRYPTION_KEY;
      try {
        await expect(service.reserveSlot(reserveArgs())).rejects.toBeInstanceOf(ServiceUnavailableException);
      } finally {
        if (savedKeys !== undefined) process.env.HOSTING_FP_KEYS = savedKeys;
        if (savedLegacy !== undefined) process.env.ENCRYPTION_KEY = savedLegacy;
      }
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
      expect(mockPrisma.hostingServiceAllocation.create).not.toHaveBeenCalled();
    });

    it('C1.8 intention provider : écrite sous verrou, irréversible, jamais sur RELEASED', async () => {
      lockMocks();
      mockPrisma.hostingServiceAllocation.update.mockResolvedValue({});
      const applied = await service.markProviderIntent(intentArgs);
      expect(applied.applied).toBe(true);
      expect(mockPrisma.hostingServiceAllocation.update).toHaveBeenCalledWith({
        where: { id: 'alloc1' },
        data: { providerIntentAt: expect.any(Date) },
      });

      mockPrisma.hostingServiceAllocation.update.mockClear();
      lockMocks({ allocation: lockRow({ providerIntentAt: new Date() }) });
      await expect(service.markProviderIntent(intentArgs)).resolves.toEqual({
        applied: false,
        reason: 'already_present',
      });

      lockMocks({ allocation: lockRow({ status: HostingServiceAllocationStatus.RELEASED }) });
      await expect(service.markProviderIntent(intentArgs)).resolves.toEqual({
        applied: false,
        reason: 'terminal',
      });
      expect(mockPrisma.hostingServiceAllocation.update).not.toHaveBeenCalled();
    });

    it('C1.9 compensation pré-provider : conditions strictes sous verrou', async () => {
      lockMocks();
      mockPrisma.hostingServiceAllocation.update.mockResolvedValue({});
      const released = await service.releasePreProvider(intentArgs);
      expect(released).toEqual({ released: true });
      expect(mockPrisma.hostingServiceAllocation.update).toHaveBeenCalledWith({
        where: { id: 'alloc1' },
        data: {
          status: HostingServiceAllocationStatus.RELEASED,
          releasedAt: expect.any(Date),
        },
      });

      mockPrisma.hostingServiceAllocation.update.mockClear();
      const refusals: Array<[Record<string, unknown>, string]> = [
        [{ providerIntentAt: new Date() }, 'intent_present'],
        [{ deploymentId: 'dep1' }, 'linked'],
        [{ status: HostingServiceAllocationStatus.RELEASED }, 'already_released'],
        [{ status: HostingServiceAllocationStatus.BOUND }, 'invalid_state'],
      ];
      for (const [over, reason] of refusals) {
        lockMocks({ allocation: lockRow(over) });
        await expect(service.releasePreProvider(intentArgs)).resolves.toEqual({ released: false, reason });
      }
      expect(mockPrisma.hostingServiceAllocation.update).not.toHaveBeenCalled();
    });

    it('C1.10 intention gagnante → compensation refusée ; compensation gagnante → intention refusée', async () => {
      // (a) l'intention gagnante rend toute compensation ultérieure impossible
      lockMocks();
      mockPrisma.hostingServiceAllocation.update.mockResolvedValue({});
      await service.markProviderIntent(intentArgs);
      lockMocks({ allocation: lockRow({ providerIntentAt: new Date() }) });
      await expect(service.releasePreProvider(intentArgs)).resolves.toEqual({
        released: false,
        reason: 'intent_present',
      });

      // (b) la compensation gagnante rend toute intention ultérieure impossible
      lockMocks({ allocation: lockRow({ status: HostingServiceAllocationStatus.RELEASED }) });
      await expect(service.markProviderIntent(intentArgs)).resolves.toEqual({
        applied: false,
        reason: 'terminal',
      });

      // une SEULE écriture locale au total : jamais d'effacement du marqueur,
      // jamais de RELEASED porteur d'une intention
      expect(mockPrisma.hostingServiceAllocation.update).toHaveBeenCalledTimes(1);
    });

    it('C1.11 liens d’état : preuve exigée, RELEASING→BOUND interdit, RELEASED terminal', async () => {
      // preuve provider exigée AVANT toute écriture (412)
      await expect(
        service.markBound({
          allocationId: 'alloc1',
          actorUserId: 'user1',
          deploymentId: 'dep1',
          proof: { providerProven: false },
        }),
      ).rejects.toBeInstanceOf(PreconditionFailedException);
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();

      lockMocks({ allocation: lockRow({ status: HostingServiceAllocationStatus.RELEASING }) });
      await expect(
        service.markBound({
          allocationId: 'alloc1',
          actorUserId: 'user1',
          deploymentId: 'dep1',
          proof: { providerProven: true },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      lockMocks({ allocation: lockRow({ status: HostingServiceAllocationStatus.RELEASED }) });
      await expect(
        service.markBound({
          allocationId: 'alloc1',
          actorUserId: 'user1',
          deploymentId: 'dep1',
          proof: { providerProven: true },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.hostingServiceAllocation.update).not.toHaveBeenCalled();
    });

    it('C1.12 startReleasing / completeRelease : contrats de preuve et transitions', async () => {
      lockMocks();
      // RESERVED → RELEASING
      mockPrisma.hostingServiceAllocation.update.mockResolvedValue({
        id: 'alloc1',
        status: HostingServiceAllocationStatus.RELEASING,
      });
      const started = await service.startReleasing(intentArgs);
      expect(started.status).toBe(HostingServiceAllocationStatus.RELEASING);
      expect(mockPrisma.hostingServiceAllocation.update).toHaveBeenCalledWith({
        where: { id: 'alloc1' },
        data: { status: HostingServiceAllocationStatus.RELEASING },
      });

      // idempotent : RELEASING → RELEASING (aucune écriture)
      mockPrisma.hostingServiceAllocation.update.mockClear();
      lockMocks({ allocation: lockRow({ status: HostingServiceAllocationStatus.RELEASING }) });
      mockPrisma.hostingServiceAllocation.findUniqueOrThrow.mockResolvedValue({
        id: 'alloc1',
        status: HostingServiceAllocationStatus.RELEASING,
      });
      await expect(service.startReleasing(intentArgs)).resolves.toMatchObject({
        status: HostingServiceAllocationStatus.RELEASING,
      });
      expect(mockPrisma.hostingServiceAllocation.update).not.toHaveBeenCalled();

      // RELEASED terminal pour startReleasing
      lockMocks({ allocation: lockRow({ status: HostingServiceAllocationStatus.RELEASED }) });
      await expect(service.startReleasing(intentArgs)).rejects.toBeInstanceOf(ForbiddenException);

      // completeRelease : preuve exigée AVANT toute écriture (412)
      await expect(
        service.completeRelease({ ...intentArgs, proof: { providerCleanupProven: false } }),
      ).rejects.toBeInstanceOf(PreconditionFailedException);

      // état non RELEASING → refus
      lockMocks({ allocation: lockRow({ status: HostingServiceAllocationStatus.RESERVED }) });
      await expect(
        service.completeRelease({ ...intentArgs, proof: { providerCleanupProven: true } }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // déploiement encore lié → Conflict (détachement exigé avant RELEASED)
      lockMocks({
        allocation: lockRow({ status: HostingServiceAllocationStatus.RELEASING, deploymentId: 'dep1' }),
      });
      await expect(
        service.completeRelease({ ...intentArgs, proof: { providerCleanupProven: true } }),
      ).rejects.toBeInstanceOf(ConflictException);

      // RELEASING sans déploiement + preuve → RELEASED
      mockPrisma.hostingServiceAllocation.update.mockResolvedValue({
        id: 'alloc1',
        status: HostingServiceAllocationStatus.RELEASED,
      });
      lockMocks({ allocation: lockRow({ status: HostingServiceAllocationStatus.RELEASING }) });
      const done = await service.completeRelease({
        ...intentArgs,
        proof: { providerCleanupProven: true },
      });
      expect(done.status).toBe(HostingServiceAllocationStatus.RELEASED);

      // idempotent : RELEASED → RELEASED (aucune écriture)
      mockPrisma.hostingServiceAllocation.update.mockClear();
      lockMocks({ allocation: lockRow({ status: HostingServiceAllocationStatus.RELEASED }) });
      mockPrisma.hostingServiceAllocation.findUniqueOrThrow.mockResolvedValue({
        id: 'alloc1',
        status: HostingServiceAllocationStatus.RELEASED,
      });
      await expect(
        service.completeRelease({ ...intentArgs, proof: { providerCleanupProven: true } }),
      ).resolves.toMatchObject({ status: HostingServiceAllocationStatus.RELEASED });
      expect(mockPrisma.hostingServiceAllocation.update).not.toHaveBeenCalled();
    });

    it('C1.13 allocation étrangère ou inexistante → 404 sur toutes les primitives', async () => {
      lockMocks({ service: null });
      await expect(
        service.markBound({
          allocationId: 'alloc1',
          actorUserId: 'user1',
          deploymentId: 'dep1',
          proof: { providerProven: true },
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.markProviderIntent(intentArgs)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.releasePreProvider(intentArgs)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.startReleasing(intentArgs)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.completeRelease({ ...intentArgs, proof: { providerCleanupProven: true } }),
      ).rejects.toBeInstanceOf(NotFoundException);

      // service d'un autre propriétaire → 404 aussi (aucune confirmation d'existence)
      lockMocks({ service: serviceRow({ userId: 'user2' }) });
      await expect(service.startReleasing(intentArgs)).rejects.toBeInstanceOf(NotFoundException);

      expect(mockPrisma.hostingServiceAllocation.update).not.toHaveBeenCalled();
      expect(mockPrisma.hostingServiceAllocation.create).not.toHaveBeenCalled();
    });

    it('C1.14 ordre de verrous déterministe : HostingService → HostingServiceAllocation → Deployment', async () => {
      lockMocks({ allocation: lockRow(), deployment: { userId: 'user1' } });
      mockPrisma.hostingServiceAllocation.update.mockResolvedValue({});

      // primitive sans déploiement : ① service puis ② allocation (2 verrous)
      await service.markProviderIntent(intentArgs);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
      const sql = (index: number): string =>
        String((mockPrisma.$queryRaw.mock.calls[index]?.[0] as TemplateStringsArray).join('?'));
      expect(sql(0)).toContain('FROM "HostingService"');
      expect(sql(0)).toContain('s."userId"');
      expect(sql(0)).toContain('FOR UPDATE');
      expect(sql(1)).toContain('FROM "HostingServiceAllocation"');
      expect(sql(1)).toContain('a.*');
      expect(sql(1)).toContain('FOR UPDATE');
      expect(mockPrisma.$queryRaw.mock.calls[1]).toContain('alloc1');

      // markBound : ③ Deployment verrouillé APRÈS service et allocation
      mockPrisma.$queryRaw.mockClear();
      mockPrisma.hostingServiceAllocation.update.mockResolvedValue({
        id: 'alloc1',
        status: HostingServiceAllocationStatus.BOUND,
      });
      await service.markBound({
        allocationId: 'alloc1',
        actorUserId: 'user1',
        deploymentId: 'dep1',
        proof: { providerProven: true },
      });
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(3);
      expect(sql(0)).toContain('FROM "HostingService"');
      expect(sql(1)).toContain('FROM "HostingServiceAllocation"');
      expect(sql(2)).toContain('FROM "Deployment"');
      expect(sql(2)).toContain('d."userId"');
      expect(sql(2)).toContain('FOR UPDATE');
      expect(mockPrisma.$queryRaw.mock.calls[2]).toContain('dep1');
    });

    it('C1.15 RELEASING + même déploiement : idempotent SANS transition vers BOUND', async () => {
      lockMocks({
        allocation: lockRow({
          status: HostingServiceAllocationStatus.RELEASING,
          deploymentId: 'dep1',
        }),
        deployment: { userId: 'user1' },
      });
      mockPrisma.hostingServiceAllocation.findUniqueOrThrow.mockResolvedValue({
        id: 'alloc1',
        status: HostingServiceAllocationStatus.RELEASING,
        deploymentId: 'dep1',
      });
      const result = await service.markBound({
        allocationId: 'alloc1',
        actorUserId: 'user1',
        deploymentId: 'dep1',
        proof: { providerProven: true },
      });
      // retour de l'état COURANT (RELEASING) : aucun retour en arrière, aucune écriture
      expect(result.status).toBe(HostingServiceAllocationStatus.RELEASING);
      expect(mockPrisma.hostingServiceAllocation.update).not.toHaveBeenCalled();
    });
  });
});
