import { Test } from '@nestjs/testing';
import { InvoiceStatus, OrderStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from './provisioning.service';
import { ORDER_LIFECYCLE_SCHEMA } from './sweep-guards';
import {
  ORDER_SWEEP_ENABLED_ENV,
  ORDER_SWEEP_MS_ENV,
  OrderLifecycleService,
  PENDING_PAYMENT_TTL_HOURS_ENV,
} from './order-lifecycle.service';

/**
 * Q6 (GO item 6) + P2 — sweep de reprise de la vie d'une commande :
 *   - timer OFF par défaut (activation explicite `ORDER_SWEEP_ENABLED=true`),
 *     aucun travail immédiat au démarrage ;
 *   - prérequis de schéma probeés AVANT toute mutation ;
 *   - exclusion multi-processus par lease `SweepLease` (le booléen `running`
 *     local n'est qu'une passe rapide) — lease libéré en `finally` ;
 *   - expiration CAS : SOUS concurrence multi-processus, le perdant n'AUDITE
 *     PAS la transition et ne gonfle pas son compteur ;
 *   - relance PAID : tentative auditéée, transitions protégées par les
 *     CAS/claims internes de `provisionOrder`.
 */
describe('OrderLifecycleService (P2 — expiration + relance, Q6)', () => {
  let prisma: {
    order: { findMany: jest.Mock };
    invoice: { updateMany: jest.Mock };
    orderStatusHistory: { create: jest.Mock };
    sweepLease: { updateMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let provisioning: { provisionOrder: jest.Mock };
  let svc: OrderLifecycleService;

  const staleOrder = { id: 'ord-stale', customerEmail: 'a@test.local' };

  beforeEach(async () => {
    delete process.env[ORDER_SWEEP_ENABLED_ENV]; // héréditarité d'un worker
    delete process.env[ORDER_SWEEP_MS_ENV];
    prisma = {
      order: { findMany: jest.fn(async () => []) },
      invoice: { updateMany: jest.fn(async () => ({ count: 1 })) },
      orderStatusHistory: { create: jest.fn(async () => ({})) },
      // Q6 : lease de passe (par défaut = pas de row → création → token).
      sweepLease: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => ({})),
      },
      $transaction: jest.fn(),
      // Q6 : probe `information_schema` des prérequis.
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join(' ').includes('information_schema.columns')) {
          const table = String(values[0]);
          const req = ORDER_LIFECYCLE_SCHEMA.find((r) => r.table === table);
          if (!req) return [];
          return (req.columns ?? ['id']).map((c) => ({ column_name: c }));
        }
        return [];
      }),
    };
    audit = { record: jest.fn(async () => undefined) };
    provisioning = {
      provisionOrder: jest.fn(async () => ({
        orderId: 'ord-1',
        status: 'PROVISIONING',
        fqdn: null,
        steps: [],
      })),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: ProvisioningService, useValue: provisioning },
        OrderLifecycleService,
      ],
    }).compile();
    svc = moduleRef.get(OrderLifecycleService);
  });

  afterEach(() => {
    svc.onModuleDestroy();
    delete process.env[ORDER_SWEEP_ENABLED_ENV];
    delete process.env[ORDER_SWEEP_MS_ENV];
    delete process.env[PENDING_PAYMENT_TTL_HOURS_ENV];
  });

  /** TX factice : CAS expiration + facture + historique. */
  const txWithCas = (casCount: number) => {
    const tx = {
      order: { updateMany: jest.fn(async () => ({ count: casCount })) },
      invoice: { updateMany: jest.fn(async () => ({ count: 1 })) },
      orderStatusHistory: { create: jest.fn(async () => ({})) },
    };
    prisma.$transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) =>
      cb(tx),
    );
    return tx;
  };

  // ── Ordonnanceur : activation explicite (Q6) ──────────────────────────────

  it('Q6 : configuration ABSENTE → aucun timer, AUCUNE mutation au démarrage', () => {
    const spy = jest.spyOn(global, 'setInterval');
    try {
      svc.onModuleInit();
      expect(spy).not.toHaveBeenCalled();
      expect((svc as unknown as { timer: unknown }).timer).toBeNull();
      // Rien n'est lu ni écrit : n'expire, ne débite, ne suspend, ne provisionne
      // AUCUNE commande.
      expect(prisma.order.findMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(provisioning.provisionOrder).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('Q6 : ORDER_SWEEP_ENABLED=false → aucun timer', () => {
    process.env[ORDER_SWEEP_ENABLED_ENV] = 'false';
    const spy = jest.spyOn(global, 'setInterval');
    try {
      svc.onModuleInit();
      expect(spy).not.toHaveBeenCalled();
      expect((svc as unknown as { timer: unknown }).timer).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('Q6 : valeur ≠ "true" exact (ex. "1", "TRUE") → aucun timer', () => {
    process.env[ORDER_SWEEP_ENABLED_ENV] = 'TRUE';
    const spy = jest.spyOn(global, 'setInterval');
    try {
      svc.onModuleInit();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('Q6 : activation explicite =true → timer planifié à l’intervalle, arrêt propre', () => {
    process.env[ORDER_SWEEP_ENABLED_ENV] = 'true';
    process.env[ORDER_SWEEP_MS_ENV] = '54321';
    const spy = jest.spyOn(global, 'setInterval');
    try {
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 54321);
      expect((svc as unknown as { timer: unknown }).timer).not.toBeNull();
    } finally {
      spy.mockRestore();
      svc.onModuleDestroy();
    }
    expect((svc as unknown as { timer: unknown }).timer).toBeNull();
  });

  // ── Gardes de sweep : prérequis + lease (Q6) ──────────────────────────────

  it('Q6 : prérequis de schéma absents → AUCUNE mutation (zéro passe, zéro lease)', async () => {
    prisma.$queryRaw.mockImplementation(async () => []);

    const res = await svc.sweep();

    expect(res).toEqual({ expired: 0, relaunched: 0 });
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(provisioning.provisionOrder).not.toHaveBeenCalled();
    expect(prisma.sweepLease.updateMany).not.toHaveBeenCalled();
    expect(prisma.sweepLease.create).not.toHaveBeenCalled();
  });

  it('Q6 : lease tenu par un AUTRE processus → passage refusé (aucune passe)', async () => {
    prisma.sweepLease.findUnique.mockResolvedValueOnce({
      name: 'order-lifecycle',
      holder: 'process-autre',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await svc.sweep();

    expect(res).toEqual({ expired: 0, relaunched: 0 });
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(provisioning.provisionOrder).not.toHaveBeenCalled();
    // Le perdant ne libère PAS le lease d'un autre porteur (steal seul).
    expect(prisma.sweepLease.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.sweepLease.updateMany).not.toHaveBeenCalledWith({
      where: expect.objectContaining({ holder: expect.any(String) }),
      data: expect.anything(),
    });
  });

  it('Q6 : lease acquis → passes exécutées puis lease LIBÉRÉ en fin (finally)', async () => {
    txWithCas(1);
    prisma.order.findMany
      .mockResolvedValueOnce([staleOrder]) // expiration
      .mockResolvedValueOnce([]); // relance

    const res = await svc.sweep();

    expect(res).toEqual({ expired: 1, relaunched: 0 });
    expect(prisma.sweepLease.updateMany).toHaveBeenCalledWith({
      where: { name: 'order-lifecycle', holder: expect.any(String) },
      data: { expiresAt: new Date(0) },
    });
  });

  it('Q6 : échec d’une passe → lease LIBÉRÉ, running réinitialisé, sweep suivant possible', async () => {
    prisma.order.findMany.mockRejectedValueOnce(new Error('db down'));

    await expect(svc.sweep()).rejects.toThrow('db down');
    expect(prisma.sweepLease.updateMany).toHaveBeenCalledWith({
      where: { name: 'order-lifecycle', holder: expect.any(String) },
      data: { expiresAt: new Date(0) },
    });

    // running est retombé : le passage suivant repasse les gardes normalement.
    prisma.order.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(svc.sweep()).resolves.toEqual({ expired: 0, relaunched: 0 });
  });

  it('Q6 : anti-chevauchement local (même processus) → 2e sweep en vol = zéros', async () => {
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
    expect(second).toEqual({ expired: 0, relaunched: 0 });
    release();
    await first;
  });

  // ── Expiration : CAS + audit honnête ──────────────────────────────────────

  it('expiration CAS gagnée → facture + historique + UN audit `order.expired`', async () => {
    const tx = txWithCas(1);
    prisma.order.findMany
      .mockResolvedValueOnce([staleOrder])
      .mockResolvedValueOnce([]);

    const res = await svc.sweep();

    expect(res.expired).toBe(1);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-stale', status: OrderStatus.PENDING_PAYMENT },
      data: { status: OrderStatus.CANCELLED },
    });
    expect(tx.invoice.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'ord-stale', status: InvoiceStatus.UNPAID },
      data: { status: InvoiceStatus.CANCELLED },
    });
    expect(tx.orderStatusHistory.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'order.expired', resourceId: 'ord-stale' }),
    );
  });

  it('Q6 : expiration CAS PERDUE (concours multi-processus) → AUCUN audit, compteur à 0', async () => {
    // Un autre processus a basculé la commande entre notre lecture et notre CAS.
    const tx = txWithCas(0);
    prisma.order.findMany
      .mockResolvedValueOnce([staleOrder])
      .mockResolvedValueOnce([]);

    const res = await svc.sweep();

    expect(res.expired).toBe(0);
    // Ni facture, ni historique, ni audit : cette process n'a RIEN changé.
    expect(tx.invoice.updateMany).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'order.expired' }),
    );
  });

  // ── Relance du provisioning ───────────────────────────────────────────────

  it('PAID figée > 2 min → relance provisionOrder + audit', async () => {
    prisma.order.findMany
      .mockResolvedValueOnce([]) // expiration
      .mockResolvedValueOnce([{ id: 'ord-paid' }]); // relance

    const res = await svc.sweep();

    expect(res.relaunched).toBe(1);
    expect(provisioning.provisionOrder).toHaveBeenCalledWith('ord-paid');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'order.relaunch_provisioning', resourceId: 'ord-paid' }),
    );
  });

  it('échec de la relance → audit `provision.launch_failed` visible (jamais de faux succès)', async () => {
    prisma.order.findMany
      .mockResolvedValueOnce([]) // expiration
      .mockResolvedValueOnce([{ id: 'ord-paid' }]); // relance
    provisioning.provisionOrder.mockRejectedValueOnce(new Error('panel down'));

    const res = await svc.sweep();

    expect(res.relaunched).toBe(0);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'provision.launch_failed',
        details: expect.objectContaining({ via: 'order-lifecycle-sweep' }),
      }),
    );
  });
});
