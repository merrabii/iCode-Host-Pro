import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { OrderCancelService, isAbsentExternalError } from './order-cancel.service';

/**
 * 17B.4E-E2-B — unitaires du terminate idempotent :
 * gate (O1–O6), CAS + history (O7–O11), provider (O12–O17), DNS/ownership
 * (O18–O24), Invoice/Subscription (O25–O28), projet retained (O29),
 * idempotence/concurrence (O30–O32), safety (O33–O35).
 */
describe('OrderCancelService.terminateActiveService (17B.4E-E2-B)', () => {
  const actor = { sub: 'admin-1', email: 'admin@example.com' };
  const REASON = 'Terminaison service actif — test unitaire';

  let service: OrderCancelService;
  /** État Order simulé pour CAS + rollback transactionnel. */
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

  function baseOrder(status = 'ACTIVE') {
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

  function terminateDetails(): Record<string, unknown> {
    const call = audit.record.mock.calls.find(
      (c) => c[0].action === 'order.terminate_active_service',
    );
    return (call![0].details ?? {}) as Record<string, unknown>;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    orderStatus = 'ACTIVE';
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

  describe('gate statuts (O1–O6)', () => {
    it('O1 — Order ACTIVE → CANCELLED (1re terminaison)', async () => {
      const out = await service.terminateActiveService('ord-1', REASON, actor);
      expect(out.orderStatus).toBe('CANCELLED');
      expect(out.alreadyTerminated).toBe(false);
      expect(orderStatus).toBe('CANCELLED');
    });

    it('O2 — Order SUSPENDED → 409 (jamais écrit en production, non autorisé)', async () => {
      prisma.order.findUnique.mockResolvedValue(baseOrder('SUSPENDED'));
      await expect(service.terminateActiveService('ord-1', REASON, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(tx.deployment.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'order.terminate_active_service' }),
      );
    });

    it('O3 — Order CANCELLED → rejeu idempotent alreadyTerminated=true', async () => {
      orderStatus = 'CANCELLED';
      prisma.order.findUnique.mockImplementation(async () => baseOrder('CANCELLED'));

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.alreadyTerminated).toBe(true);
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
      expect(prisma.deployment.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'ord-1' },
        data: { reconcileNextAt: null },
      });
      expect(out.provider).toBe('deleted');
      expect(out.partial).toBe(false);
    });

    it('O4 — Order PROVISIONING → 409 + mention cancel-provisioning, zéro écriture', async () => {
      prisma.order.findUnique.mockResolvedValue(baseOrder('PROVISIONING'));
      await expect(service.terminateActiveService('ord-1', REASON, actor)).rejects.toMatchObject({
        message: expect.stringContaining('cancel-provisioning'),
      });
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(tx.deployment.delete).not.toHaveBeenCalled();
      expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
      expect(tx.subscription.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'order.terminate_active_service' }),
      );
    });

    it.each(['REFUNDED', 'PENDING_PAYMENT', 'PAID'])(
      'O5 — Order %s → 409 (REFUNDED JAMAIS transformé en CANCELLED)',
      async (status) => {
        orderStatus = status;
        prisma.order.findUnique.mockResolvedValue(baseOrder(status));
        await expect(service.terminateActiveService('ord-1', REASON, actor)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(orderStatus).toBe(status);
        expect(tx.order.updateMany).not.toHaveBeenCalled();
        expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
        expect(transport.deleteApplication).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: 'order.terminate_active_service' }),
        );
      },
    );

    it('O6 — Order absent → 404, aucune écriture', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(service.terminateActiveService('missing', REASON, actor)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(transport.deleteApplication).not.toHaveBeenCalled();
    });
  });

  describe('CAS + history (O7–O11)', () => {
    it('O7 — CAS gagné : updateMany(where status=ACTIVE) + history unique + reconcileNextAt=null', async () => {
      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'ord-1', status: 'ACTIVE' },
        data: { status: 'CANCELLED' },
      });
      expect(tx.orderStatusHistory.create).toHaveBeenCalledTimes(1);
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
      expect(out.alreadyTerminated).toBe(false);
    });

    it('O8 — CAS perdu puis relecture CANCELLED → rejeu, pas de 2e history', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(baseOrder('ACTIVE'));
      tx.order.updateMany.mockResolvedValue({ count: 0 });
      tx.order.findUnique.mockResolvedValue(baseOrder('CANCELLED'));

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.alreadyTerminated).toBe(true);
      expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
      expect(tx.deployment.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'ord-1' },
        data: { reconcileNextAt: null },
      });
      expect(out.provider).toBe('deleted');
    });

    it('O9 — CAS perdu vers statut interdit (PROVISIONING) → 409, zéro cleanup', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(baseOrder('ACTIVE'));
      tx.order.updateMany.mockResolvedValue({ count: 0 });
      tx.order.findUnique.mockResolvedValue(baseOrder('PROVISIONING'));

      await expect(service.terminateActiveService('ord-1', REASON, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(tx.deployment.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'order.terminate_active_service' }),
      );
    });

    it('O10 — history.create échoue → rollback, Order reste ACTIVE, zéro externe', async () => {
      transactionWithRollback();
      tx.orderStatusHistory.create.mockRejectedValue(new Error('history boom'));

      await expect(service.terminateActiveService('ord-1', REASON, actor)).rejects.toThrow(
        'history boom',
      );

      expect(orderStatus).toBe('ACTIVE');
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(tx.deployment.delete).not.toHaveBeenCalled();
      expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'order.terminate_active_service' }),
      );
    });

    it('O11 — reconcileNextAt échoue → rollback, Order reste ACTIVE, zéro externe', async () => {
      transactionWithRollback();
      tx.deployment.updateMany.mockRejectedValue(new Error('reconcile boom'));

      await expect(service.terminateActiveService('ord-1', REASON, actor)).rejects.toThrow(
        'reconcile boom',
      );

      expect(orderStatus).toBe('ACTIVE');
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'order.terminate_active_service' }),
      );
    });
  });

  describe('provider (O12–O17)', () => {
    it('O12 — provider 200/204 → deleted, Deployment supprimé, partial=false', async () => {
      const out = await service.terminateActiveService('ord-1', REASON, actor);
      expect(transport.deleteApplication).toHaveBeenCalled();
      expect(out.provider).toBe('deleted');
      expect(out.deployment).toBe('deleted');
      expect(out.partial).toBe(false);
    });

    it('O13 — provider 404 → absent confirmé, Deployment supprimé localement', async () => {
      transport.deleteApplication.mockRejectedValue(new Error('HTTP 404 not found'));
      const out = await service.terminateActiveService('ord-1', REASON, actor);
      expect(out.provider).toBe('absent');
      expect(out.deployment).toBe('deleted');
      expect(tx.deployment.delete).toHaveBeenCalled();
      expect(out.partial).toBe(false);
    });

    it('O14 — provider 401/403 → failed, Deployment CONSERVÉ, partial=true', async () => {
      transport.deleteApplication.mockRejectedValue(new Error('HTTP 401 unauthorized'));
      tx.deployment.findUnique.mockResolvedValue(baseDeployment());

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.provider).toBe('failed');
      expect(out.deployment).toBe('kept');
      expect(out.partial).toBe(true);
      expect(tx.deployment.delete).not.toHaveBeenCalled();
    });

    it('O15 — provider timeout → failed/unknown, kept, partial=true, log statique sans secret', async () => {
      transport.deleteApplication.mockRejectedValue(
        new Error('connect ETIMEDOUT SECRET_TOKEN_XYZ'),
      );
      tx.deployment.findUnique.mockResolvedValue(baseDeployment());

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(['failed', 'unknown']).toContain(out.provider);
      expect(out.deployment).toBe('kept');
      expect(out.partial).toBe(true);
      expect(tx.deployment.delete).not.toHaveBeenCalled();
      expect(allLogArgs()).not.toContain('SECRET_TOKEN_XYZ');
      expect(allLogArgs()).toContain('terminate: suppression provider échouée');
      expect(terminateDetails().partial).toBe(true);
    });

    it('O16 — Deployment sans coolifyUuid → provider=unknown, kept, partial=true, aucun delete', async () => {
      prisma.deployment.findUnique.mockResolvedValue(baseDeployment({ coolifyUuid: null }));
      tx.deployment.findUnique.mockResolvedValue(baseDeployment({ coolifyUuid: null }));

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.provider).toBe('unknown');
      expect(out.deployment).toBe('kept');
      expect(out.partial).toBe(true);
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(tx.deployment.delete).not.toHaveBeenCalled();
      expect(allLogArgs()).toContain('terminate: ressource provider non identifiable');
    });

    it('O17 — aucun Deployment → provider=absent, deployment=absent, partial=false', async () => {
      prisma.deployment.findUnique.mockResolvedValue(null);

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.provider).toBe('absent');
      expect(out.deployment).toBe('absent');
      expect(out.partial).toBe(false);
      expect(transport.deleteApplication).not.toHaveBeenCalled();
      expect(tx.deployment.delete).not.toHaveBeenCalled();
    });
  });

  describe('DNS / ownership (O18–O24)', () => {
    it('O18 — DNS deleted + ownership exact → CS supprimée, partial=false', async () => {
      const out = await service.terminateActiveService('ord-1', REASON, actor);
      expect(cloudflare.deleteDnsRecord).toHaveBeenCalled();
      expect(out.dns).toBe('deleted');
      expect(out.clientSubdomain).toBe('deleted');
      expect(out.partial).toBe(false);
      expect(terminateDetails().csOwnership).toBe('exact');
    });

    it('O19 — DNS 404 → absent confirmé, CS supprimée si ownership prouvé', async () => {
      cloudflare.deleteDnsRecord.mockRejectedValue(new Error('record does not exist 404'));
      const out = await service.terminateActiveService('ord-1', REASON, actor);
      expect(out.dns).toBe('absent');
      expect(out.clientSubdomain).toBe('deleted');
      expect(out.partial).toBe(false);
    });

    it('O20 — CS exact sans recordId → dns=unknown, CS conservée, partial=true, aucun appel CF', async () => {
      prisma.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-1',
        fqdn: 'app.example.com',
        recordId: null,
        domainId: 'dom-1',
        deploymentId: 'dep-1',
      });

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.dns).toBe('unknown');
      expect(out.clientSubdomain).toBe('kept');
      expect(out.partial).toBe(true);
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
    });

    it('O21 — ownership exact → delete CS sous DNS confirmé', async () => {
      const out = await service.terminateActiveService('ord-1', REASON, actor);
      expect(terminateDetails().csOwnership).toBe('exact');
      expect(out.clientSubdomain).toBe('deleted');
      expect(tx.clientSubdomain.delete).toHaveBeenCalled();
    });

    it('O22 — legacy_proven → ownership prouvé, delete CS possible', async () => {
      prisma.clientSubdomain.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findFirst.mockResolvedValue({
        id: 'cs-legacy',
        fqdn: 'app.example.com',
        recordId: 'rec-1',
        domainId: 'dom-1',
        deploymentId: null,
      });

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.clientSubdomain).toBe('deleted');
      expect(terminateDetails().csOwnership).toBe('legacy_proven');
      expect(out.partial).toBe(false);
    });

    it('O23 — ownership ambiguous → CS conservée, dns unknown, partial=true, aucun delete CF', async () => {
      prisma.clientSubdomain.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findFirst.mockResolvedValue({
        id: 'cs-amb',
        fqdn: 'app.example.com',
        recordId: 'rec-keep',
        domainId: 'dom-autre',
        deploymentId: null,
      });

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.clientSubdomain).toBe('kept');
      expect(out.dns).toBe('unknown');
      expect(out.partial).toBe(true);
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
    });

    it('O24 — ownership foreign (CS d’un AUTRE Deployment) → conservée, partial=true, aucun delete', async () => {
      prisma.clientSubdomain.findUnique.mockResolvedValue(null);
      prisma.clientSubdomain.findFirst.mockResolvedValue({
        id: 'cs-other',
        fqdn: 'app.example.com',
        recordId: 'rec-x',
        domainId: 'dom-1',
        deploymentId: 'dep-autre',
      });

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.clientSubdomain).toBe('kept');
      expect(out.dns).toBe('unknown');
      expect(out.partial).toBe(true);
      expect(cloudflare.deleteDnsRecord).not.toHaveBeenCalled();
      expect(tx.clientSubdomain.delete).not.toHaveBeenCalled();
      expect(terminateDetails().csOwnership).toBe('foreign');
    });
  });

  describe('Invoice / Subscription (O25–O28)', () => {
    it('O25 — Invoice PAID → left_paid, AUCUNE écriture invoice', async () => {
      const out = await service.terminateActiveService('ord-1', REASON, actor);
      expect(out.invoice).toBe('left_paid');
      expect(terminateDetails().invoice).toBe('left_paid');
      expect(terminateDetails().invoicePolicy).toBe('no_auto_refund_e2b');
      expect(tx.invoice.findUnique).toHaveBeenCalled();
      // transaction mock = pas d'update invoice possible, mais on vérifie
      // que la clé update n'existe pas côté invoice.
      expect((tx as { invoice: { update?: unknown; create?: unknown; delete?: unknown } }).invoice.update).toBeUndefined();
    });

    it('O26 — Subscription ACTIVE → CANCELLED (lien orderId exact)', async () => {
      tx.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        orderId: 'ord-1',
        status: 'ACTIVE',
      });

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.subscription).toBe('cancelled');
      expect(tx.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: { status: 'CANCELLED' },
      });
    });

    it('O27 — Subscription déjà CANCELLED → already_cancelled, pas de 2e update', async () => {
      tx.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        orderId: 'ord-1',
        status: 'CANCELLED',
      });

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.subscription).toBe('already_cancelled');
      expect(tx.subscription.update).not.toHaveBeenCalled();
    });

    it('O28 — Subscription étrangère (orderId différent) → absent, aucune écriture', async () => {
      tx.subscription.findUnique.mockResolvedValue({
        id: 'sub-x',
        orderId: 'autre-ordre',
        status: 'ACTIVE',
      });

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.subscription).toBe('absent');
      expect(tx.subscription.update).not.toHaveBeenCalled();
    });
  });

  describe('projet retained (O29)', () => {
    it('O29 — project=TOUJOURS retained dans la réponse ET l’audit ; aucune suppression projet', async () => {
      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.project).toBe('retained');
      expect(terminateDetails().project).toBe('retained');

      // Aucun appel de type projet (PAS de deleteProject / clientProject.delete).
      const allTxMocks = [tx as unknown as Record<string, unknown>];
      expect(allTxMocks[0].clientProject).toBeUndefined();
      expect(allTxMocks[0].coolifyProject).toBeUndefined();
      expect(
        (transport as unknown as Record<string, unknown>).deleteProject,
      ).toBeUndefined();
    });
  });

  describe('idempotence + concurrence (O30–O32)', () => {
    it('O30 — double appel : 2e rejoue, 1 seule history, déjàTerminated=true, Invoice/projet conservés', async () => {
      const first = await service.terminateActiveService('ord-1', REASON, actor);
      expect(first.alreadyTerminated).toBe(false);
      expect(orderStatus).toBe('CANCELLED');

      // 2e appel : Order déjà CANCELLED au gate.
      prisma.order.findUnique.mockImplementation(async () => baseOrder('CANCELLED'));
      prisma.deployment.findUnique.mockResolvedValue(baseDeployment());

      const second = await service.terminateActiveService('ord-1', 'Rejeu idempotent e2b', actor);

      expect(second.alreadyTerminated).toBe(true);
      expect(second.invoice).toBe('left_paid');
      expect(second.project).toBe('retained');
      expect(tx.orderStatusHistory.create).toHaveBeenCalledTimes(1);
      expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    });

    it('O31 — deux appels simultanés : un CAS gagne, l’autre → alreadyTerminated (pas de 2e history)', async () => {
      // Simule le 2e appel qui perd son CAS (count=0) puis relit CANCELLED.
      prisma.order.findUnique.mockResolvedValueOnce(baseOrder('ACTIVE'));
      tx.order.updateMany.mockResolvedValue({ count: 0 });
      tx.order.findUnique.mockResolvedValue(baseOrder('CANCELLED'));

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.alreadyTerminated).toBe(true);
      expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
      expect(out.provider).toBe('deleted');
      expect(tx.deployment.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'ord-1' },
        data: { reconcileNextAt: null },
      });
    });

    it('O32a — terminate gagne (CANCELLED) → CAS d’activation ultérieure reçoit count=0 (noop)', async () => {
      await service.terminateActiveService('ord-1', REASON, actor);
      expect(orderStatus).toBe('CANCELLED');

      // activation PROVISIONING→ACTIVE (pattern activateOrderAfterProof) :
      const activation = await tx.order.updateMany({
        where: { id: 'ord-1', status: 'PROVISIONING' },
        data: { status: 'ACTIVE' },
      });
      expect(activation.count).toBe(0);
      // Et le gate d'activation exige aussi PROVISIONING|ACTIVE → CANCELLED = noop.
      expect(['PROVISIONING', 'ACTIVE']).not.toContain(orderStatus);
    });

    it('O32b — activation gagne d’abord (PROVISIONING→ACTIVE) puis terminate peut terminer proprement', async () => {
      // Order était PROVISIONING, activation l’a mis ACTIVE avant terminate.
      orderStatus = 'ACTIVE';
      prisma.order.findUnique.mockImplementation(async () => baseOrder('ACTIVE'));

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.alreadyTerminated).toBe(false);
      expect(orderStatus).toBe('CANCELLED');
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'ord-1', status: 'ACTIVE' },
        data: { status: 'CANCELLED' },
      });
    });
  });

  describe('safety (O33–O35)', () => {
    it('O33 — exception inattendue provider → AUCUNE suppression locale, partial=true', async () => {
      transport.deleteApplication.mockRejectedValue(new Error('boom inattendu interne'));
      tx.deployment.findUnique.mockResolvedValue(baseDeployment());

      const out = await service.terminateActiveService('ord-1', REASON, actor);

      expect(out.provider).toBe('failed');
      expect(out.deployment).toBe('kept');
      expect(tx.deployment.delete).not.toHaveBeenCalled();
      expect(out.partial).toBe(true);
    });

    it('O34 — logs sans secret : aucun message d’exception brut transmis au Logger', async () => {
      transport.deleteApplication.mockRejectedValue(new Error('HTTP 500 JWT_SECRET=abc123'));
      cloudflare.deleteDnsRecord.mockRejectedValue(new Error('HTTP 500 CF_TOKEN=xyz789'));
      prisma.deployment.findUnique.mockResolvedValue(baseDeployment());
      tx.deployment.findUnique.mockResolvedValue(baseDeployment());
      prisma.clientSubdomain.findUnique.mockResolvedValue({
        id: 'cs-1',
        fqdn: 'app.example.com',
        recordId: null, // force DNS failed/unknown path sans CF
        domainId: 'dom-1',
        deploymentId: 'dep-1',
      });

      await service.terminateActiveService('ord-1', REASON, actor);

      const logs = allLogArgs();
      expect(logs).not.toContain('JWT_SECRET=abc123');
      expect(logs).not.toContain('CF_TOKEN=xyz789');
      expect(logs).not.toContain('boom');
      // Logger.error jamais invoqué sur le workflow terminate (warn statiques seulement).
      expect(errorSpy).not.toHaveBeenCalled();
      expect(logs).toContain('terminate:');
    });

    it('O35 — aucune ressource étrangère affectée : seules les rows de l’orderId sont touchées', async () => {
      await service.terminateActiveService('ord-1', REASON, actor);

      // Tous les appels rows sont scopés par orderId ou id de CETTE commande.
      expect(tx.deployment.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'ord-1' },
        data: { reconcileNextAt: null },
      });
      expect(tx.subscription.findUnique).toHaveBeenCalledWith({ where: { orderId: 'ord-1' } });
      expect(tx.invoice.findUnique).toHaveBeenCalledWith({ where: { orderId: 'ord-1' } });
      expect(prisma.deployment.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orderId: 'ord-1' } }),
      );
      // Jamais d'updateMany global (sans where.id / orderId).
      for (const call of tx.subscription.update.mock.calls) {
        expect(call[0].where).toBeDefined();
        expect(call[0].where.id).toBeDefined();
      }
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'order.terminate_active_service',
          resourceId: 'ord-1',
        }),
      );
    });

    it('isAbsentExternalError — classification 404 partagée (clé du contrat absent confirmé)', () => {
      expect(isAbsentExternalError(new Error('HTTP 404'))).toBe(true);
      expect(isAbsentExternalError(new Error('Record not found'))).toBe(true);
      expect(isAbsentExternalError(new Error('ECONNREFUSED'))).toBe(false);
    });
  });
});
