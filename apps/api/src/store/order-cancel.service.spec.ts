import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { OrderCancelService, isAbsentExternalError } from './order-cancel.service';

// 17B.4E-D-B1 — unitaires du cancel idempotent : gate, CAS atomique D1,
// conservation D2/D3, ownership C1 (A–H), provider C2 (A–G), logs D5, Invoice.
describe('OrderCancelService (17B.4E-D-B1)', () => {
  const actor = { sub: 'admin-1', email: 'admin@example.com' };
  const REASON = 'Provisioning abandonné — nettoyage rollback';

  let service: OrderCancelService;
  /** État Order simulé pour CAS + rollback transactionnel (D1). */
  let orderStatus: string;

  const prisma = {
    order: { findUnique: jest.fn(), updateMany: jest.fn() },
    orderStatusHistory: { create: jest.fn() },
    deployment: { findUnique: jest.fn(), updateMany: jest.fn() },
    clientSubdomain: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
    subscription: { findUnique: jest.fn(), update: jest.fn() },
    invoice: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const tx = {
    order: { updateMany: jest.fn(), findUnique: jest.fn() },
    orderStatusHistory: { create: jest.fn() },
    deployment: { updateMany: jest.fn(), delete: jest.fn(), findUnique: jest.fn() },
    clientSubdomain: { delete: jest.fn(), findUnique: jest.fn() },
    subscription: { findUnique: jest.fn(), update: jest.fn() },
    invoice: { findUnique: jest.fn() },
  };
  const audit = { record: jest.fn() };
  const crypto = { decrypt: jest.fn(() => 'tok') };
  const cloudflare = { deleteDnsRecord: jest.fn() };
  const transport = { deleteApplication: jest.fn() };
  const panelFactory = { create: jest.fn(() => transport) };

  const coolifyServer = {
    id: 'srv-1',
    panelProvider: 'COOLIFY',
    apiBaseUrl: 'http://panel.example:8000/api/v1',
    apiTokenEnc: 'enc:tok',
    strictTls: true,
  };

  function baseOrder(status = 'PROVISIONING') {
    return {
      id: 'ord-1',
      status,
      domainValue: 'app.example.com',
      effectiveDomainId: 'dom-1',
      requestedDomainId: null,
      customer: { userId: 'owner-1' },
    };
  }

  function baseDeployment(overrides: Record<string, unknown> = {}) {
    return {
      id: 'dep-1',
      orderId: 'ord-1',
      userId: 'owner-1',
      coolifyUuid: 'uuid-1',
      reconcileNextAt: new Date('2026-01-01'),
      server: coolifyServer,
      ...overrides,
    };
  }

  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  function allLogArgs(): string {
    const calls = [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat();
    return calls
      .map((arg: unknown) => {
        if (typeof arg === 'string') return arg;
        try {
          const json = JSON.stringify(arg);
          return json === undefined ? String(arg) : json;
        } catch {
          return String(arg);
        }
      })
      .join('\n');
  }

  function cancelDetails(): Record<string, unknown> {
    const call = audit.record.mock.calls.find((c) => c[0].action === 'order.cancel_provisioning');
    return (call![0].details ?? {}) as Record<string, unknown>;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    orderStatus = 'PROVISIONING';
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    service = new OrderCancelService(
      prisma as never,
      audit as never,
      crypto as never,
      cloudflare as never,
      panelFactory as never,
    );

    prisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) =>
      cb(tx),
    );

    prisma.order.findUnique.mockImplementation(async () => baseOrder(orderStatus));

    tx.order.updateMany.mockImplementation(
      async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
        if (orderStatus === where.status) {
          orderStatus = data.status;
          return { count: 1 };
        }
        return { count: 0 };
      },
    );
    tx.order.findUnique.mockImplementation(async () => baseOrder(orderStatus));
    tx.orderStatusHistory.create.mockResolvedValue({ id: 'h1' });
    tx.deployment.updateMany.mockResolvedValue({ count: 1 });
    prisma.deployment.updateMany.mockResolvedValue({ count: 1 });

    prisma.deployment.findUnique.mockResolvedValue(baseDeployment());
    prisma.clientSubdomain.findUnique.mockResolvedValue({
      id: 'cs-1',
      fqdn: 'app.example.com',
      recordId: 'rec-1',
      domainId: 'dom-1',
      deploymentId: 'dep-1',
    });
    prisma.clientSubdomain.findFirst.mockResolvedValue(null);
    transport.deleteApplication.mockResolvedValue(undefined);
    cloudflare.deleteDnsRecord.mockResolvedValue({ id: 'rec-1' });
    tx.clientSubdomain.delete.mockResolvedValue({});
    tx.clientSubdomain.findUnique.mockResolvedValue(null);
    tx.deployment.delete.mockResolvedValue({});
    tx.deployment.findUnique.mockResolvedValue(null);
    tx.subscription.findUnique.mockResolvedValue({
      id: 'sub-1',
      orderId: 'ord-1',
      status: 'ACTIVE',
    });
    tx.subscription.update.mockResolvedValue({});
    tx.invoice.findUnique.mockResolvedValue({
      id: 'inv-1',
      orderId: 'ord-1',
      status: 'PAID',
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function transactionWithRollback(): void {
    prisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => {
      const snapshot = orderStatus;
      try {
        return await cb(tx);
      } catch (e) {
        orderStatus = snapshot;
        throw e;
      }
    });
  }

  describe('isAbsentExternalError', () => {
    it('détecte 404 / not found / introuvable sans brancher un provider', () => {
      expect(isAbsentExternalError(new Error('HTTP 404'))).toBe(true);
      expect(isAbsentExternalError(new Error('Record not found'))).toBe(true);
      expect(isAbsentExternalError(new Error('Resource introuvable'))).toBe(true);
      expect(isAbsentExternalError(new Error('ECONNREFUSED'))).toBe(false);
      expect(isAbsentExternalError(new Error('HTTP 500'))).toBe(false);
    });
  });

  describe('gate statuts (A)', () => {
    it('Order absent → 404', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(service.cancelProvisioning('missing', REASON, actor)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(transport.deleteApplication).not.toHaveBeenCalled();
    });

    it.each(['PAID', 'ACTIVE', 'SUSPENDED', 'REFUNDED', 'PENDING_PAYMENT'])(
      'Order %s → 409, aucune écriture',
      async (status) => {
        prisma.order.findUnique.mockResolvedValue(baseOrder(status));
        await expect(service.cancelProvisioning('ord-1', REASON, actor)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(tx.order.updateMany).not.toHaveBeenCalled();
        expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
        expect(transport.deleteApplication).not.toHaveBeenCalled();
        expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
        expect(tx.deployment.delete).not.toHaveBeenCalled();
        expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
        expect(tx.subscription.update).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: 'order.cancel_provisioning' }),
        );
      },
    );

    it('reason trop court → Conflict, aucune écriture', async () => {
      prisma.order.findUnique.mockResolvedValue(baseOrder());
      await expect(service.cancelProvisioning('ord-1', 'court', actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tx.order.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('D1 — CAS atomique + history + reconcileNextAt', () => {
    it('CAS gagné → CANCELLED + history + reconcileNextAt=null + cleanup complet', async () => {
      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'ord-1', status: 'PROVISIONING' },
        data: { status: 'CANCELLED' },
      });
      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: {
          orderId: 'ord-1',
          status: 'CANCELLED',
          note: REASON,
          actorId: actor.sub,
          actorEmail: actor.email,
        },
      });
      expect(tx.deployment.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'ord-1' },
        data: { reconcileNextAt: null },
      });
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
      expect(out).toEqual({
        orderId: 'ord-1',
        orderStatus: 'CANCELLED',
        alreadyCancelled: false,
        provider: 'deleted',
        dns: 'deleted',
        deployment: 'deleted',
        clientSubdomain: 'deleted',
        invoice: 'left_paid',
        subscription: 'cancelled',
        partial: false,
      });
      expect(orderStatus).toBe('CANCELLED');
    });

    it('CAS, history et reconcileNextAt utilisent le MÊME client tx', async () => {
      await service.cancelProvisioning('ord-1', REASON, actor);

      expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.orderStatusHistory.create).toHaveBeenCalledTimes(1);
      expect(tx.deployment.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    });

    it('history.create échoue → rollback, Order reste PROVISIONING, zéro externe', async () => {
      transactionWithRollback();
      tx.orderStatusHistory.create.mockRejectedValue(new Error('history boom'));

      await expect(service.cancelProvisioning('ord-1', REASON, actor)).rejects.toThrow(
        'history boom',
      );

      expect(orderStatus).toBe('PROVISIONING');
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(tx.deployment.delete).not.toHaveBeenCalled();
      expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'order.cancel_provisioning' }),
      );
    });

    it('reconcileNextAt échoue → rollback, Order reste PROVISIONING, zéro externe', async () => {
      transactionWithRollback();
      tx.deployment.updateMany.mockRejectedValue(new Error('reconcile boom'));

      await expect(service.cancelProvisioning('ord-1', REASON, actor)).rejects.toThrow(
        'reconcile boom',
      );

      expect(orderStatus).toBe('PROVISIONING');
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'order.cancel_provisioning' }),
      );
    });

    it('Order déjà CANCELLED → alreadyCancelled, neutralise reconcileNextAt, rejeu, CAS non rejoué', async () => {
      orderStatus = 'CANCELLED';
      prisma.order.findUnique.mockImplementation(async () => baseOrder('CANCELLED'));

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.alreadyCancelled).toBe(true);
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
      expect(prisma.deployment.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'ord-1' },
        data: { reconcileNextAt: null },
      });
      expect(out.provider).toBe('deleted');
      expect(out.partial).toBe(false);
    });

    it('CAS count=0 puis relecture ACTIVE (activation gagnée) → 409 SANS suppression', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(baseOrder('PROVISIONING'));
      tx.order.updateMany.mockResolvedValue({ count: 0 });
      tx.order.findUnique.mockResolvedValue(baseOrder('ACTIVE'));

      await expect(service.cancelProvisioning('ord-1', REASON, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(tx.deployment.delete).not.toHaveBeenCalled();
      expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'order.cancel_provisioning' }),
      );
    });

    it('CAS count=0 puis relecture CANCELLED (double cancel) → alreadyCancelled + rejeu + neutralise', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(baseOrder('PROVISIONING'));
      tx.order.updateMany.mockResolvedValue({ count: 0 });
      tx.order.findUnique.mockResolvedValue(baseOrder('CANCELLED'));

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.alreadyCancelled).toBe(true);
      expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
      expect(tx.deployment.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'ord-1' },
        data: { reconcileNextAt: null },
      });
      expect(out.provider).toBe('deleted');
    });

    it('cancel gagne → CAS d’activation (PROVISIONING→ACTIVE) reçoit count=0', async () => {
      await service.cancelProvisioning('ord-1', REASON, actor);
      expect(orderStatus).toBe('CANCELLED');

      const activation = await tx.order.updateMany({
        where: { id: 'ord-1', status: 'PROVISIONING' },
        data: { status: 'ACTIVE' },
      });
      expect(activation.count).toBe(0);
    });
  });

  describe('C2 — provider sans/sans resourceId opaque (A–G)', () => {
    it('A — aucun Deployment local → provider=absent confirmé, deployment=absent, partial=false', async () => {
      prisma.deployment.findUnique.mockResolvedValue(null);

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.provider).toBe('absent');
      expect(out.deployment).toBe('absent');
      expect(out.partial).toBe(false);
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(tx.deployment.delete).not.toHaveBeenCalled();
    });

    it('B — resourceId présent → PanelTransport deleteApplication, 200/204 → deleted', async () => {
      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(transport.deleteApplication).toHaveBeenCalled();
      expect(out.provider).toBe('deleted');
      expect(out.deployment).toBe('deleted');
      expect(out.partial).toBe(false);
    });

    it('C — PanelTransport 404 → absent confirmé, Deployment supprimé localement', async () => {
      transport.deleteApplication.mockRejectedValue(new Error('HTTP 404 not found'));

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.provider).toBe('absent');
      expect(out.deployment).toBe('deleted');
      expect(tx.deployment.delete).toHaveBeenCalled();
      expect(out.partial).toBe(false);
    });

    it('D — PanelTransport erreur réseau → failed, Deployment CONSERVÉ, partial=true, log statique', async () => {
      transport.deleteApplication.mockRejectedValue(new Error('HTTP 500 boom SECRET_P'));
      tx.deployment.findUnique.mockResolvedValue(baseDeployment());

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.provider).toBe('failed');
      expect(out.deployment).toBe('kept');
      expect(tx.deployment.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'ord-1' },
        data: { reconcileNextAt: null },
      });
      expect(out.partial).toBe(true);
      expect(tx.deployment.delete).not.toHaveBeenCalled();
      expect(allLogArgs()).not.toContain('SECRET_P');
      expect(allLogArgs()).toContain('cancel: suppression provider échouée');
      expect(cancelDetails().partial).toBe(true);
      expect(cancelDetails().provider).toBe('failed');
    });

    it('E — Deployment SANS coolifyUuid → provider=unknown, kept, reconcileNextAt=null, partial=true, aucun delete local', async () => {
      prisma.deployment.findUnique.mockResolvedValue(baseDeployment({ coolifyUuid: null }));
      tx.deployment.findUnique.mockResolvedValue(baseDeployment({ coolifyUuid: null }));

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.provider).toBe('unknown');
      expect(out.deployment).toBe('kept');
      expect(out.partial).toBe(true);
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(tx.deployment.delete).not.toHaveBeenCalled();
      expect(tx.deployment.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'ord-1' },
        data: { reconcileNextAt: null },
      });
      expect(cancelDetails().provider).toBe('unknown');
      expect(allLogArgs()).toContain('cancel: ressource provider non identifiable');
      expect(allLogArgs()).not.toContain('SECRET');
    });

    it('F — provider unknown ou failed ⇒ partial=false IMPOSSIBLE (forcé true)', async () => {
      prisma.deployment.findUnique.mockResolvedValue(baseDeployment({ coolifyUuid: null }));
      let out = await service.cancelProvisioning('ord-1', REASON, actor);
      expect(out.provider).toBe('unknown');
      expect(out.partial).toBe(true);

      jest.clearAllMocks();
      orderStatus = 'PROVISIONING';
      service = new OrderCancelService(
        prisma as never,
        audit as never,
        crypto as never,
        cloudflare as never,
        panelFactory as never,
      );
      prisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) =>
        cb(tx),
      );
      prisma.order.findUnique.mockImplementation(async () => baseOrder(orderStatus));
      tx.order.updateMany.mockImplementation(
        async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
          if (orderStatus === where.status) {
            orderStatus = data.status;
            return { count: 1 };
          }
          return { count: 0 };
        },
      );
      tx.order.findUnique.mockImplementation(async () => baseOrder(orderStatus));
      tx.orderStatusHistory.create.mockResolvedValue({ id: 'h1' });
      tx.deployment.updateMany.mockResolvedValue({ count: 1 });
      prisma.deployment.updateMany.mockResolvedValue({ count: 1 });
      prisma.deployment.findUnique.mockResolvedValue(baseDeployment());
      prisma.clientSubdomain.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findFirst.mockResolvedValue(null);
      transport.deleteApplication.mockRejectedValue(new Error('HTTP 500'));
      cloudflare.deleteDnsRecord.mockResolvedValue({ id: 'rec-1' });
      tx.clientSubdomain.delete.mockResolvedValue({});
      tx.clientSubdomain.findUnique.mockResolvedValue(null);
      tx.deployment.delete.mockResolvedValue({});
      tx.deployment.findUnique.mockResolvedValue(null);
      tx.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        orderId: 'ord-1',
        status: 'ACTIVE',
      });
      tx.subscription.update.mockResolvedValue({});
      tx.invoice.findUnique.mockResolvedValue({
        id: 'inv-1',
        orderId: 'ord-1',
        status: 'PAID',
      });
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      out = await service.cancelProvisioning('ord-1', REASON, actor);
      expect(out.provider).toBe('failed');
      expect(out.partial).toBe(true);
    });

    it('G — double POST rejoue l’état unknown (Deployment toujours présent sans resourceId)', async () => {
      prisma.deployment.findUnique.mockResolvedValue(baseDeployment({ coolifyUuid: null }));
      tx.deployment.findUnique.mockResolvedValue(baseDeployment({ coolifyUuid: null }));
      // Le 1er cancel ne supprime pas la row → la relecture Phase 2 la retrouve.
      tx.deployment.findUnique.mockResolvedValue(baseDeployment({ coolifyUuid: null }));

      const first = await service.cancelProvisioning('ord-1', REASON, actor);
      expect(first.provider).toBe('unknown');
      expect(first.deployment).toBe('kept');
      expect(first.alreadyCancelled).toBe(false);
      expect(first.partial).toBe(true);

      orderStatus = 'CANCELLED';
      prisma.order.findUnique.mockImplementation(async () => baseOrder('CANCELLED'));
      prisma.deployment.findUnique.mockResolvedValue(baseDeployment({ coolifyUuid: null }));

      const second = await service.cancelProvisioning('ord-1', 'Rejeu idempotent', actor);
      expect(second.alreadyCancelled).toBe(true);
      expect(second.provider).toBe('unknown');
      expect(second.deployment).toBe('kept');
      expect(second.partial).toBe(true);
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(tx.deployment.delete).not.toHaveBeenCalled();
    });
  });

  describe('provider / DNS (E/G) + D2', () => {
    it('provider OK + DNS OK (ownership exact) → rows supprimées, partial=false', async () => {
      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(transport.deleteApplication).toHaveBeenCalled();
      expect(cloudflare.deleteDnsRecord).toHaveBeenCalled();
      expect(tx.clientSubdomain.delete).toHaveBeenCalled();
      expect(tx.deployment.delete).toHaveBeenCalled();
      expect(out.partial).toBe(false);
      expect(out.deployment).toBe('deleted');
      expect(out.clientSubdomain).toBe('deleted');
      expect(out.dns).toBe('deleted');
      expect(cancelDetails().csOwnership).toBe('exact');
    });

    it('provider 404/absent → confirmé, row Deployment supprimée, partial=false', async () => {
      transport.deleteApplication.mockRejectedValue(new Error('HTTP 404 not found'));

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.provider).toBe('absent');
      expect(out.deployment).toBe('deleted');
      expect(tx.deployment.delete).toHaveBeenCalled();
      expect(out.partial).toBe(false);
    });

    it('provider erreur → Deployment CONSERVÉ, reconcileNextAt null, partial=true, log statique', async () => {
      transport.deleteApplication.mockRejectedValue(new Error('HTTP 500 boom SECRET_P'));
      prisma.deployment.findUnique.mockResolvedValue(baseDeployment());
      tx.deployment.findUnique.mockResolvedValue(baseDeployment());

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.provider).toBe('failed');
      expect(out.deployment).toBe('kept');
      expect(tx.deployment.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'ord-1' },
        data: { reconcileNextAt: null },
      });
      expect(out.partial).toBe(true);
      expect(tx.deployment.delete).not.toHaveBeenCalled();
      expect(allLogArgs()).not.toContain('SECRET_P');
      expect(allLogArgs()).not.toContain('boom');
      expect(allLogArgs()).toContain('cancel: suppression provider échouée');
      expect(cancelDetails().partial).toBe(true);
      expect(cancelDetails().provider).toBe('failed');
    });

    it('D2 — CS exact sans recordId → dns=unknown, row CONSERVÉE, partial=true, aucun appel CF', async () => {
      prisma.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-1',
        fqdn: 'app.example.com',
        recordId: null,
        domainId: 'dom-1',
        deploymentId: 'dep-1',
      });
      tx.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-1',
        fqdn: 'app.example.com',
        recordId: null,
        domainId: 'dom-1',
        deploymentId: 'dep-1',
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.dns).toBe('unknown');
      expect(out.clientSubdomain).toBe('kept');
      expect(out.partial).toBe(true);
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
    });

    it('D2 — CS exact sans domainId → dns=unknown, row CONSERVÉE, partial=true', async () => {
      prisma.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-1',
        fqdn: 'app.example.com',
        recordId: 'rec-1',
        domainId: '',
        deploymentId: 'dep-1',
      });
      tx.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-1',
        fqdn: 'app.example.com',
        recordId: 'rec-1',
        domainId: '',
        deploymentId: 'dep-1',
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.dns).toBe('unknown');
      expect(out.clientSubdomain).toBe('kept');
      expect(out.partial).toBe(true);
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
    });

    it('DNS erreur → ClientSubdomain CONSERVÉE, partial=true, log statique sans secret', async () => {
      cloudflare.deleteDnsRecord.mockRejectedValue(
        new Error('Cloudflare API : HTTP 500 SECRET_DNS'),
      );
      prisma.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-1',
        fqdn: 'app.example.com',
        recordId: 'rec-1',
        domainId: 'dom-1',
        deploymentId: 'dep-1',
      });
      tx.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-1',
        fqdn: 'app.example.com',
        recordId: 'rec-1',
        domainId: 'dom-1',
        deploymentId: 'dep-1',
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.dns).toBe('failed');
      expect(out.clientSubdomain).toBe('kept');
      expect(out.partial).toBe(true);
      expect(allLogArgs()).not.toContain('SECRET_DNS');
      expect(allLogArgs()).not.toContain('HTTP 500');
      expect(allLogArgs()).toContain('cancel: suppression DNS échouée');
    });

    it('CS absente → clientSubdomain: absent, pas de delete, dns skipped confirmé', async () => {
      prisma.clientSubdomain.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findFirst.mockResolvedValue(null);

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.clientSubdomain).toBe('absent');
      expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
      expect(out.dns).toBe('skipped');
      expect(out.partial).toBe(false);
    });
  });

  describe('C1 — ownership ClientSubdomain (A–H)', () => {
    it('A — CS.deploymentId === Deployment.id de CETTE Order → exact, suppressible si DNS confirmé', async () => {
      prisma.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-exact',
        fqdn: 'app.example.com',
        recordId: 'rec-1',
        domainId: 'dom-1',
        deploymentId: 'dep-1',
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.clientSubdomain).toBe('deleted');
      expect(out.dns).toBe('deleted');
      expect(out.partial).toBe(false);
      expect(cancelDetails().csOwnership).toBe('exact');
    });

    it('B — legacy prouvé (fqdn + domainId + owner Customer.userId ↔ Deployment.userId) → legacy_proven', async () => {
      prisma.clientSubdomain.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findFirst.mockResolvedValue({
        id: 'cs-legacy',
        fqdn: 'app.example.com',
        recordId: 'rec-x',
        domainId: 'dom-1',
        deploymentId: null,
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(prisma.clientSubdomain.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { fqdn: 'app.example.com' } }),
      );
      expect(out.clientSubdomain).toBe('deleted');
      expect(out.dns).toBe('deleted');
      expect(cancelDetails().csOwnership).toBe('legacy_proven');
    });

    it('C1 — sans preuve owner (Customer.userId null) → ambiguous, row conservée, partial, aucun CF delete', async () => {
      prisma.order.findUnique.mockImplementation(async () => ({
        ...baseOrder(),
        customer: null,
      }));
      tx.order.findUnique.mockImplementation(async () => ({
        ...baseOrder(orderStatus),
        customer: null,
      }));
      prisma.clientSubdomain.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findFirst.mockResolvedValue({
        id: 'cs-no-owner',
        fqdn: 'app.example.com',
        recordId: 'rec-x',
        domainId: 'dom-1',
        deploymentId: null,
      });
      tx.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-no-owner',
        fqdn: 'app.example.com',
        recordId: 'rec-x',
        domainId: 'dom-1',
        deploymentId: null,
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.clientSubdomain).toBe('kept');
      expect(out.dns).toBe('unknown');
      expect(out.partial).toBe(true);
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
      expect(cancelDetails().csOwnership).toBe('ambiguous');
    });

    it('C1 — sans Deployment de référence, legacy non prouvable → ambiguous, conservée', async () => {
      prisma.deployment.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findFirst.mockResolvedValue({
        id: 'cs-x',
        fqdn: 'app.example.com',
        recordId: 'rec-x',
        domainId: 'dom-1',
        deploymentId: null,
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.clientSubdomain).toBe('kept');
      expect(out.dns).toBe('unknown');
      expect(out.partial).toBe(true);
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(cancelDetails().csOwnership).toBe('ambiguous');
    });

    it('C1 — owner discordant (Deployment.userId ≠ Customer.userId) → ambiguous, conservée', async () => {
      prisma.deployment.findUnique.mockResolvedValue(baseDeployment({ userId: 'owner-OTHER' }));
      prisma.clientSubdomain.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findFirst.mockResolvedValue({
        id: 'cs-mismatch',
        fqdn: 'app.example.com',
        recordId: 'rec-x',
        domainId: 'dom-1',
        deploymentId: null,
      });
      tx.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-mismatch',
        fqdn: 'app.example.com',
        recordId: 'rec-x',
        domainId: 'dom-1',
        deploymentId: null,
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.clientSubdomain).toBe('kept');
      expect(out.dns).toBe('unknown');
      expect(out.partial).toBe(true);
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
      expect(cancelDetails().csOwnership).toBe('ambiguous');
    });

    it('C1 — CS.deploymentId d’un AUTRE Deployment → foreign, conservée, partial, aucun delete', async () => {
      prisma.clientSubdomain.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findFirst.mockResolvedValue({
        id: 'cs-foreign',
        fqdn: 'app.example.com',
        recordId: 'rec-x',
        domainId: 'dom-1',
        deploymentId: 'dep-OTHER',
      });
      tx.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-foreign',
        fqdn: 'app.example.com',
        recordId: 'rec-x',
        domainId: 'dom-1',
        deploymentId: 'dep-OTHER',
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.clientSubdomain).toBe('kept');
      expect(out.dns).toBe('unknown');
      expect(out.partial).toBe(true);
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
      expect(cancelDetails().csOwnership).toBe('foreign');
    });

    it('C1 — fqdn seul sans domaine concordant → ambiguous (jamais owner déduit du fqdn)', async () => {
      prisma.clientSubdomain.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findFirst.mockResolvedValue({
        id: 'cs-other-domain',
        fqdn: 'app.example.com',
        recordId: 'rec-x',
        domainId: 'dom-AUTRE',
        deploymentId: null,
      });
      tx.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-other-domain',
        fqdn: 'app.example.com',
        recordId: 'rec-x',
        domainId: 'dom-AUTRE',
        deploymentId: null,
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.clientSubdomain).toBe('kept');
      expect(out.dns).toBe('unknown');
      expect(out.partial).toBe(true);
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(cancelDetails().csOwnership).toBe('ambiguous');
    });

    it('C1 — legacy sans preuve de domaine sur l’Order → ambiguous, CONSERVÉE', async () => {
      prisma.order.findUnique.mockImplementation(async () => ({
        ...baseOrder(),
        effectiveDomainId: null,
        requestedDomainId: null,
      }));
      tx.order.findUnique.mockImplementation(async () => ({
        ...baseOrder(orderStatus),
        effectiveDomainId: null,
        requestedDomainId: null,
      }));
      prisma.clientSubdomain.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findFirst.mockResolvedValue({
        id: 'cs-x',
        fqdn: 'app.example.com',
        recordId: 'rec-x',
        domainId: 'dom-1',
        deploymentId: null,
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.clientSubdomain).toBe('kept');
      expect(out.dns).toBe('unknown');
      expect(out.partial).toBe(true);
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(cancelDetails().csOwnership).toBe('ambiguous');
    });

    it('H — fqdn+domainId ne suffisent JAMAIS seuls quand un owner existe → sans Deployment.userId, ambiguous', async () => {
      // Owner fields existent (Customer.userId) mais CS n’a pas de userId et pas de
      // Deployment de référence → impossible de prouver l’appartenance.
      prisma.deployment.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findFirst.mockResolvedValue({
        id: 'cs-weak',
        fqdn: 'app.example.com',
        recordId: 'rec-x',
        domainId: 'dom-1',
        deploymentId: null,
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.clientSubdomain).toBe('kept');
      expect(out.partial).toBe(true);
      expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
      expect(cancelDetails().csOwnership).toBe('ambiguous');
    });
  });

  describe('D5 — logs strictement statiques', () => {
    it('exceptions provider/DNS à marqueurs secrets → aucun secret dans Logger.warn/error', async () => {
      transport.deleteApplication.mockRejectedValue(
        new Error('SECRET_PROVIDER_MSG panel.example:8000 coolify token=SECRET_TOKEN'),
      );
      cloudflare.deleteDnsRecord.mockRejectedValue(
        new Error('SECRET_DNS_MSG api.cloudflare.com key=SECRET_TOKEN'),
      );
      prisma.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-1',
        fqdn: 'app.example.com',
        recordId: 'rec-1',
        domainId: 'dom-1',
        deploymentId: 'dep-1',
      });
      tx.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-1',
        fqdn: 'app.example.com',
        recordId: 'rec-1',
        domainId: 'dom-1',
        deploymentId: 'dep-1',
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.provider).toBe('failed');
      expect(out.dns).toBe('failed');
      expect(warnSpy).toHaveBeenCalled();
      const all = allLogArgs();
      for (const marker of [
        'SECRET_PROVIDER_MSG',
        'SECRET_DNS_MSG',
        'SECRET_TOKEN',
        'panel.example:8000',
        'api.cloudflare.com',
        'coolify',
        'Secret',
      ]) {
        expect(all).not.toContain(marker);
      }
      expect(all).toContain('cancel: suppression provider échouée');
      expect(all).toContain('cancel: suppression DNS échouée');
    });

    it('Logger.error jamais invoqué sur le workflow cancel (warn statiques seulement)', async () => {
      transport.deleteApplication.mockRejectedValue(new Error('boom'));
      await service.cancelProvisioning('ord-1', REASON, actor);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('Invoice (B) + Subscription (C)', () => {
    it('Invoice PAID → left_paid, AUCUNE écriture invoice', async () => {
      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.invoice).toBe('left_paid');
      expect(tx.invoice).not.toHaveProperty('update');
      expect(cancelDetails().invoice).toBe('left_paid');
      expect(cancelDetails().invoicePolicy).toBe('no_auto_change_b1');
    });

    it('Invoice absente → absent ; UNPAID → left_unpaid', async () => {
      tx.invoice.findUnique.mockResolvedValue(null);
      let out = await service.cancelProvisioning('ord-1', REASON, actor);
      expect(out.invoice).toBe('absent');

      tx.invoice.findUnique.mockResolvedValue({ id: 'i', orderId: 'ord-1', status: 'UNPAID' });
      out = await service.cancelProvisioning('ord-1', REASON, actor);
      expect(out.invoice).toBe('left_unpaid');
    });

    it('Subscription orderId === order.id ACTIVE → CANCELLED (lien exact)', async () => {
      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(tx.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: { status: 'CANCELLED' },
      });
      expect(out.subscription).toBe('cancelled');
    });

    it('Subscription déjà CANCELLED → already_cancelled, pas de 2e update', async () => {
      tx.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        orderId: 'ord-1',
        status: 'CANCELLED',
      });

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.subscription).toBe('already_cancelled');
      expect(tx.subscription.update).not.toHaveBeenCalled();
    });

    it('Subscription sans orderId correspondant → absent, aucune écriture', async () => {
      tx.subscription.findUnique.mockResolvedValue(null);

      const out = await service.cancelProvisioning('ord-1', REASON, actor);

      expect(out.subscription).toBe('absent');
      expect(tx.subscription.update).not.toHaveBeenCalled();
    });
  });
});
