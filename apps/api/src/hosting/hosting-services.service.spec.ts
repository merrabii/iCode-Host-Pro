import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { HostingServiceAllocationStatus, HostingServiceStatus } from '@prisma/client';
import {
  CONSUMING_ALLOCATION_STATUSES,
  HostingServicesService,
  assertSnapshotsValid,
  consumesSlot,
  snapshotsFromPack,
} from './hosting-services.service';

/**
 * 17B.4F-B1 — invariants de sécurité et de quotas du modèle HostingService.
 * (Les classes de classification legacy EXACT / LEGACY_SHARED / AMBIGUOUS /
 * ORPHAN sont couvertes dans legacy-classification.spec.ts.)
 */
describe('HostingServicesService (17B.4F-B1)', () => {
  let service: HostingServicesService;
  const mockPrisma = {
    hostingService: { create: jest.fn(), findUnique: jest.fn() },
    hostingServiceAllocation: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
    order: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    deployment: { findUnique: jest.fn() },
  };

  const ownedOrder = (orderId = 'order1', userId = 'user1') => ({
    id: orderId,
    customer: { userId },
  });

  beforeEach(() => {
    service = new HostingServicesService(mockPrisma as never);
    jest.clearAllMocks();
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
    // (d) réservation sur un service étranger
    await expect(
      service.reserve({ hostingServiceId: 'hs-foreign', actorUserId: 'user1', idempotencyKey: 'k1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // (e) liaison à un déploiement qui n'appartient pas au service
    mockPrisma.hostingServiceAllocation.findUnique.mockResolvedValue({ id: 'alloc1', hostingServiceId: 'hs1', deploymentId: null, status: 'RESERVED' });
    mockPrisma.hostingService.findUnique.mockResolvedValue({ id: 'hs1', userId: 'user1', status: 'ACTIVE' });
    mockPrisma.deployment.findUnique.mockResolvedValue({ id: 'dep-foreign', userId: 'user2' });
    await expect(
      service.bind({ allocationId: 'alloc1', actorUserId: 'user1', deploymentId: 'dep-foreign' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(mockPrisma.hostingServiceAllocation.update).not.toHaveBeenCalled();
  });

  // ── 8-12 : réservation et consommation de slot ─────────────────────────────

  it('8. un service CANCELLED n’est jamais réservable', async () => {
    mockPrisma.hostingService.findUnique.mockResolvedValue({
      id: 'hs-cancelled',
      userId: 'user1',
      status: HostingServiceStatus.CANCELLED,
    });
    await expect(
      service.reserve({ hostingServiceId: 'hs-cancelled', actorUserId: 'user1', idempotencyKey: 'key-1' }),
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

  it('9b. réserve un slot en RESERVED sur un service actif', async () => {
    mockPrisma.hostingService.findUnique.mockResolvedValue({ id: 'hs1', userId: 'user1', status: HostingServiceStatus.ACTIVE });
    mockPrisma.hostingServiceAllocation.create.mockResolvedValue({ id: 'alloc1', status: 'RESERVED' });
    await expect(
      service.reserve({ hostingServiceId: 'hs1', actorUserId: 'user1', idempotencyKey: 'key-1' }),
    ).resolves.toMatchObject({ id: 'alloc1' });
    expect(mockPrisma.hostingServiceAllocation.create).toHaveBeenCalledWith({
      data: { hostingServiceId: 'hs1', idempotencyKey: 'key-1', status: HostingServiceAllocationStatus.RESERVED },
    });
  });

  // ── 13-14 : unicité ────────────────────────────────────────────────────────

  it('13. refuse une clé d’idempotence dupliquée (P2002 → 409)', async () => {
    mockPrisma.hostingService.findUnique.mockResolvedValue({ id: 'hs1', userId: 'user1', status: HostingServiceStatus.ACTIVE });
    mockPrisma.hostingServiceAllocation.create.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.reserve({ hostingServiceId: 'hs1', actorUserId: 'user1', idempotencyKey: 'key-dup' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('14. refuse un Deployment déjà lié à une allocation (P2002 → 409)', async () => {
    mockPrisma.hostingServiceAllocation.findUnique.mockResolvedValue({ id: 'alloc1', hostingServiceId: 'hs1', deploymentId: null, status: HostingServiceAllocationStatus.RESERVED });
    mockPrisma.hostingService.findUnique.mockResolvedValue({ id: 'hs1', userId: 'user1', status: HostingServiceStatus.ACTIVE });
    mockPrisma.deployment.findUnique.mockResolvedValue({ id: 'dep1', userId: 'user1' });
    mockPrisma.hostingServiceAllocation.update.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.bind({ allocationId: 'alloc1', actorUserId: 'user1', deploymentId: 'dep1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    // une allocation déjà liée à UN AUTRE déploiement est refusée avant écriture
    mockPrisma.hostingServiceAllocation.update.mockClear();
    mockPrisma.hostingServiceAllocation.findUnique.mockResolvedValue({ id: 'alloc1', hostingServiceId: 'hs1', deploymentId: 'dep2', status: HostingServiceAllocationStatus.BOUND });
    await expect(
      service.bind({ allocationId: 'alloc1', actorUserId: 'user1', deploymentId: 'dep1' }),
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
    const real = {
      hostingService: { create: jest.fn().mockResolvedValue({ id: 'hs1' }), findUnique: jest.fn().mockResolvedValue({ id: 'hs1', userId: 'user1', status: HostingServiceStatus.ACTIVE }) },
      hostingServiceAllocation: {
        create: jest.fn().mockResolvedValue({ id: 'alloc1' }),
        findUnique: jest.fn().mockResolvedValue({ id: 'alloc1', hostingServiceId: 'hs1', deploymentId: null, status: HostingServiceAllocationStatus.RESERVED }),
        update: jest.fn().mockResolvedValue({ id: 'alloc1', status: HostingServiceAllocationStatus.BOUND }),
        count: jest.fn().mockResolvedValue(1),
      },
      order: { findUnique: jest.fn().mockResolvedValue(ownedOrder()) },
      subscription: { findUnique: jest.fn().mockResolvedValue({ id: 'sub1', userId: 'user1', orderId: 'order1' }) },
      deployment: { findUnique: jest.fn().mockResolvedValue({ id: 'dep1', userId: 'user1' }) },
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
    const guardedService = new HostingServicesService(guarded as never);

    const snapshots = { maxAppsSnapshot: 1, ramMbSnapshot: 1024, cpuCoresSnapshot: 1, storageLimitGbSnapshot: null, packNameSnapshot: 'Starter', productNameSnapshot: null };
    await guardedService.create('user1', { orderId: 'order1', subscriptionId: 'sub1', snapshots });
    await guardedService.get('hs1', 'user1');
    await guardedService.reserve({ hostingServiceId: 'hs1', actorUserId: 'user1', idempotencyKey: 'k' });
    await guardedService.bind({ allocationId: 'alloc1', actorUserId: 'user1', deploymentId: 'dep1' });
    await guardedService.countConsumingAllocations('hs1');

    // Aucun transport (panel/Coolify, DNS/Cloudflare, Hestia…) n'est injecté :
    // le service ne connaît que les délégués Prisma du domaine.
    expect(Object.keys(guardedService)).toEqual(['prisma']);
    expect(ALLOWED).toEqual([
      'hostingService',
      'hostingServiceAllocation',
      'order',
      'subscription',
      'deployment',
    ]);
  });
});
