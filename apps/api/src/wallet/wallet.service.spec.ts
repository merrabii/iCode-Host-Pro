import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WalletService } from './wallet.service';

// GO P6 (lot C2) — invariants du service wallet testés SANS réseau/PG réel :
// verrou + garde anti-négatif, idempotence (P2002 → replay neutre), CAS
// PENDING→SUCCEEDED (crédit exactement une fois), contrôle propriétaire.
// Les appels `$transaction(fn)` exécutent le callback sur un tx mocké.

type Row = Record<string, unknown>;

const p2002 = (): never => {
  throw new Prisma.PrismaClientKnownRequestError('Unique constraint', {
    code: 'P2002',
    clientVersion: 'test',
  });
};

describe('WalletService — C2 (crédit/débit atomiques, idempotence, anti-négatif)', () => {
  let service: WalletService;
  let tx: {
    $queryRaw: jest.Mock;
    walletTransaction: { create: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock };
    customer: { update: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    customer: { findUnique: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
    user: { findUnique: jest.Mock };
    walletTransaction: { findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock };
  };
  let lockRows: { walletBalanceCents: number }[];

  beforeEach(() => {
    lockRows = [{ walletBalanceCents: 0 }];
    tx = {
      $queryRaw: jest.fn(() => lockRows),
      walletTransaction: {
        create: jest.fn((args: { data: Row }) => ({ id: 'tx1', ...args.data })),
        findUnique: jest.fn(),
        updateMany: jest.fn(() => ({ count: 1 })),
      },
      customer: {
        update: jest.fn((_args: unknown) => ({
          walletBalanceCents: Number(lockRows[0]?.walletBalanceCents ?? 0),
        })),
      },
    };
    prisma = {
      $transaction: jest.fn(async (fn: unknown) => {
        if (typeof fn === 'function') return (fn as (t: typeof tx) => unknown)(tx);
        throw new Error('batch transaction non attendue');
      }),
      customer: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
      user: { findUnique: jest.fn() },
      walletTransaction: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    };
    service = new WalletService(prisma as never);
  });

  it('credit : verrou + création SUCCEEDED + incrément (balance retournée)', async () => {
    lockRows = [{ walletBalanceCents: 500 }];
    tx.customer.update.mockImplementation(() => ({ walletBalanceCents: 1300 }));
    const res = await service.credit('cust1', { amountCents: 800, idempotencyKey: 'k1' });
    expect(res).toEqual({ balanceCents: 1300, replayed: false });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerId: 'cust1',
          amountCents: 800,
          idempotencyKey: 'k1',
          status: 'SUCCEEDED',
        }),
      }),
    );
    expect(tx.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { walletBalanceCents: { increment: 800 } },
      }),
    );
  });

  it('debit suffisant : décrément + ligne DEBIT', async () => {
    lockRows = [{ walletBalanceCents: 1000 }];
    tx.customer.update.mockImplementation(() => ({ walletBalanceCents: 700 }));
    const res = await service.debit('cust1', { amountCents: 300, idempotencyKey: 'k2' });
    expect(res.balanceCents).toBe(700);
    expect(tx.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { walletBalanceCents: { decrement: 300 } },
      }),
    );
  });

  it('debit insuffisant → 409, AUCUNE écriture (solde jamais négatif)', async () => {
    lockRows = [{ walletBalanceCents: 100 }];
    await expect(
      service.debit('cust1', { amountCents: 300, idempotencyKey: 'k3' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(tx.customer.update).not.toHaveBeenCalled();
  });

  it('rejeu P2002 (même clé, même client) → replay neutre, pas de 2e écriture', async () => {
    lockRows = [{ walletBalanceCents: 1000 }];
    prisma.walletTransaction.findUnique.mockResolvedValue({ customerId: 'cust1' });
    prisma.customer.findUnique.mockResolvedValue({ walletBalanceCents: 700 });
    tx.walletTransaction.create.mockImplementation(p2002);
    const res = await service.debit('cust1', { amountCents: 300, idempotencyKey: 'k2' });
    expect(res).toEqual({ balanceCents: 700, replayed: true });
    expect(tx.customer.update).not.toHaveBeenCalled();
  });

  it('P2002 d’un AUTRE client → 409 (jamais de « replay » volé)', async () => {
    prisma.walletTransaction.findUnique.mockResolvedValue({ customerId: 'autre' });
    tx.walletTransaction.create.mockImplementation(p2002);
    await expect(
      service.credit('cust1', { amountCents: 100, idempotencyKey: 'k-x' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('montants invalides (0, négatif, décimal) → 400, jamais écrit', async () => {
    for (const amountCents of [0, -5, 12.5]) {
      await expect(
        service.credit('cust1', { amountCents, idempotencyKey: `k-${amountCents}` }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(tx.customer.update).not.toHaveBeenCalled();
  });

  it('dossier inconnu (verrou vide) → 404', async () => {
    lockRows = [];
    await expect(
      service.credit('ghost', { amountCents: 100, idempotencyKey: 'k4' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('concurrence : 5 débits de 400 sur 1000 → 2 OK / 3 refus, final 200, jamais négatif', async () => {
    let balance = 1000;
    let creates = 0;
    // File d'attente : les callbacks $transaction s'exécutent UNE À UNE comme
    // sous verrou PostgreSQL — chaque débit relit le solde courant à son tour.
    let chain: Promise<unknown> = Promise.resolve();
    prisma.$transaction.mockImplementation((fn: unknown) => {
      const run = chain.then(() => (fn as (t: typeof tx) => unknown)(tx));
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    });
    tx.$queryRaw.mockImplementation(() => [{ walletBalanceCents: balance }]);
    tx.customer.update.mockImplementation(() => {
      balance -= 400;
      creates += 1;
      return { walletBalanceCents: balance };
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        service.debit('cust1', { amountCents: 400, idempotencyKey: `race-${i}` }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const ko = results.filter((r) => r.status === 'rejected');
    expect(ok.length).toBe(2);
    expect(ko.length).toBe(3);
    for (const r of ko) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    }
    expect(creates).toBe(2);
    expect(balance).toBe(200);
    expect(balance).toBeGreaterThanOrEqual(0);
  });
});

describe('WalletService — C3a (recharge virement : PENDING puis validation unique)', () => {
  let service: WalletService;
  let tx: {
    $queryRaw: jest.Mock;
    walletTransaction: { findUnique: jest.Mock; updateMany: jest.Mock; create: jest.Mock };
    customer: { update: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    customer: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
    user: { findUnique: jest.Mock };
    walletTransaction: { findUnique: jest.Mock; updateMany: jest.Mock; create: jest.Mock };
  };

  const admin = { sub: 'adm1', email: 'admin@example.com' };

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn(() => [{ walletBalanceCents: 100 }]),
      walletTransaction: {
        findUnique: jest.fn(),
        updateMany: jest.fn(() => ({ count: 1 })),
        create: jest.fn(),
      },
      customer: { update: jest.fn(() => ({ walletBalanceCents: 3400 })) },
    };
    prisma = {
      $transaction: jest.fn(async (fn: unknown) =>
        typeof fn === 'function' ? (fn as (t: typeof tx) => unknown)(tx) : null,
      ),
      customer: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
      user: { findUnique: jest.fn() },
      walletTransaction: { findUnique: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    };
    service = new WalletService(prisma as never);
  });

  it('createRecharge : PENDING, référence RCH unique, AUCUN effet solde', async () => {
    prisma.walletTransaction.create.mockImplementation((args: { data: Row }) => ({
      id: 'rc1',
      createdAt: new Date('2026-10-03'),
      ...args.data,
    }));
    const out = await service.createRecharge('cust1', {
      amountCents: 2500,
      note: '  virement oct  ',
      proof: { fileName: 'p.pdf', path: 'p.pdf', mime: 'application/pdf' },
    });
    expect(out.status).toBe('PENDING');
    expect(out.reference).toMatch(/^RCH-[0-9A-F]{10}$/);
    expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING',
          amountCents: 2500,
          note: 'virement oct',
          proofPath: 'p.pdf',
          type: 'CREDIT',
        }),
      }),
    );
    // Aucun customer.update : le solde ne bouge qu'à la validation.
    expect(prisma.customer.update).not.toHaveBeenCalled();
    expect(tx.customer.update).not.toHaveBeenCalled();
  });

  it('createRecharge : bornes de montant (50 → 400, 10 000 001 → 400)', async () => {
    await expect(
      service.createRecharge('cust1', { amountCents: 50 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createRecharge('cust1', { amountCents: 10_000_001 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('validateRecharge : CAS PENDING→SUCCEEDED + incrément exact, balance retournée', async () => {
    tx.walletTransaction.findUnique.mockResolvedValue({
      id: 'rc1',
      customerId: 'cust1',
      type: 'CREDIT',
      amountCents: 2500,
    });
    const res = await service.validateRecharge('rc1', admin);
    expect(res.balanceCents).toBe(3400);
    expect(tx.walletTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rc1', status: 'PENDING' },
        data: expect.objectContaining({ status: 'SUCCEEDED', adminActorEmail: admin.email }),
      }),
    );
    expect(tx.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { walletBalanceCents: { increment: 2500 } },
      }),
    );
  });

  it('validateRecharge : CAS raté (déjà traitée) → 409, AUCUN incrément', async () => {
    tx.walletTransaction.findUnique.mockResolvedValue({
      id: 'rc1',
      customerId: 'cust1',
      type: 'CREDIT',
      amountCents: 2500,
    });
    tx.walletTransaction.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.validateRecharge('rc1', admin)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.customer.update).not.toHaveBeenCalled();
  });

  it('validateRecharge : recharge introuvable → 404 ; type inattendu → 409', async () => {
    tx.walletTransaction.findUnique.mockResolvedValue(null);
    await expect(service.validateRecharge('nope', admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    tx.walletTransaction.findUnique.mockResolvedValue({
      id: 'rc2',
      customerId: 'cust1',
      type: 'DEBIT',
      amountCents: 10,
    });
    await expect(service.validateRecharge('rc2', admin)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.customer.update).not.toHaveBeenCalled();
  });

  it('rejectRecharge : CAS PENDING→CANCELED, motif appendé, 0 crédit', async () => {
    prisma.walletTransaction.findUnique.mockResolvedValue({
      id: 'rc1',
      status: 'PENDING',
      note: 'virement oct',
    });
    prisma.walletTransaction.updateMany.mockResolvedValue({ count: 1 });
    await service.rejectRecharge('rc1', admin, 'preuve illisible');
    expect(prisma.walletTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rc1', status: 'PENDING' },
        data: expect.objectContaining({
          status: 'CANCELED',
          adminActorEmail: admin.email,
          note: 'virement oct · REJET : preuve illisible',
        }),
      }),
    );
    expect(tx.customer.update).not.toHaveBeenCalled();
  });

  it('rejectRecharge : déjà traitée → 409 ; introuvable → 404', async () => {
    prisma.walletTransaction.findUnique.mockResolvedValue({
      id: 'rc1',
      status: 'PENDING',
      note: null,
    });
    prisma.walletTransaction.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.rejectRecharge('rc1', admin, null)).rejects.toBeInstanceOf(
      ConflictException,
    );
    prisma.walletTransaction.findUnique.mockResolvedValue(null);
    await expect(service.rejectRecharge('nope', admin, null)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('WalletService — contrôle propriétaire (ensureOwnedCustomer)', () => {
  let service: WalletService;
  let prisma: {
    customer: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
    user: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  const user = { sub: 'u1', email: 'alice@example.com', role: 'USER' } as never;

  beforeEach(() => {
    prisma = {
      customer: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    service = new WalletService(prisma as never);
  });

  it('dossier lié au compte → utilisé tel quel', async () => {
    prisma.customer.findUnique.mockResolvedValueOnce({
      id: 'c1',
      email: 'alice@example.com',
      walletBalanceCents: 42,
    });
    const out = await service.ensureOwnedCustomer(user);
    expect(out.id).toBe('c1');
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });

  it('dossier invité au même email → lié au compte (repli P4)', async () => {
    prisma.customer.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c2', email: 'alice@example.com', userId: null });
    prisma.customer.update.mockResolvedValue({
      id: 'c2',
      email: 'alice@example.com',
      walletBalanceCents: 0,
    });
    const out = await service.ensureOwnedCustomer(user);
    expect(out.id).toBe('c2');
    expect(prisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: 'u1' } }),
    );
  });

  it('dossier d’un AUTRE compte → conflit (jamais de vol de solde)', async () => {
    prisma.customer.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c3', email: 'alice@example.com', userId: 'u2' });
    await expect(service.ensureOwnedCustomer(user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });

  it('aucun dossier → création lié au compte', async () => {
    prisma.customer.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    prisma.user.findUnique.mockResolvedValue({ name: 'Alice' });
    prisma.customer.create.mockResolvedValue({
      id: 'c4',
      email: 'alice@example.com',
      walletBalanceCents: 0,
    });
    const out = await service.ensureOwnedCustomer(user);
    expect(out.id).toBe('c4');
    expect(prisma.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'u1', name: 'Alice' }),
      }),
    );
  });
});
