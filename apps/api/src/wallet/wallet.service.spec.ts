import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
    // Q-A (item 2) : le rejeu n'est accepté que si l'IDENTITÉ complète est la
    // même (sens, montant, devise, statut abouti, liens commande/facture).
    prisma.walletTransaction.findUnique.mockResolvedValue({
      customerId: 'cust1',
      type: 'DEBIT',
      amountCents: 300,
      currency: 'USD',
      status: 'SUCCEEDED',
      orderId: null,
      invoiceId: null,
      reference: null,
    });
    prisma.customer.findUnique.mockResolvedValue({ walletBalanceCents: 700 });
    tx.walletTransaction.create.mockImplementation(p2002);
    const res = await service.debit('cust1', { amountCents: 300, idempotencyKey: 'k2' });
    expect(res).toEqual({ balanceCents: 700, replayed: true });
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(tx.customer.update).not.toHaveBeenCalled();
  });

  it('P2002 d’un AUTRE client → 409 (jamais de « replay » volé)', async () => {
    prisma.walletTransaction.findUnique.mockResolvedValue({ customerId: 'autre' });
    tx.walletTransaction.create.mockImplementation(p2002);
    await expect(
      service.credit('cust1', { amountCents: 100, idempotencyKey: 'k-x' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('Q-A : même clé mais identité DIFFÉRENTE (montant) → 409, aucune écriture', async () => {
    prisma.walletTransaction.findUnique.mockResolvedValue({
      customerId: 'cust1',
      type: 'DEBIT',
      amountCents: 999, // ≠ 300 demandé → ce n'est PAS un rejeu
      currency: 'USD',
      status: 'SUCCEEDED',
      orderId: null,
      invoiceId: null,
      reference: null,
    });
    await expect(
      service.debit('cust1', { amountCents: 300, idempotencyKey: 'k2' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(tx.customer.update).not.toHaveBeenCalled();
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
      currency: 'USD',
    });
    const res = await service.validateRecharge('rc1', admin, 'BANK-RAP-001');
    expect(res.balanceCents).toBe(3400);
    expect(res.bankRef).toBe('BANK-RAP-001');
    expect(res.amountCents).toBe(2500);
    expect(res.currency).toBe('USD');
    expect(tx.walletTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rc1', status: 'PENDING' },
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          adminActorEmail: admin.email,
          bankRef: 'BANK-RAP-001',
        }),
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
    await expect(
      service.validateRecharge('rc1', admin, 'BANK-RAP-001'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.customer.update).not.toHaveBeenCalled();
  });

  it('validateRecharge : recharge introuvable → 404 ; type inattendu → 409', async () => {
    tx.walletTransaction.findUnique.mockResolvedValue(null);
    await expect(
      service.validateRecharge('nope', admin, 'BANK-RAP-001'),
    ).rejects.toBeInstanceOf(NotFoundException);
    tx.walletTransaction.findUnique.mockResolvedValue({
      id: 'rc2',
      customerId: 'cust1',
      type: 'DEBIT',
      amountCents: 10,
    });
    await expect(
      service.validateRecharge('rc2', admin, 'BANK-RAP-001'),
    ).rejects.toBeInstanceOf(ConflictException);
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

describe('WalletService — contrôle propriétaire (ensureOwnedCustomer, GO Q3)', () => {
  let service: WalletService;
  let prisma: {
    customer: {
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
    };
    user: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  const user = { sub: 'u1', email: 'alice@example.com', role: 'USER' } as never;
  // Identité actuelle lue en DB par le service (jamais le seul claim du JWT).
  const identity = { email: 'alice@example.com', isActive: true, name: 'Alice' };

  beforeEach(() => {
    prisma = {
      customer: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    service = new WalletService(prisma as never);
  });

  it('dossier lié au compte → utilisé tel quel (identité revérifiée en DB)', async () => {
    prisma.user.findUnique.mockResolvedValue(identity);
    prisma.customer.findUnique.mockResolvedValueOnce({
      id: 'c1',
      email: 'alice@example.com',
      walletBalanceCents: 42,
    });
    const out = await service.ensureOwnedCustomer(user);
    expect(out.id).toBe('c1');
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });

  it('dossier invité au même email → rattachement CAS (updateMany userId:null)', async () => {
    prisma.customer.findUnique
      .mockResolvedValueOnce(null) // pas encore lié (userId)
      .mockResolvedValueOnce({ id: 'c2', email: 'alice@example.com', userId: null, walletBalanceCents: 0 });
    prisma.user.findUnique.mockResolvedValue(identity);
    prisma.customer.updateMany.mockResolvedValue({ count: 1 });

    const out = await service.ensureOwnedCustomer(user);
    expect(out.id).toBe('c2');
    // CAS : seul un dossier TOUJOURS non rattaché peut être pris.
    expect(prisma.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 'c2', userId: null },
      data: { userId: 'u1' },
    });
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it('dossier d’un AUTRE compte → conflit (jamais de vol de solde)', async () => {
    prisma.customer.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c3', email: 'alice@example.com', userId: 'u2' });
    prisma.user.findUnique.mockResolvedValue(identity);
    await expect(service.ensureOwnedCustomer(user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.customer.updateMany).not.toHaveBeenCalled();
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });

  it('aucun dossier → création lié au compte (email de la DB, pas du JWT)', async () => {
    prisma.customer.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    prisma.user.findUnique.mockResolvedValue(identity);
    prisma.customer.create.mockResolvedValue({
      id: 'c4',
      email: 'alice@example.com',
      walletBalanceCents: 0,
    });
    const out = await service.ensureOwnedCustomer(user);
    expect(out.id).toBe('c4');
    expect(prisma.customer.findUnique).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { email: 'alice@example.com' } }),
    );
    expect(prisma.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'u1', name: 'Alice', email: 'alice@example.com' }),
      }),
    );
  });

  it('JWT périmé : l’email de la DB fait foi pour retrouver le dossier invité', async () => {
    const staleJwt = { sub: 'u1', email: 'ancien@exemple.com', role: 'USER' } as never;
    prisma.customer.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c5', email: 'alice@example.com', userId: null, walletBalanceCents: 0 });
    prisma.user.findUnique.mockResolvedValue(identity); // email actuel ≠ claim JWT
    prisma.customer.updateMany.mockResolvedValue({ count: 1 });

    await service.ensureOwnedCustomer(staleJwt);
    expect(prisma.customer.findUnique).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { email: 'alice@example.com' } }),
    );
    expect(prisma.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 'c5', userId: null },
      data: { userId: 'u1' },
    });
  });

  it('compte désactivé → 401, identité refusée AVANT tout accès au dossier', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...identity, isActive: false });
    await expect(service.ensureOwnedCustomer(user)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });

  it('CAS perdu (rattachement pris entre-temps) → relecture, pas d’erreur', async () => {
    prisma.customer.findUnique
      .mockResolvedValueOnce(null) // tour 1 : pas encore lié
      .mockResolvedValueOnce({ id: 'c6', email: 'alice@example.com', userId: null, walletBalanceCents: 0 })
      .mockResolvedValueOnce({ id: 'c6', email: 'alice@example.com', userId: 'u1', walletBalanceCents: 0 }); // tour 2
    prisma.user.findUnique.mockResolvedValue(identity);
    prisma.customer.updateMany.mockResolvedValue({ count: 0 }); // perdu

    const out = await service.ensureOwnedCustomer(user);
    expect(out.id).toBe('c6');
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });

  it('course à la création (P2002) → nouvelle tentative, pas de 500', async () => {
    prisma.customer.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    prisma.user.findUnique.mockResolvedValue(identity);
    prisma.customer.create
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockResolvedValue({ id: 'c7', email: 'alice@example.com', walletBalanceCents: 0 });

    const out = await service.ensureOwnedCustomer(user);
    expect(out.id).toBe('c7');
    expect(prisma.customer.create).toHaveBeenCalledTimes(2);
  });
});

