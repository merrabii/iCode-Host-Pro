import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';

describe('SubscriptionsService', () => {
  let service: SubscriptionsService;
  const mockPrisma = {
    product: { findUnique: jest.fn() },
    subscription: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    deployment: { count: jest.fn() },
    server: { findUnique: jest.fn() },
    hostingServiceAllocation: { count: jest.fn() },
    $transaction: jest.fn(),
  };
  const mockAudit = { record: jest.fn() };
  const mockProvisioning = { syncAppLimits: jest.fn() };
  const mockEffects = {
    suspendApps: jest.fn(),
    resumeApps: jest.fn(),
  };
  const user = { sub: 'u1', email: 'user@example.com' };
  const admin = { sub: 'a1', email: 'admin@example.com' };

  /** TX simulée du gate D10 : `$queryRaw` = verrou User, sonde de table,
   *  puis SELECT services. Par défaut : table absente (skip silencieux). */
  const stubGateTx = (
    probe: Array<{ exists: boolean }> = [{ exists: false }],
    services: Array<{ id: string; status: string }> = [],
  ) => {
    const tx = {
      $queryRaw: jest.fn(),
      subscription: mockPrisma.subscription,
      hostingServiceAllocation: mockPrisma.hostingServiceAllocation,
    };
    tx.$queryRaw
      .mockResolvedValueOnce([]) // verrou User (résultat ignoré)
      .mockResolvedValueOnce(probe) // sonde HostingServiceAllocation
      .mockResolvedValue(services); // SELECT HostingService FOR UPDATE
    mockPrisma.$transaction.mockImplementation(
      async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    );
    return tx;
  };

  /** TX de transition Q5 : verrou `FOR UPDATE` (état recalculé sous verrou),
   *  CAS `updateMany`, sonde HostingService, CAS services. L'ordre des
   *  `$queryRaw` suit l'appel réel : verrou puis sonde. */
  const stubUpdateTx = (
    opts: {
      cur?: { id: string; status: string; orderId?: string | null } | null;
      casCount?: number;
      probe?: boolean;
    } = {},
  ) => {
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(opts.cur ? [opts.cur] : []) // verrou Subscription
        .mockResolvedValue([{ exists: opts.probe ?? false }]), // sonde HostingService
      subscription: {
        updateMany: jest.fn(async () => ({ count: opts.casCount ?? 1 })),
      },
      hostingService: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    mockPrisma.$transaction.mockImplementationOnce(
      async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    );
    return tx;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockEffects.suspendApps.mockResolvedValue({ apps: 0, done: 0, blocked: 0, failed: 0 });
    mockEffects.resumeApps.mockResolvedValue({ apps: 0, done: 0, blocked: 0, failed: 0 });
    stubGateTx();
    service = new SubscriptionsService(
      mockPrisma as never,
      mockAudit as never,
      mockProvisioning as never,
      mockEffects as never,
    );
  });

  describe('cancelMySubscription (client)', () => {
    it('returns 404 for a subscription that is not the actor’s (no existence leak)', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      await expect(service.cancelMySubscription('s1', user)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockPrisma.subscription.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 's1', userId: 'u1' } }),
      );
    });

    it('refuses to cancel a CANCELLED subscription', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({ id: 's1', status: 'CANCELLED' });
      await expect(service.cancelMySubscription('s1', user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('cancels an ACTIVE subscription and journals subscription.cancel', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({ id: 's1', status: 'ACTIVE' });
      mockPrisma.subscription.update.mockResolvedValue({ id: 's1', status: 'CANCELLED' });
      await expect(service.cancelMySubscription('s1', user)).resolves.toMatchObject({
        status: 'CANCELLED',
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'subscription.cancel', actorId: 'u1', resourceId: 's1' }),
      );
    });

    // B0.7 — annulation refusée tant que des apps sont encore rattachées.
    it('B0.7 : refuse l’annulation (409) quand une app est liée par orderId, sans aucune écriture', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 's1',
        status: 'ACTIVE',
        productId: 'p1',
        orderId: 'ord-1',
      });
      mockPrisma.product.findUnique.mockResolvedValue({ packId: null });
      mockPrisma.deployment.count.mockResolvedValue(2);

      await expect(service.cancelMySubscription('s1', user)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mockPrisma.deployment.count).toHaveBeenCalledWith({
        where: { userId: 'u1', orderId: 'ord-1' },
      });
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('B0.7 : refuse aussi via le pack du produit (packId) et balaie orderId OR packId scopés userId', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 's1',
        status: 'ACTIVE',
        productId: 'p1',
        orderId: 'ord-1',
      });
      mockPrisma.product.findUnique.mockResolvedValue({ packId: 'pack1' });
      mockPrisma.deployment.count.mockResolvedValue(1);

      await expect(service.cancelMySubscription('s1', user)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mockPrisma.deployment.count).toHaveBeenCalledWith({
        where: { userId: 'u1', OR: [{ orderId: 'ord-1' }, { packId: 'pack1' }] },
      });

      // Sans commande liée, seul le pack compte (toujours scopé sur le compte).
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 's2',
        status: 'ACTIVE',
        productId: 'p1',
        orderId: null,
      });
      await expect(service.cancelMySubscription('s2', user)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mockPrisma.deployment.count).toHaveBeenCalledWith({
        where: { userId: 'u1', packId: 'pack1' },
      });
    });

    it('B0.7 : 0 app liée ⇒ annulation autorisée (aucun faux blocage)', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 's1',
        status: 'ACTIVE',
        productId: 'p1',
        orderId: 'ord-1',
      });
      mockPrisma.product.findUnique.mockResolvedValue({ packId: 'pack1' });
      mockPrisma.deployment.count.mockResolvedValue(0);
      mockPrisma.subscription.update.mockResolvedValue({ id: 's1', status: 'CANCELLED' });

      await expect(service.cancelMySubscription('s1', user)).resolves.toMatchObject({
        status: 'CANCELLED',
      });
    });

    // ── 17B.4F-C4 (D10) — gate d'annulation atomique ────────────────────────
    it('D10 : allocation consommante ⇒ 409, AUCUNE transition Subscription', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 's1',
        status: 'ACTIVE',
        productId: 'p1',
        orderId: 'ord-1',
      });
      mockPrisma.product.findUnique.mockResolvedValue({ packId: null });
      mockPrisma.deployment.count.mockResolvedValue(0);
      stubGateTx([{ exists: true }], [{ id: 'hs1', status: 'CANCELLED' }]);
      mockPrisma.hostingServiceAllocation.count.mockResolvedValue(2);

      await expect(service.cancelMySubscription('s1', user)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mockPrisma.hostingServiceAllocation.count).toHaveBeenCalled();
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('D10 : service hébergement non terminé ⇒ 409, AUCUNE transition Subscription', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 's1',
        status: 'ACTIVE',
        productId: 'p1',
        orderId: 'ord-1',
      });
      mockPrisma.product.findUnique.mockResolvedValue({ packId: null });
      mockPrisma.deployment.count.mockResolvedValue(0);
      stubGateTx([{ exists: true }], [{ id: 'hs1', status: 'ACTIVE' }]);
      mockPrisma.hostingServiceAllocation.count.mockResolvedValue(0);

      await expect(service.cancelMySubscription('s1', user)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('D10 : services terminés + zéro allocation consommante ⇒ annulation autorisée', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 's1',
        status: 'ACTIVE',
        productId: 'p1',
        orderId: 'ord-1',
      });
      mockPrisma.product.findUnique.mockResolvedValue({ packId: null });
      mockPrisma.deployment.count.mockResolvedValue(0);
      stubGateTx([{ exists: true }], [{ id: 'hs1', status: 'CANCELLED' }]);
      mockPrisma.hostingServiceAllocation.count.mockResolvedValue(0);
      mockPrisma.subscription.update.mockResolvedValue({ id: 's1', status: 'CANCELLED' });

      await expect(service.cancelMySubscription('s1', user)).resolves.toMatchObject({
        status: 'CANCELLED',
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'subscription.cancel' }),
      );
    });
  });

  describe('updateSubscription (admin) — Q5 (verrous, CAS, effets réversibles)', () => {
    const base = { id: 's1', productId: 'p1', status: 'PENDING' };

    it('throws NotFound for an unknown subscription', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      await expect(
        service.updateSubscription('nope', { status: 'ACTIVE' }, admin),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is idempotent when the status is unchanged', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({ ...base });
      await expect(
        service.updateSubscription('s1', { status: 'PENDING' }, admin),
      ).resolves.toMatchObject({ status: 'PENDING' });
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a transition that is not in the whitelist (recalculée sous verrou)', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({ ...base, status: 'REJECTED' });
      stubUpdateTx({ cur: { id: 's1', status: 'REJECTED' } });
      await expect(
        service.updateSubscription('s1', { status: 'ACTIVE' }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.subscription.updateMany).not.toHaveBeenCalled();
    });

    it('Q5 : transition invalidée par l\u2019\u00e9tat verrouill\u00e9 (pr\u00e9-verrou ≠ sous-verrou) \u2192 400', async () => {
      // Pré-lecture ACTIVE (ACTIVE→SUSPENDED autorisé), mais sous le verrou
      // un concurrent a basculé en REJECTED : la transition est RECALCULÉE.
      mockPrisma.subscription.findUnique.mockResolvedValue({ ...base, status: 'ACTIVE' });
      stubUpdateTx({ cur: { id: 's1', status: 'REJECTED' } });
      await expect(
        service.updateSubscription('s1', { status: 'SUSPENDED' }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.subscription.updateMany).not.toHaveBeenCalled();
      expect(mockEffects.suspendApps).not.toHaveBeenCalled();
    });

    it('approves PENDING → ACTIVE and journals subscription.approve (aucun effet app)', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({ ...base });
      stubUpdateTx({ cur: { id: 's1', status: 'PENDING', orderId: null } });
      mockPrisma.subscription.findUniqueOrThrow.mockResolvedValue({ ...base, status: 'ACTIVE' });
      await expect(
        service.updateSubscription('s1', { status: 'ACTIVE' }, admin),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'subscription.approve', resourceId: 's1' }),
      );
      // PENDING→ACTIVE n'arrête ni ne relance d'app.
      expect(mockEffects.suspendApps).not.toHaveBeenCalled();
      expect(mockEffects.resumeApps).not.toHaveBeenCalled();
    });

    it('Q5 : ACTIVE → SUSPENDED verrouille, bascule les services du MÊME abonnement, arrêt réversible', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({ ...base, status: 'ACTIVE', orderId: 'ord-1' });
      const tx = stubUpdateTx({
        cur: { id: 's1', status: 'ACTIVE', orderId: 'ord-1' },
        probe: true,
      });
      mockPrisma.subscription.findUniqueOrThrow.mockResolvedValue({ ...base, status: 'SUSPENDED' });

      const out = await service.updateSubscription('s1', { status: 'SUSPENDED' }, admin);

      expect(tx.subscription.updateMany).toHaveBeenCalledWith({
        where: { id: 's1', status: 'ACTIVE' },
        data: { status: 'SUSPENDED' },
      });
      expect(tx.hostingService.updateMany).toHaveBeenCalledWith({
        where: {
          status: 'ACTIVE',
          OR: [{ subscriptionId: 's1' }, { orderId: { in: ['ord-1'] } }],
        },
        data: { status: 'SUSPENDED' },
      });
      expect(mockPrisma.subscription.updateMany).not.toHaveBeenCalled(); // jamais hors TX
      expect(mockEffects.suspendApps).toHaveBeenCalledWith({
        subscriptionId: 's1',
        holder: 'a1',
        orderId: 'ord-1',
      });
      expect(out).toMatchObject({
        status: 'SUSPENDED',
        effects: { apps: 0, done: 0, blocked: 0, failed: 0 },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceType: 'subscription',
          resourceId: 's1',
          details: expect.objectContaining({
            from: 'ACTIVE',
            to: 'SUSPENDED',
            effects: expect.any(Object),
          }),
        }),
      );
    });

    it('Q5 : réactivation contrôlée SUSPENDED → ACTIVE (relance, AUCUNE écriture de facture)', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({ ...base, status: 'SUSPENDED', orderId: 'ord-1' });
      const tx = stubUpdateTx({
        cur: { id: 's1', status: 'SUSPENDED', orderId: 'ord-1' },
        probe: true,
      });
      mockPrisma.subscription.findUniqueOrThrow.mockResolvedValue({ ...base, status: 'ACTIVE' });

      const out = await service.updateSubscription('s1', { status: 'ACTIVE' }, admin);

      expect(tx.hostingService.updateMany).toHaveBeenCalledWith({
        where: {
          status: 'SUSPENDED',
          OR: [{ subscriptionId: 's1' }, { orderId: { in: ['ord-1'] } }],
        },
        data: { status: 'ACTIVE' },
      });
      expect(mockEffects.resumeApps).toHaveBeenCalledWith({
        subscriptionId: 's1',
        holder: 'a1',
        orderId: 'ord-1',
      });
      expect(mockEffects.suspendApps).not.toHaveBeenCalled();
      expect(out).toMatchObject({ status: 'ACTIVE' });
      // Réactivation = statut seul : aucun modèle facture n'est écrit (sans
      // double facturation) — pas d'appel prisma.invoice dans ce chemin.
      expect((mockPrisma as Record<string, unknown>).invoice).toBeUndefined();
    });

    it('Q5 : course perdue (CAS 0 sous verrou) → 409, aucun effet, état relu', async () => {
      mockPrisma.subscription.findUnique
        .mockResolvedValueOnce({ ...base, status: 'ACTIVE' })
        .mockResolvedValueOnce({ ...base, status: 'ACTIVE' }); // relecture : toujours ACTIVE
      const tx = stubUpdateTx({ cur: { id: 's1', status: 'ACTIVE' }, casCount: 0 });

      await expect(
        service.updateSubscription('s1', { status: 'SUSPENDED' }, admin),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.hostingService.updateMany).not.toHaveBeenCalled();
      expect(mockEffects.suspendApps).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: expect.anything() }),
      );
    });

    it('Q5 : déjà appliqu\u00e9 par un concurrent (sous-verrou = cible) \u2192 idempotent, sans effets', async () => {
      mockPrisma.subscription.findUnique
        .mockResolvedValueOnce({ ...base, status: 'ACTIVE' })
        .mockResolvedValueOnce({ ...base, status: 'SUSPENDED' }); // relecture
      stubUpdateTx({ cur: { id: 's1', status: 'SUSPENDED' } }); // l'autre a gagné

      await expect(
        service.updateSubscription('s1', { status: 'SUSPENDED' }, admin),
      ).resolves.toMatchObject({ status: 'SUSPENDED' });
      expect(mockEffects.suspendApps).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });
  });

  describe('ownership guards', () => {
    it('listMySubscriptions scopes to the actor and exposes the public pack view', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      await service.listMySubscriptions(user);
      expect(mockPrisma.subscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1' },
          include: {
            product: {
              select: {
                id: true,
                name: true,
                kind: true,
                status: true,
                pack: {
                  select: {
                    id: true,
                    name: true,
                    ramMb: true,
                    cpuCores: true,
                    storageLimit: true,
                    maxApps: true,
                    deploymentModule: { select: { id: true, code: true, name: true } },
                  },
                },
              },
            },
          },
        }),
      );
    });
  });

  describe('syncSubscriptionLimits (admin)', () => {
    it('delegates to ProvisioningService.syncAppLimits (Bloc 2/3 resync)', async () => {
      mockPrisma.subscription.findUniqueOrThrow.mockResolvedValue({ id: 's1' });
      mockProvisioning.syncAppLimits.mockResolvedValue({
        subscriptionId: 's1',
        checked: 2,
        applied: 2,
        failed: 0,
      });
      const out = await service.syncSubscriptionLimits('s1');
      expect(mockPrisma.subscription.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 's1' },
      });
      expect(mockProvisioning.syncAppLimits).toHaveBeenCalledWith('s1');
      expect(out).toMatchObject({ subscriptionId: 's1', applied: 2 });
    });
  });
});
