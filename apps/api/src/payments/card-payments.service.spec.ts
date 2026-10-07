import { BadRequestException, ConflictException } from '@nestjs/common';
import { CardPayment, CardPaymentStatus, WalletTransactionType } from '@prisma/client';
import { JwtPayload } from '../auth/types';
import { CardPaymentsService, assertPaymentIdempotencyKey } from './card-payments.service';

// GO Stripe — unitaires SANS réseau/PG : le SERVEUR est autorité (montant,
// devise, crédit unique), jamais le navigateur.
type Row = Record<string, unknown>;

const user: JwtPayload = {
  sub: 'user-1',
  email: 'client@code.test',
  role: 'CLIENT' as JwtPayload['role'],
};

const basePayment = (over: Row = {}): CardPayment =>
  ({
    id: 'cp1',
    reference: 'CDP-AAAA11BB',
    customerId: 'cust1',
    kind: 'TOPUP',
    status: CardPaymentStatus.CREATED,
    amountCents: 5000,
    currency: 'USD',
    providerCode: 'simulated',
    environment: 'test',
    merchantAccount: 'sim_merchant_local',
    livemode: false,
    providerSessionRef: 'cs_sim_1',
    providerPaymentRef: 'pi_sim_1',
    checkoutUrl: '/api/payments/simulated/sessions/cs_sim_1',
    idempotencyKey: 'idem-key-123456',
    walletTransactionId: null,
    refundedCents: 0,
    failureCode: null,
    failureMessage: null,
    disputedAt: null,
    interventionNeeded: false,
    interventionReason: null,
    expiresAt: null,
    paidAt: null,
    createdAt: new Date('2026-10-07T00:00:00Z'),
    updatedAt: new Date('2026-10-07T00:00:00Z'),
    ...over,
  }) as CardPayment;