describe('WalletService — Q8 (preuves réelles & encaissement unique)', () => {
  let service: WalletService;
  let tx: {
    $queryRaw: jest.Mock;
    walletTransaction: { findUnique: jest.Mock; updateMany: jest.Mock };
    customer: { update: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    walletTransaction: { findUnique: jest.Mock; updateMany: jest.Mock };
  };

  const admin = { sub: 'adm1', email: 'admin@example.com' };

  const p2002BankRef = (): never => {
    throw new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['bankRef'] },
    });
  };

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn(() => [{ walletBalanceCents: 100 }]),
      walletTransaction: {
        findUnique: jest.fn(() => ({
          id: 'rc1',
          customerId: 'cust1',
          type: 'CREDIT',
          amountCents: 2500,
          currency: 'USD',
        })),
        updateMany: jest.fn(() => ({ count: 1 })),
      },
      customer: { update: jest.fn(() => ({ walletBalanceCents: 3400 })) },
    };
    prisma = {
      $transaction: jest.fn(async (fn: unknown) =>
        typeof fn === 'function' ? (fn as (t: typeof tx) => unknown)(tx) : null,
      ),
      walletTransaction: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    service = new WalletService(prisma as never);
  });

  it('validateRecharge : bankRef obligatoire (3..64, trim) — 400 sans écriture', async () => {
    for (const bad of ['', '  ', 'ab', undefined as unknown as string]) {
      await expect(service.validateRecharge('rc1', admin, bad)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(tx.walletTransaction.updateMany).not.toHaveBeenCalled();
    expect(tx.customer.update).not.toHaveBeenCalled();
  });

  it('validateRecharge : même encaissement bancaire déjà constaté (P2002 bankRef) → 409 clair, 0 crédit', async () => {
    tx.walletTransaction.updateMany.mockImplementation(p2002BankRef);
    await expect(
      service.validateRecharge('rc1', admin, '  VIR-2026-77  '),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('VIR-2026-77') });
    // La transaction est avorcée par l'unicité PG : aucun incrément résiduel.
    expect(tx.customer.update).not.toHaveBeenCalled();
  });

  // ── Contenu RÉEL des justificatifs (magic bytes, pas le MIME déclaré) ─────
  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-marker')]);
  const WEBP_BYTES = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WEBPVP8 '),
  ]);
  const PDF_BYTES = Buffer.from('%PDF-1.4 contenu de justificatif');

  it('persistProof : signatures valides acceptées — fichier écrit dans storage/ (jamais public/)', () => {
    const cases: [Buffer, string, string][] = [
      [PNG_1PX, 'image/png', '.png'],
      [JPEG_BYTES, 'image/jpeg', '.jpg'],
      [WEBP_BYTES, 'image/webp', '.webp'],
      [PDF_BYTES, 'application/pdf', '.pdf'],
    ];
    const written: string[] = [];
    try {
      for (const [buf, mime, ext] of cases) {
        const out = service.persistProof({
          originalname: `f${ext}`,
          mimetype: mime,
          buffer: buf,
        });
        written.push(out.path);
        expect(out.mime).toBe(mime);
        expect(out.fileName.endsWith(ext)).toBe(true);
        const abs = path.resolve(process.cwd(), 'storage', 'wallet-proofs', out.fileName);
        expect(fs.existsSync(abs)).toBe(true);
        expect(fs.existsSync(path.resolve(process.cwd(), 'public', 'wallet-proofs', out.fileName))).toBe(
          false,
        );
      }
    } finally {
      for (const p of written) service.removeProof(p);
    }
  });

  it('persistProof : MIME déclaré mensonger → 400 (le contenu fait foi)', () => {
    const dir = path.resolve(process.cwd(), 'storage', 'wallet-proofs');
    const count = () => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
    const before = count();
    // Contenu PNG déclaré « image/jpeg ».
    expect(() =>
      service.persistProof({ originalname: 'p.jpg', mimetype: 'image/jpeg', buffer: PNG_1PX }),
    ).toThrow(BadRequestException);
    // Signature totalement inconnue déclarée image/png.
    expect(() =>
      service.persistProof({ originalname: 'p.png', mimetype: 'image/png', buffer: Buffer.from('GIF89a-ou-bidon') }),
    ).toThrow(BadRequestException);
    // Buffer absent.
    expect(() =>
      service.persistProof({ originalname: 'p.png', mimetype: 'image/png' }),
    ).toThrow(BadRequestException);
    expect(count()).toBe(before); // aucun fichier écrit sur refus
  });
});