describe('CardPaymentsService (GO Stripe — recharge carte)', () => {
  let tx: {
    $queryRaw: jest.Mock;
    cardPayment: { updateMany: jest.Mock; update: jest.Mock };
    customer: { findUnique: jest.Mock };
    walletTransaction: { findUnique: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    cardPayment: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let wallet: { ensureOwnedCustomer: jest.Mock; applyWithClient: jest.Mock };
  let connector: {
    createCheckoutSession: jest.Mock;
    retrieveSession: jest.Mock;
    createRefund: jest.Mock;
  };
  let provider: { resolve: jest.Mock; resolveFor: jest.Mock };
  let audit: { record: jest.Mock };
  let service: CardPaymentsService;
  let lockRow: CardPayment;

  beforeEach(() => {
    lockRow = basePayment();
    tx = {
      $queryRaw: jest.fn(() => [lockRow]),
      cardPayment: {
        updateMany: jest.fn(() => ({ count: 1 })),
        update: jest.fn((args: { where?: Row; data: Row }) => ({
          ...lockRow,
          ...args.data,
        })),
      },
      customer: {
        findUnique: jest.fn(() => ({ walletCurrency: 'USD' })),
      },
      walletTransaction: { findUnique: jest.fn(() => ({ id: 'wtx1' })) },
    };
    prisma = {
      $transaction: jest.fn(async (fn: unknown) =>
        typeof fn === 'function' ? (fn as (t: typeof tx) => unknown)(tx) : null,
      ),
      cardPayment: {
        create: jest.fn(async (a: { data: Row }) => basePayment({ ...a.data })),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(async (args: { where?: Row; data: Row }) => ({
          ...lockRow,
          ...args.data,
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
        findMany: jest.fn(async () => []),
      },
    };
    wallet = {
      ensureOwnedCustomer: jest.fn(async () => ({
        id: 'cust1',
        email: 'client@code.test',
        walletBalanceCents: 0,
        walletCurrency: 'USD',
      })),
      applyWithClient: jest.fn(async () => ({ balanceCents: 5000, replayed: false })),
    };
    connector = {
      createCheckoutSession: jest.fn(async () => ({
        sessionRef: 'cs_sim_2',
        paymentRef: 'pi_sim_2',
        checkoutUrl: '/api/payments/simulated/sessions/cs_sim_2',
        livemode: false,
        expiresAt: new Date('2026-10-07T00:30:00Z'),
      })),
      retrieveSession: jest.fn(),
      createRefund: jest.fn(),
    };
    provider = {
      resolve: jest.fn(async () => ({
        settingId: 'set1',
        code: 'simulated',
        displayName: 'Simulateur local',
        environment: 'test',
        merchantAccount: 'sim_merchant_local',
        currencies: ['USD', 'EUR'],
        connector,
      })),
      // GO P4 — reprise SOUS l'identité d'origine de la ligne.
      resolveFor: jest.fn(async () => ({
        settingId: 'set1',
        code: 'simulated',
        displayName: 'Simulateur local',
        environment: 'test',
        merchantAccount: 'sim_merchant_local',
        currencies: ['USD', 'EUR'],
        connector,
      })),
    };
    audit = { record: jest.fn(async () => undefined) };
    service = new CardPaymentsService(
      prisma as never,
      wallet as never,
      provider as never,
      audit as never,
      { get: jest.fn(() => 'http://localhost:3011') } as never,
    );
  });

  // ── clé d'idempotence ──────────────────────────────────────────────────
  it('impose une clé d’idempotence valide (sinon 400) et en génère une sinon', () => {
    expect(assertPaymentIdempotencyKey('abcdefghijklmnop')).toBe('abcdefghijklmnop');
    expect(() => assertPaymentIdempotencyKey('court')).toThrow(BadRequestException);
    expect(() => assertPaymentIdempotencyKey('avec espace dedans')).toThrow(
      BadRequestException,
    );
    expect(assertPaymentIdempotencyKey(undefined)).toMatch(/^topup:[0-9a-f]{32}$/);
  });

  // ── création ───────────────────────────────────────────────────────────
  it('ouvre une session, renvoie l’URL et masque l’identité prestataire côté client', async () => {
    prisma.cardPayment.findUnique.mockResolvedValue(null);
    const view = await service.createTopup(user, {
      amountCents: 5000,
      idempotencyKey: 'idem-key-123456',
    });
    expect(connector.createCheckoutSession).toHaveBeenCalledTimes(1);
    const arg = connector.createCheckoutSession.mock.calls[0][0];
    const createdRef = (
      prisma.cardPayment.create.mock.calls[0][0] as { data: { reference: string } }
    ).data.reference;
    expect(arg).toMatchObject({
      amountCents: 5000,
      currency: 'usd', // ISO minuscules pour le prestataire
      customerEmail: 'client@code.test',
      reference: createdRef,
    });
    expect(arg.successUrl).toContain(`ref=${createdRef}`);
    expect(view.checkoutUrl).toBe('/api/payments/simulated/sessions/cs_sim_2');
    // Aucune identité prestataire exposée au client (GO §4).
    expect(view).not.toHaveProperty('providerCode');
    expect(view).not.toHaveProperty('merchantAccount');
    expect(view).not.toHaveProperty('providerSessionRef');
  });

  it('refuse une recharge dans une autre devise que le portefeuille (pas de change)', async () => {
    await expect(
      service.createTopup(user, { amountCents: 5000, currency: 'EUR' }),
    ).rejects.toThrow(ConflictException);
    expect(connector.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('refuse un montant hors bornes (1,00 → 100 000,00)', async () => {
    await expect(service.createTopup(user, { amountCents: 99 })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.createTopup(user, { amountCents: 10_000_001 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejoue la MÊME session pour une clé d’idempotence identique (aucun second appel)', async () => {
    prisma.cardPayment.findUnique.mockResolvedValue(
      basePayment({ checkoutUrl: '/deja-ouverte' }),
    );
    const view = await service.createTopup(user, {
      amountCents: 5000,
      idempotencyKey: 'idem-key-123456',
    });
    expect(view.checkoutUrl).toBe('/deja-ouverte');
    expect(connector.createCheckoutSession).not.toHaveBeenCalled();
    expect(prisma.cardPayment.create).not.toHaveBeenCalled();
  });

  it('refuse une clé d’idempotence réutilisée pour un autre montant', async () => {
    prisma.cardPayment.findUnique.mockResolvedValue(
      basePayment({ amountCents: 7000 }),
    );
    await expect(
      service.createTopup(user, { amountCents: 5000, idempotencyKey: 'idem-key-123456' }),
    ).rejects.toThrow(ConflictException);
  });

  it('marque FAILED (aucun crédit) si le prestataire refuse l’ouverture', async () => {
    prisma.cardPayment.findUnique.mockResolvedValue(null);
    connector.createCheckoutSession.mockRejectedValue(
      Object.assign(new Error('clé secrète invalide'), { name: 'StripeHttpError' }),
    );
    await expect(
      service.createTopup(user, { amountCents: 5000, idempotencyKey: 'idem-key-123456' }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.cardPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: CardPaymentStatus.FAILED }),
      }),
    );
  });

  // ── confirmation (webhook / relecture serveur) ─────────────────────────
  it('confirme UN SEUL crédit, puis « déjà crédité » sur tout rejeu', async () => {
    lockRow = basePayment();
    const first = await service.confirmPaid({
      sessionRef: 'cs_sim_1',
      paymentRef: 'pi_sim_1',
      amountTotalCents: 5000,
      currency: 'usd',
      livemode: false,
      source: 'webhook',
      providerCode: 'simulated',
    });
    expect(first).toEqual({ outcome: 'credited', reference: 'CDP-AAAA11BB', balanceCents: 5000 });
    expect(wallet.applyWithClient).toHaveBeenCalledTimes(1);
    expect(wallet.applyWithClient).toHaveBeenCalledWith(
      expect.anything(),
      'cust1',
      expect.objectContaining({
        amountCents: 5000,
        currency: 'USD',
        type: WalletTransactionType.CREDIT,
        idempotencyKey: `cardpay:${lockRow.id}`,
      }),
      'credit',
    );
    expect(tx.cardPayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: CardPaymentStatus.SUCCEEDED }),
      }),
    );

    // Rejeu : la ligne est déjà SUCCEEDED → aucun second crédit.
    lockRow = basePayment({
      status: CardPaymentStatus.SUCCEEDED,
      paidAt: new Date(),
    });
    const second = await service.confirmPaid({
      sessionRef: 'cs_sim_1',
      paymentRef: 'pi_sim_1',
      amountTotalCents: 5000,
      currency: 'usd',
      livemode: false,
      source: 'webhook',
      providerCode: 'simulated',
    });
    expect(second.outcome).toBe('already');
    expect(wallet.applyWithClient).toHaveBeenCalledTimes(1);
  });

  it('signale NEEDS_REVIEW (aucun crédit) si le montant diffère', async () => {
    lockRow = basePayment();
    const res = await service.confirmPaid({
      sessionRef: 'cs_sim_1',
      amountTotalCents: 4999,
      currency: 'usd',
      livemode: false,
      source: 'webhook',
      providerCode: 'simulated',
    });
    expect(res.outcome).toBe('needs_review');
    expect(wallet.applyWithClient).not.toHaveBeenCalled();
    expect(tx.cardPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: CardPaymentStatus.NEEDS_REVIEW,
          interventionNeeded: true,
        }),
      }),
    );
  });

  it('signale NEEDS_REVIEW si la devise du paiement n’est pas celle du portefeuille', async () => {
    lockRow = basePayment();
    tx.customer.findUnique.mockReturnValue({ walletCurrency: 'EUR' });
    const res = await service.confirmPaid({
      sessionRef: 'cs_sim_1',
      amountTotalCents: 5000,
      currency: 'usd',
      livemode: false,
      source: 'webhook',
      providerCode: 'simulated',
    });
    expect(res.outcome).toBe('needs_review');
    expect(wallet.applyWithClient).not.toHaveBeenCalled();
  });

  it('signale NEEDS_REVIEW si le prestataire renvoie livemode=true en mode test', async () => {
    lockRow = basePayment();
    const res = await service.confirmPaid({
      sessionRef: 'cs_sim_1',
      amountTotalCents: 5000,
      currency: 'usd',
      livemode: true,
      source: 'webhook',
      providerCode: 'simulated',
    });
    expect(res.outcome).toBe('needs_review');
    expect(wallet.applyWithClient).not.toHaveBeenCalled();
  });

  it('ne crédite JAMAIS après un échec déjà tranché (contradiction signalée)', async () => {
    lockRow = basePayment({ status: CardPaymentStatus.FAILED });
    const res = await service.confirmPaid({
      sessionRef: 'cs_sim_1',
      amountTotalCents: 5000,
      currency: 'usd',
      livemode: false,
      source: 'webhook',
      providerCode: 'simulated',
    });
    expect(res.outcome).toBe('ignored');
    expect(wallet.applyWithClient).not.toHaveBeenCalled();
    expect(tx.cardPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ interventionNeeded: true }),
      }),
    );
  });

  it('retourne not_found pour un objet prestataire inconnu', async () => {
    tx.$queryRaw.mockReturnValue([]);
    await expect(
      service.confirmPaid({
        sessionRef: 'cs_inconnu',
        source: 'webhook',
        providerCode: 'simulated',
      }),
    ).resolves.toEqual({ outcome: 'not_found' });
  });

  it('ne relit le prestataire que pour un paiement non terminé', async () => {
    prisma.cardPayment.findUnique.mockResolvedValue(
      basePayment({ status: CardPaymentStatus.SUCCEEDED }),
    );
    const view = await service.refreshFromProvider('CDP-AAAA11BB', user);
    expect(view.status).toBe(CardPaymentStatus.SUCCEEDED);
    expect(connector.retrieveSession).not.toHaveBeenCalled();
  });

  // ── GO P3 — reprise d’un appel resté incertain (même clé, même session) ──

  it('P3 : relance la création UNCERTAINE avec la MÊME clé (aucune seconde session)', async () => {
    lockRow = basePayment({
      providerCallState: 'UNCERTAIN',
      providerSessionRef: null,
      providerPaymentRef: null,
      checkoutUrl: null,
      dispatchedAt: new Date(),
    } as Row);
    prisma.cardPayment.findUnique.mockResolvedValue(lockRow);
    const view = await service.refreshFromProvider('CDP-AAAA11BB', user);
    expect(provider.resolveFor).toHaveBeenCalledWith({
      providerCode: 'simulated',
      merchantAccount: 'sim_merchant_local',
      environment: 'test',
    });
    expect(connector.createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(connector.createCheckoutSession.mock.calls[0][0]).toMatchObject({
      // Clé STABLE par opération : toute reprise = même session prestataire.
      idempotencyKey: 'topup:CDP-AAAA11BB',
      reference: 'CDP-AAAA11BB',
    });
    expect(view.checkoutUrl).toBeTruthy();
  });

  it('P3 : un paiement DÉJÀ résolu n’est jamais redispatché (issue constatée)', async () => {
    lockRow = basePayment({ providerCallState: 'RESOLVED', status: CardPaymentStatus.CREATED });
    prisma.cardPayment.findUnique.mockResolvedValue(lockRow);
    await service.refreshFromProvider('CDP-AAAA11BB', user);
    expect(connector.createCheckoutSession).not.toHaveBeenCalled();
    expect(provider.resolve).not.toHaveBeenCalled();
  });

  // ── GO P7/P1 — notes d’échec sans changement d’état, limitées au fournisseur ─

  it('P7 : une note d’échec ne change PAS l’état (un succès ultérieur reste créditable)', async () => {
    await service.markFailureNotice({
      paymentRef: 'pi_sim_1',
      providerCode: 'simulated',
      code: 'payment_failed',
      message: 'Refusé (intent encore vivant)',
    });
    expect(prisma.cardPayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [CardPaymentStatus.CREATED, CardPaymentStatus.PROCESSING] },
        }),
        data: expect.objectContaining({
          failureCode: 'payment_failed',
          failureMessage: 'Refusé (intent encore vivant)',
        }),
      }),
    );
    // Aucune écriture de STATUT, aucun crédit.
    expect(prisma.cardPayment.update).not.toHaveBeenCalled();
    expect(wallet.applyWithClient).not.toHaveBeenCalled();
  });

  it('P1 : une note d’un AUTRE fournisseur ne touche pas la ligne (zéro effet)', async () => {
    prisma.cardPayment.updateMany.mockResolvedValue({ count: 0 });
    await service.markFailureNotice({
      paymentRef: 'pi_sim_1',
      providerCode: 'stripe',
      message: 'Refusé',
    });
    expect(prisma.cardPayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ providerCode: 'stripe' }),
      }),
    );
    expect(wallet.applyWithClient).not.toHaveBeenCalled();
  });

  it('P1 : confirmation signée par un AUTRE fournisseur → « ignoré », aucun crédit', async () => {
    lockRow = basePayment();
    const res = await service.confirmPaid({
      sessionRef: 'cs_sim_1',
      amountTotalCents: 5000,
      currency: 'usd',
      livemode: false,
      source: 'webhook',
      providerCode: 'stripe',
    });
    expect(res.outcome).toBe('ignored');
    expect(wallet.applyWithClient).not.toHaveBeenCalled();
  });
});
