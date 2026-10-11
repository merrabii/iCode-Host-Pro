import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CardPayment, CardPaymentStatus, WalletTransactionType } from '@prisma/client';
import { JwtPayload } from '../auth/types';
import { CardPaymentsService, assertPaymentIdempotencyKey } from './card-payments.service';
import { StripeHttpError } from './stripe-connector';

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
    order: { findUnique: jest.Mock };
    cardPayment: {
      updateMany: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
    };
    customer: { findUnique: jest.Mock };
    walletTransaction: { findUnique: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    order: { findUnique: jest.Mock };
    cardPayment: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
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
  // Gates + confirmation de commande (références conservées pour les tests).
  let settings: {
    assertEnabled: jest.Mock;
    assertCardMethodActive: jest.Mock;
    capabilities: jest.Mock;
  };
  let checkout: { confirmOrderWithin: jest.Mock; afterConfirmOrderPaid: jest.Mock };
  let service: CardPaymentsService;
  let lockRow: CardPayment;

  beforeEach(() => {
    lockRow = basePayment();
    tx = {
      $queryRaw: jest.fn(() => [lockRow]),
    order: {
      findUnique: jest.fn(async () => ({ status: 'PENDING_PAYMENT' })),
    },
    cardPayment: {
      create: jest.fn(async (a: { data: Row }) => basePayment({ ...a.data })),
      updateMany: jest.fn(() => ({ count: 1 })),
      update: jest.fn((args: { where?: Row; data: Row }) => ({
        ...lockRow,
        ...args.data,
      })),
      // Parcours ordre : aucune tentative vivante / aucun rejeu par défaut.
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
      count: jest.fn(async () => 0),
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
      order: {
        findUnique: jest.fn(),
      },
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
        count: jest.fn(async () => 0),
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
    settings = {
      assertEnabled: jest.fn(async () => undefined),
      assertCardMethodActive: jest.fn(async () => undefined),
      capabilities: jest.fn(async () => ({
        walletPaymentEnabled: true,
        cardOrderPaymentEnabled: true,
        cardTopupEnabled: true,
      })),
    };
    checkout = {
      confirmOrderWithin: jest.fn(async () => ({ alreadyConfirmed: false })),
      afterConfirmOrderPaid: jest.fn(async () => undefined),
    };
    service = new CardPaymentsService(
      prisma as never,
      wallet as never,
      provider as never,
      audit as never,
      { get: jest.fn(() => 'http://localhost:3011') } as never,
      settings as never,
      checkout as never,
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
    expect(tx.cardPayment.create).not.toHaveBeenCalled();
  });

  it('refuse une clé d’idempotence réutilisée pour un autre montant', async () => {
    prisma.cardPayment.findUnique.mockResolvedValue(
      basePayment({ amountCents: 7000 }),
    );
    await expect(
      service.createTopup(user, { amountCents: 5000, idempotencyKey: 'idem-key-123456' }),
    ).rejects.toThrow(ConflictException);
  });

  it('§6 : clé réutilisée par un AUTRE compte → 409 (changement de compte, clé jamais volée)', async () => {
    prisma.cardPayment.findUnique.mockResolvedValue(basePayment());
    wallet.ensureOwnedCustomer.mockResolvedValue({
      id: 'cust2',
      email: 'autre@code.test',
      walletBalanceCents: 0,
      walletCurrency: 'USD',
    });
    await expect(
      service.createTopup(user, { amountCents: 5000, idempotencyKey: 'idem-key-123456' }),
    ).rejects.toThrow('déjà utilisée pour une autre intention');
    expect(connector.createCheckoutSession).not.toHaveBeenCalled();
    expect(prisma.cardPayment.create).not.toHaveBeenCalled();
  });

  it('marque FAILED (aucun crédit) si le prestataire refuse l’ouverture', async () => {
    prisma.cardPayment.findUnique.mockResolvedValue(null);
    connector.createCheckoutSession.mockRejectedValue(
      Object.assign(new Error('clé secrète invalide'), { name: 'StripeHttpError' }),
    );
    await expect(
      service.createTopup(user, { amountCents: 5000, idempotencyKey: 'idem-key-123456' }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.cardPayment.updateMany).toHaveBeenCalledWith(
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

  // ── GO revue §4 — gate du moyen sur PREMIÈRE émission relancée ─────────

  it('§4 : première émission relancée + ligne moyen CARTE inactive → 409, zéro réseau', async () => {
    lockRow = basePayment({
      providerCallState: null,
      providerSessionRef: null,
      providerPaymentRef: null,
      checkoutUrl: null,
      dispatchedAt: null,
    } as Row);
    prisma.cardPayment.findUnique.mockResolvedValue(lockRow);
    settings.assertCardMethodActive.mockRejectedValueOnce(
      new ConflictException({
        message: 'Moyen de paiement carte désactivé.',
        code: 'PAYMENT_METHOD_DISABLED',
        capability: 'card',
      }),
    );

    const err = await service
      .refreshFromProvider('CDP-AAAA11BB', user)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(String((err as ConflictException).message)).toContain('carte désactivé');
    expect(settings.assertEnabled).toHaveBeenCalledWith('cardTopup');
    expect(settings.assertCardMethodActive).toHaveBeenCalled();
    // Refus AVANT toute écriture ni appel réseau : jamais d'émission fantôme.
    expect(connector.createCheckoutSession).not.toHaveBeenCalled();
    expect(prisma.cardPayment.updateMany).not.toHaveBeenCalled();
    expect(prisma.cardPayment.update).not.toHaveBeenCalled();
  });

  it('§4 : reprise d’une émission DÉJÀ émise → SANS gate du moyen (établir l’issue prime)', async () => {
    lockRow = basePayment({
      providerCallState: 'UNCERTAIN',
      providerSessionRef: null,
      providerPaymentRef: null,
      checkoutUrl: null,
      dispatchedAt: new Date(),
    } as Row);
    prisma.cardPayment.findUnique.mockResolvedValue(lockRow);
    settings.assertCardMethodActive.mockRejectedValueOnce(
      new ConflictException('le gate moyen ne doit PAS toucher une reprise'),
    );

    const view = await service.refreshFromProvider('CDP-AAAA11BB', user);

    expect(settings.assertEnabled).not.toHaveBeenCalled();
    expect(settings.assertCardMethodActive).not.toHaveBeenCalled();
    expect(connector.createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(view.checkoutUrl).toBeTruthy();
  });

  // ── GO revue §3d + V3 §1 — écritures TARDIVES bornées (jamais d’écrasement) ──

  /** Double Prisma « mémoire » honnête : CAS propriétaire honorés pour de vrai. */
  const installDispatchStore = () => {
    const db = basePayment({
      providerCallState: null,
      providerSessionRef: null,
      providerPaymentRef: null,
      checkoutUrl: null,
      dispatchedAt: null,
      dispatchOwner: null,
      dispatchClaimedAt: null,
    } as Row);
    // Moteur CAS unique opérant sur `db` : la transaction webhook
    // (`tx.cardPayment.updateMany`) et le client racine voient la MÊME ligne.
    const casEngine = async (args: { where?: Row; data?: Row }) => {
      const w = (args.where ?? {}) as Row;
      // Revendication fraîche (GO V3 §1) : uniquement sur ligne JAMAIS
      // dispatchée et sans propriétaire.
      if (w.providerCallState === null && w.dispatchOwner === null) {
        if (db.providerCallState !== null || db.dispatchOwner !== null) {
          return { count: 0 };
        }
        Object.assign(db, args.data ?? {});
        return { count: 1 };
      }
      // CAS PROPRIÉTAIRE (écriture de résultat / dépossession observée).
      if ('dispatchOwner' in w) {
        if ((db.dispatchOwner ?? null) !== (w.dispatchOwner ?? null)) return { count: 0 };
        // GO V5 §1 — état admissible exigé (ex. `DISPATCHED` = en vol) :
        // une décision webhook déjà établie (`RESOLVED`) n'est jamais
        // écrasée, même avec le même propriétaire.
        if (
          'providerCallState' in w &&
          w.providerCallState !== undefined &&
          db.providerCallState !== w.providerCallState
        ) {
          return { count: 0 };
        }
        Object.assign(db, args.data ?? {});
        return { count: 1 };
      }
      // CAS webhook (confirmation) : statut admissible.
      if (w.status && typeof w.status === 'object' && Array.isArray((w.status as Row).in)) {
        const allowed = (w.status as { in: CardPaymentStatus[] }).in;
        if (!allowed.includes(db.status)) return { count: 0 };
        Object.assign(db, args.data ?? {});
        return { count: 1 };
      }
      // `dispatchedAt` immuable (premier envoi seulement).
      if (w.dispatchedAt === null) {
        if (db.dispatchedAt !== null) return { count: 0 };
        db.dispatchedAt = (args.data?.dispatchedAt as Date) ?? new Date();
        return { count: 1 };
      }
      Object.assign(db, args.data ?? {});
      return { count: 1 };
    };
    prisma.cardPayment.findUnique.mockImplementation(async () => ({ ...db }));
    prisma.cardPayment.updateMany.mockImplementation(casEngine);
    tx.cardPayment.updateMany.mockImplementation(casEngine);
    return {
      db,
      concludeByPeer: () =>
        Object.assign(db, {
          status: CardPaymentStatus.SUCCEEDED,
          providerCallState: 'RESOLVED',
          checkoutUrl: '/du-pair',
          paidAt: new Date(),
          // GO V3 §1 — le pair a DÉPOSSESSIONNÉ notre tentative (lease
          // expiré) : l'issue lui appartient, nos écritures tardives perdent.
          dispatchOwner: 'peer-owner-v3',
        }),
    };
  };

  it('§3d : une issue déjà tranchée n’est jamais redispatchée (revendication perdue → zéro réseau)', async () => {
    const { db, concludeByPeer } = installDispatchStore();
    prisma.cardPayment.updateMany.mockImplementation(
      async (args: { where?: Row; data?: Row }) => {
        const w = (args.where ?? {}) as Row;
        if (w.providerCallState === null && w.dispatchOwner === null) {
          concludeByPeer(); // le pair conclut juste avant notre revendication
          return { count: 0 };
        }
        Object.assign(db, args.data ?? {});
        return { count: 1 };
      },
    );
    const view = await service.refreshFromProvider('CDP-AAAA11BB', user);
    expect(connector.createCheckoutSession).not.toHaveBeenCalled();
    expect(view.status).toBe(CardPaymentStatus.SUCCEEDED);
  });

  it('V3 §1 : tentative VIVANTE (lease courant) → seconde invocation n’émet AUCUN octet réseau', async () => {
    const { db } = installDispatchStore();
    // Le premier appel est BLOQUÉ au réseau (promise contrôlée).
    let release: (s: Row) => void = () => undefined;
    const gate = new Promise<Row>((resolve) => {
      release = resolve;
    });
    connector.createCheckoutSession.mockImplementationOnce(async () => gate);
    const first = service.refreshFromProvider('CDP-AAAA11BB', user);
    // Petit rendez-vous : la première tentative a revendiqué (DISPATCHED).
    await new Promise((r) => setImmediate(r));
    expect(db.providerCallState).toBe('DISPATCHED');
    expect(db.dispatchOwner).toBeTruthy();
    // Seconde invocation PENDANT la tentative vivante : revendication perdue
    // (lease non expiré) → retour de l'état réel, ZÉRO second envoi.
    const second = await service.refreshFromProvider('CDP-AAAA11BB', user);
    expect(connector.createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(second.checkoutUrl).toBeFalsy(); // toujours en vol, aucune session
    expect(db.providerCallState).toBe('DISPATCHED');
    // Libération : le premier appel conclut normalement (même propriétaire).
    release({
      sessionRef: 'cs_only',
      paymentRef: 'pi_only',
      checkoutUrl: '/notre-session',
      livemode: false,
      expiresAt: new Date('2026-10-07T00:30:00Z'),
    } as unknown as Row);
    const view = await first;
    expect(view.checkoutUrl).toBe('/notre-session');
    expect(db.providerCallState).toBe('RESOLVED');
  });

  it('V3 §1 : lease EXPIRÉ → reprise dépossède le propriétaire interrompu (CAS sur valeurs observées)', async () => {
    const { db } = installDispatchStore();
    // Tentative interrompue il y a 2 minutes (lease 60 s expiré).
    Object.assign(db, {
      providerCallState: 'DISPATCHED',
      dispatchOwner: 'crashed-owner',
      dispatchClaimedAt: new Date(Date.now() - 120_000),
      dispatchedAt: new Date(Date.now() - 120_000),
    });
    const view = await service.refreshFromProvider('CDP-AAAA11BB', user);
    expect(connector.createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(db.dispatchOwner).not.toBe('crashed-owner');
    expect(db.providerCallState).toBe('RESOLVED');
    expect(view.checkoutUrl).toBeTruthy();
  });

  it('§3d : réponse TARDIVE (CAS propriétaire perdu) → aucun écrasement, l’état réel est retourné', async () => {
    const { db, concludeByPeer } = installDispatchStore();
    db.dispatchedAt = new Date(); // déjà émise : gate moyen non requis
    connector.createCheckoutSession.mockImplementationOnce(async () => {
      concludeByPeer(); // le pair dépossède + conclut PENDANT notre appel réseau
      return {
        sessionRef: 'cs_late',
        paymentRef: 'pi_late',
        checkoutUrl: '/notre-session',
        livemode: false,
        expiresAt: new Date('2026-10-07T00:30:00Z'),
      };
    });
    const view = await service.refreshFromProvider('CDP-AAAA11BB', user);
    // Le CAS de la réponse a PERDU (count 0) : retour de l'état réel du pair.
    expect(view.status).toBe(CardPaymentStatus.SUCCEEDED);
    expect(db.status).toBe(CardPaymentStatus.SUCCEEDED); // JAMAIS ré-écrit
    expect(db.providerCallState).toBe('RESOLVED');
    // Preuve que l'écriture de réponse est BORNÉE au propriétaire courant.
    expect(prisma.cardPayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dispatchOwner: expect.any(String),
        }),
        data: expect.objectContaining({ providerCallState: 'RESOLVED' }),
      }),
    );
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.topup.persistence_failed' }),
    );
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.topup.create_failed' }),
    );
  });

  it('§3d : échec incertain → JAMAIS dégrader une issue déjà tranchée (CAS UNCERTAIN perdu)', async () => {
    const { db, concludeByPeer } = installDispatchStore();
    db.dispatchedAt = new Date();
    connector.createCheckoutSession.mockImplementationOnce(async () => {
      concludeByPeer();
      throw new Error('ECONNRESET');
    });
    const view = await service.refreshFromProvider('CDP-AAAA11BB', user);
    expect(db.providerCallState).toBe('RESOLVED'); // intact
    expect(db.status).toBe(CardPaymentStatus.SUCCEEDED);
    expect(view.status).toBe(CardPaymentStatus.SUCCEEDED);
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.topup.dispatch_uncertain' }),
    );
  });

  it('§3d : refus certain tardif → JAMAIS écraser l’issue du pair (CAS FAILED perdu)', async () => {
    const { db, concludeByPeer } = installDispatchStore();
    db.dispatchedAt = new Date();
    connector.createCheckoutSession.mockImplementationOnce(async () => {
      concludeByPeer();
      throw new StripeHttpError('clé secrète invalide', 400, 'invalid_request_error');
    });
    const view = await service.refreshFromProvider('CDP-AAAA11BB', user);
    expect(view.status).toBe(CardPaymentStatus.SUCCEEDED);
    expect(db.status).toBe(CardPaymentStatus.SUCCEEDED); // JAMAIS FAILED
    // L'écriture ESSAYÉE était bien un CAS sur le propriétaire courant.
    expect(prisma.cardPayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dispatchOwner: expect.any(String) }),
        data: expect.objectContaining({
          status: CardPaymentStatus.FAILED,
          providerCallState: 'RESOLVED',
        }),
      }),
    );
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.topup.create_failed' }),
    );
  });

  it('V3 §1 : un 409 prestataire n’est JAMAIS un refus certain (incertain, pas de FAILED)', async () => {
    const { db } = installDispatchStore();
    db.dispatchedAt = new Date();
    connector.createCheckoutSession.mockImplementationOnce(async () => {
      throw new StripeHttpError('idempotency conflict', 409, 'invalid_request_error');
    });
    const view = await service.refreshFromProvider('CDP-AAAA11BB', user);
    expect(db.providerCallState).toBe('UNCERTAIN');
    expect(db.status).not.toBe(CardPaymentStatus.FAILED);
    expect(view.status).not.toBe(CardPaymentStatus.FAILED);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.topup.dispatch_uncertain' }),
    );
  });

  // ── GO V5 §1 — réponse tardive APRÈS confirmation webhook (TOPUP) ────────
  // Scénario : appel suspendu au réseau → le WEBHOOK confirme (SUCCEEDED,
  // RESOLVED, revendication invalidée) → la réponse réseau arrive tardivement
  // (timeout / refus / succès). La décision webhook n'est JAMAIS dégradée.

  const v5SuspendAndConfirmTopup = async () => {
    const { db } = installDispatchStore();
    // Tentative antérieure UNCERTAIN (réseau manqué) : session déjà connue,
    // lease expiré → la reprise prend possession et émet (gate suspendu).
    db.dispatchedAt = new Date(Date.now() - 10 * 60_000);
    db.providerSessionRef = 'cs_sim_1';
    db.providerPaymentRef = 'pi_sim_1';
    db.checkoutUrl = '/api/payments/simulated/sessions/cs_sim_1';
    db.providerCallState = 'UNCERTAIN';
    db.dispatchOwner = 'owner-ancien-v5';
    db.dispatchClaimedAt = new Date(Date.now() - 10 * 60_000);
    let releaseGate!: (v: Row | PromiseLike<Row>) => void;
    let failGate!: (e: unknown) => void;
    const gate = new Promise<Row>((resolve, reject) => {
      releaseGate = resolve;
      failGate = reject;
    });
    connector.createCheckoutSession.mockImplementationOnce(async () => gate);
    const pending = service.refreshFromProvider('CDP-AAAA11BB', user);
    // Laisse la reprise prendre possession puis atteindre le réseau (gate).
    await new Promise((r) => setImmediate(r));
    expect(db.providerCallState).toBe('DISPATCHED');
    expect(db.dispatchOwner).not.toBe('owner-ancien-v5');
    // Le webhook confirme PENDANT que le réseau est suspendu.
    lockRow = db as CardPayment;
    tx.$queryRaw.mockResolvedValueOnce([db]); // verrou confirmPaid voit la ligne
    const confirmed = await service.confirmPaid({
      sessionRef: 'cs_sim_1',
      paymentRef: 'pi_sim_1',
      amountTotalCents: 5000,
      currency: 'usd',
      livemode: false,
      source: 'webhook',
      providerCode: 'simulated',
    });
    return { db, releaseGate, failGate, pending, confirmed };
  };

  it('V5 §1 TOPUP : webhook confirme puis TIMEOUT tardif → SUCCEEDED conservé, AUCUNE dégradation', async () => {
    const { db, failGate, pending } = await v5SuspendAndConfirmTopup();
    expect(db.status).toBe(CardPaymentStatus.SUCCEEDED);
    expect(db.providerCallState).toBe('RESOLVED');
    expect(db.dispatchOwner).toBeNull(); // revendication invalidée par le webhook
    expect(wallet.applyWithClient).toHaveBeenCalledTimes(1); // UN SEUL crédit

    failGate(new StripeHttpError('network timeout', 0, 'api_error'));
    const view = await pending; // réponse tardive classée UNCERTAIN côté appel…
    // …mais JAMAIS écrite : la ligne est restée SUCCEEDED/RESOLVED.
    expect(db.status).toBe(CardPaymentStatus.SUCCEEDED);
    expect(db.providerCallState).toBe('RESOLVED');
    expect(db.dispatchOwner).toBeNull();
    expect(db.failureCode).toBeNull();
    expect(db.interventionNeeded).toBe(false);
    expect(view.status).toBe(CardPaymentStatus.SUCCEEDED);
    expect(wallet.applyWithClient).toHaveBeenCalledTimes(1); // toujours UN SEUL
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.topup.dispatch_uncertain' }),
    );
  });

  it('V5 §1 TOPUP : webhook confirme puis REFUS certain tardif → jamais de FAILED après le crédit', async () => {
    const { db, failGate, pending } = await v5SuspendAndConfirmTopup();
    failGate(new StripeHttpError('card declined', 402, 'card_error'));
    const view = await pending;
    expect(db.status).toBe(CardPaymentStatus.SUCCEEDED); // jamais FAILED
    expect(db.providerCallState).toBe('RESOLVED');
    expect(db.failureCode).toBeNull();
    expect(db.failureMessage).toBeNull();
    expect(view.status).toBe(CardPaymentStatus.SUCCEEDED);
    expect(wallet.applyWithClient).toHaveBeenCalledTimes(1); // pas de double effet
  });

  it('V5 §1 TOPUP : webhook confirme puis SUCCÈS tardif → CAS perdu, références webhook conservées', async () => {
    const { db, releaseGate, pending } = await v5SuspendAndConfirmTopup();
    const refsAfterWebhook = {
      providerSessionRef: db.providerSessionRef,
      providerPaymentRef: db.providerPaymentRef,
    };
    // Le réseau répond enfin (session créée) : la réponse tardive perd le CAS
    // (propriétaire invalidé + état déjà RESOLVED).
    releaseGate({
      sessionRef: 'cs_sim_late',
      paymentRef: 'pi_sim_late',
      checkoutUrl: '/late',
      livemode: false,
      expiresAt: new Date(),
    });
    const view = await pending;
    // Aucune écrasement : les références du WEBHOOK sont conservées telles
    // quelles (jamais remplacées par la réponse tardive).
    expect(db.providerSessionRef).toBe(refsAfterWebhook.providerSessionRef);
    expect(db.providerPaymentRef).toBe(refsAfterWebhook.providerPaymentRef);
    expect(db.status).toBe(CardPaymentStatus.SUCCEEDED);
    expect(db.providerCallState).toBe('RESOLVED');
    expect(view.status).toBe(CardPaymentStatus.SUCCEEDED);
    expect(wallet.applyWithClient).toHaveBeenCalledTimes(1);
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

  // ── Lot « paiement direct des commandes » ───────────────────────────────

  const orderRow = (over: Row = {}): Row => ({
    id: 'ord1',
    status: 'PENDING_PAYMENT',
    amountTtcCents: 1500,
    amountHtCents: 1304,
    taxAmountCents: 196,
    currency: 'USD',
    customerEmail: 'client@code.test',
    customerId: 'cust1',
    customer: { id: 'cust1', userId: 'user-1' },
    ...over,
  });

  const openOrderPayment = (over: Row = {}) =>
    service.createOrderPayment(
      'ord1',
      user,
      { idempotencyKey: 'web-key-0123456789' },
      undefined,
    ).then((v) => v, (e: unknown) => e);

  describe('createOrderPayment (règlement d’une commande par carte)', () => {
    it('GATE : parcours « règlement carte » désactivé → 409, AUCUNE lecture ni écriture', async () => {
      settings.assertEnabled.mockRejectedValueOnce(
        new ConflictException({
          message: 'désactivé',
          code: 'PAYMENT_METHOD_DISABLED',
          capability: 'cardOrder',
        }),
      );
      const err = await openOrderPayment();
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'PAYMENT_METHOD_DISABLED',
        capability: 'cardOrder',
      });
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
      expect(tx.cardPayment.create).not.toHaveBeenCalled();
      expect(connector.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('commande d’un AUTRE client (ou inexistante) → 404, aucune tentative créée', async () => {
      prisma.order.findUnique.mockResolvedValue(
        orderRow({ customer: { id: 'custX', userId: 'user-2' } }),
      );
      const err = await openOrderPayment();
      expect(err).toBeInstanceOf(NotFoundException);
      expect(tx.cardPayment.create).not.toHaveBeenCalled();
    });

    it('commande déjà réglée → 409 honnête (règlement impossible)', async () => {
      prisma.order.findUnique.mockResolvedValue(orderRow({ status: 'PAID' }));
      const err = await openOrderPayment();
      expect(err).toBeInstanceOf(ConflictException);
      expect(String((err as ConflictException).message)).toContain('PAID');
      expect(tx.cardPayment.create).not.toHaveBeenCalled();
    });

    it('montant hors de la plage carte → 400, aucun appel prestataire', async () => {
      prisma.order.findUnique.mockResolvedValue(
        orderRow({ amountTtcCents: 0 }),
      );
      const err = await openOrderPayment();
      expect(err).toBeInstanceOf(BadRequestException);
      expect(connector.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('ouvre une tentative AVEC la montant/devise de la COMMANDE (jamais du client)', async () => {
      prisma.order.findUnique.mockResolvedValue(orderRow());
      const view = await openOrderPayment();
      expect(view).not.toBeInstanceOf(Error);
      expect(tx.cardPayment.create).toHaveBeenCalledTimes(1);
      expect(tx.cardPayment.create.mock.calls[0][0].data).toMatchObject({
        kind: 'ORDER',
        orderId: 'ord1',
        customerId: 'cust1',
        amountCents: 1500,
        currency: 'USD',
        status: CardPaymentStatus.CREATED,
        idempotencyKey: 'web-key-0123456789',
      });
      // session hébergée : retour page de SUCCÈS (orderId + ref), idempotence propre
      expect(connector.createCheckoutSession).toHaveBeenCalledTimes(1);
      const call = connector.createCheckoutSession.mock.calls[0][0];
      expect(call.idempotencyKey).toMatch(/^orderpay:/);
      expect(call.metadata).toMatchObject({ kind: 'ORDER', orderId: 'ord1' });
      expect(call.successUrl).toContain('/checkout/success?orderId=ord1&ref=');
      expect(call.cancelUrl).toContain('/checkout/payment?orderId=ord1');
    });

    it('tentative vivante = MÊME session (aucune seconde session, même référence)', async () => {
      prisma.order.findUnique.mockResolvedValue(orderRow());
      tx.cardPayment.findFirst.mockResolvedValue(
        basePayment({
          kind: 'ORDER',
          orderId: 'ord1',
          amountCents: 1500,
          currency: 'USD',
          customerId: 'cust1',
          providerCallState: 'RESOLVED',
        }),
      );
      const view = await openOrderPayment();
      expect(view).not.toBeInstanceOf(Error);
      expect(view).toMatchObject({ reference: 'CDP-AAAA11BB' });
      expect(tx.cardPayment.create).not.toHaveBeenCalled();
      expect(connector.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('tentative vivante INCOHÉRENTE avec la commande → 409 intervention', async () => {
      prisma.order.findUnique.mockResolvedValue(orderRow());
      tx.cardPayment.findFirst.mockResolvedValue(
        basePayment({
          kind: 'ORDER',
          orderId: 'ord1',
          amountCents: 999,
          currency: 'USD',
        }),
      );
      const err = await openOrderPayment();
      expect(err).toBeInstanceOf(ConflictException);
      expect(String((err as ConflictException).message)).toContain(
        'intervention requise',
      );
      expect(tx.cardPayment.create).not.toHaveBeenCalled();
    });

    it('même clé client réutilisée sur la MÊME intention → rejeu (aucune 2e tentative)', async () => {
      prisma.order.findUnique.mockResolvedValue(orderRow());
      tx.cardPayment.findUnique.mockImplementation(
        async (a: { where: Row }) =>
          a.where.idempotencyKey === 'web-key-0123456789'
            ? basePayment({
                kind: 'ORDER',
                orderId: 'ord1',
                amountCents: 1500,
                currency: 'USD',
                customerId: 'cust1',
                providerCallState: 'RESOLVED',
                idempotencyKey: 'web-key-0123456789',
              })
            : null,
      );
      const view = await openOrderPayment();
      expect(view).not.toBeInstanceOf(Error);
      expect(view).toMatchObject({ reference: 'CDP-AAAA11BB' });
      expect(tx.cardPayment.create).not.toHaveBeenCalled();
    });

    it('clé client réutilisée pour une AUTRE commande → 409, aucune écriture', async () => {
      prisma.order.findUnique.mockResolvedValue(orderRow());
      tx.cardPayment.findUnique.mockResolvedValue(
        basePayment({
          kind: 'ORDER',
          orderId: 'ord-autre',
          amountCents: 1500,
          currency: 'USD',
          customerId: 'cust1',
          idempotencyKey: 'web-key-0123456789',
        }),
      );
      const err = await openOrderPayment();
      expect(err).toBeInstanceOf(ConflictException);
      expect(String((err as ConflictException).message)).toContain(
        "Clé d'idempotence",
      );
      expect(tx.cardPayment.create).not.toHaveBeenCalled();
    });
  });

  describe('get/refresh — vue client du règlement commande', () => {
    it('getOrderPayment exige la propriété (commande d’autrui → 404)', async () => {
      prisma.order.findUnique.mockResolvedValue(
        orderRow({ customer: { id: 'custX', userId: 'user-2' } }),
      );
      await expect(
        service.getOrderPayment('ord1', user),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.cardPayment.findFirst).not.toHaveBeenCalled();
    });

    it('refreshOrderPayment = chemin de REPRISE : aucun gate, même moyen désactivé', async () => {
      prisma.order.findUnique.mockResolvedValue(orderRow());
      const settled = basePayment({
        kind: 'ORDER',
        orderId: 'ord1',
        amountCents: 1500,
        status: CardPaymentStatus.SUCCEEDED,
        providerCallState: 'RESOLVED',
      });
      prisma.cardPayment.findFirst.mockResolvedValue(settled);
      prisma.cardPayment.findUnique.mockResolvedValue(settled);
      const view = await service.refreshOrderPayment('ord1', user);
      expect(view.reference).toBe('CDP-AAAA11BB');
      expect(settings.assertEnabled).not.toHaveBeenCalled();
      // aucun appel réseau sur un paiement déjà tranché (état serveur suffit)
      expect(connector.retrieveSession).not.toHaveBeenCalled();
    });
  });

  describe('confirmPaid — règlement d’une commande (kind = ORDER)', () => {
    const orderPayment = (over: Row = {}) =>
      basePayment({
        kind: 'ORDER',
        orderId: 'ord1',
        customerId: 'cust1',
        amountCents: 1500,
        currency: 'USD',
        status: CardPaymentStatus.PROCESSING,
        providerCallState: 'RESOLVED',
        ...over,
      });

    const confirmInput = (over: Partial<Parameters<typeof service.confirmPaid>[0]> = {}) => ({
      sessionRef: 'cs_sim_1',
      paymentRef: 'pi_sim_1',
      amountTotalCents: 1500,
      currency: 'USD',
      livemode: false,
      source: 'webhook' as const,
      providerCode: 'simulated',
      ...over,
    });

    const lockOrderRow = (over: Row = {}) => ({
      id: 'ord1',
      status: 'PENDING_PAYMENT',
      customerId: 'cust1',
      amountTtcCents: 1500,
      currency: 'USD',
      ...over,
    });

    it('CAS unique de la commande : règlement confirmé, ZÉRO mouvement wallet, effets post-commit', async () => {
      lockRow = orderPayment();
      tx.$queryRaw
        .mockResolvedValueOnce([lockRow]) // verrou PAIEMENT
        .mockResolvedValueOnce([lockOrderRow()]); // verrou COMMANDE

      const res = await service.confirmPaid(confirmInput());

      expect(res).toEqual({
        outcome: 'settled',
        reference: 'CDP-AAAA11BB',
        orderId: 'ord1',
      });
      // MÊME corps de confirmation que tout autre règlement (rights + historique)
      expect(checkout.confirmOrderWithin).toHaveBeenCalledTimes(1);
      expect(checkout.confirmOrderWithin).toHaveBeenCalledWith(
        expect.anything(),
        'ord1',
        { source: 'card', reference: 'CDP-AAAA11BB' },
      );
      // post-commit : email/provisioning après le commit, jamais dedans
      expect(checkout.afterConfirmOrderPaid).toHaveBeenCalledTimes(1);
      expect(checkout.afterConfirmOrderPaid).toHaveBeenCalledWith(
        expect.anything(),
        'ord1',
        { source: 'card', reference: 'CDP-AAAA11BB' },
      );
      // ZÉRO mouvement de portefeuille sur un règlement carte
      expect(wallet.applyWithClient).not.toHaveBeenCalled();
      // CAS du paiement sous verrou (défense en profondeur)
      expect(tx.cardPayment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'cp1' }),
          data: expect.objectContaining({ status: CardPaymentStatus.SUCCEEDED }),
        }),
      );
    });

    it('§4 : désactivation concurrente du moyen → le CONSTAT d’un règlement déjà émis passe (zéro garde settings)', async () => {
      // Moyen désactivé pendant que l’émission est déjà faite : les gardes
      // rejetteraient TOUT appel (mocks persistants, pas « once ») — seul un
      // code qui les consulte sur le constat échouerait ici.
      settings.assertEnabled.mockRejectedValue(
        new ConflictException('Moyen de paiement désactivé.'),
      );
      settings.assertCardMethodActive.mockRejectedValue(
        new ConflictException('Moyen de paiement désactivé.'),
      );
      lockRow = orderPayment();
      tx.$queryRaw
        .mockResolvedValueOnce([lockRow])
        .mockResolvedValueOnce([lockOrderRow()]);

      const res = await service.confirmPaid(confirmInput());

      expect(res.outcome).toBe('settled');
      expect(checkout.confirmOrderWithin).toHaveBeenCalledTimes(1);
      // La désactivation n’est JAMAIS consultée sur un constat : seules les
      // émissions initiales gate le moyen (remboursement/constat/reprise restent ouverts).
      expect(settings.assertEnabled).not.toHaveBeenCalled();
      expect(settings.assertCardMethodActive).not.toHaveBeenCalled();
    });

    it('commande/paiement incohérents (montant) → NEEDS_REVIEW, aucun droit ouvert', async () => {
      lockRow = orderPayment();
      tx.$queryRaw
        .mockResolvedValueOnce([lockRow])
        .mockResolvedValueOnce([lockOrderRow({ amountTtcCents: 1400 })]);

      const res = await service.confirmPaid(confirmInput());

      expect(res.outcome).toBe('needs_review');
      expect(res).toMatchObject({ reason: expect.stringContaining('montant') });
      expect(checkout.confirmOrderWithin).not.toHaveBeenCalled();
      expect(checkout.afterConfirmOrderPaid).not.toHaveBeenCalled();
      expect(wallet.applyWithClient).not.toHaveBeenCalled();
    });

    it('règlement REFUSÉ par la commande (annulée) → NEEDS_REVIEW, jamais de crédit wallet', async () => {
      lockRow = orderPayment();
      tx.$queryRaw
        .mockResolvedValueOnce([lockRow])
        .mockResolvedValueOnce([lockOrderRow()]);
      checkout.confirmOrderWithin.mockRejectedValueOnce(
        new ConflictException('Commande CANCELLED : règlement impossible.'),
      );

      const res = await service.confirmPaid(confirmInput());

      expect(res.outcome).toBe('needs_review');
      expect(res).toMatchObject({
        reason: expect.stringContaining('règlement de commande refusé'),
      });
      expect(wallet.applyWithClient).not.toHaveBeenCalled();
      expect(checkout.afterConfirmOrderPaid).not.toHaveBeenCalled();
    });

    it('commande déjà réglée par un AUTRE moyen → NEEDS_REVIEW (intervention, aucun recrédit)', async () => {
      lockRow = orderPayment();
      tx.$queryRaw
        .mockResolvedValueOnce([lockRow])
        .mockResolvedValueOnce([lockOrderRow()]);
      checkout.confirmOrderWithin.mockResolvedValueOnce({ alreadyConfirmed: true });

      const res = await service.confirmPaid(confirmInput());

      expect(res).toMatchObject({ outcome: 'needs_review' });
      expect(res).toMatchObject({
        reason: expect.stringContaining('déjà réglée par un autre moyen'),
      });
      expect(checkout.afterConfirmOrderPaid).not.toHaveBeenCalled();
      expect(wallet.applyWithClient).not.toHaveBeenCalled();
      expect(tx.cardPayment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ interventionNeeded: true }),
        }),
      );
    });

    it('paiement de commande SANS commande rattachée → NEEDS_REVIEW', async () => {
      lockRow = orderPayment({ orderId: null });
      const res = await service.confirmPaid(confirmInput());
      expect(res.outcome).toBe('needs_review');
      expect(res).toMatchObject({
        reason: expect.stringContaining('sans commande rattachée'),
      });
      expect(checkout.confirmOrderWithin).not.toHaveBeenCalled();
      expect(wallet.applyWithClient).not.toHaveBeenCalled();
    });

    it('rejeu webhook après règlement → « already » (aucun second règlement)', async () => {
      lockRow = orderPayment({ status: CardPaymentStatus.SUCCEEDED });
      const res = await service.confirmPaid(confirmInput());
      expect(res.outcome).toBe('already');
      expect(checkout.confirmOrderWithin).not.toHaveBeenCalled();
      expect(checkout.afterConfirmOrderPaid).not.toHaveBeenCalled();
      expect(wallet.applyWithClient).not.toHaveBeenCalled();
    });

    // ── GO V5 §1 — réponse tardive APRÈS confirmation webhook (ORDER) ──────

    const v5SuspendAndConfirmOrder = async () => {
      const { db } = installDispatchStore();
      Object.assign(db, {
        kind: 'ORDER',
        orderId: 'ord1',
        amountCents: 1500,
        status: CardPaymentStatus.PROCESSING,
        // Tentative antérieure UNCERTAIN (lease expiré) : la reprise prend
        // possession puis émet (gate suspendu).
        providerCallState: 'UNCERTAIN',
        providerSessionRef: 'cs_sim_1',
        providerPaymentRef: 'pi_sim_1',
        checkoutUrl: '/api/payments/simulated/sessions/cs_sim_1',
        dispatchedAt: new Date(Date.now() - 10 * 60_000),
        dispatchClaimedAt: new Date(Date.now() - 10 * 60_000),
        dispatchOwner: 'owner-ancien-v5',
      });
      // Chemin refreshOrderPayment : propriété de la commande + ligne trouvée.
      prisma.order.findUnique.mockResolvedValue(orderRow());
      prisma.cardPayment.findFirst.mockResolvedValue({ ...db });
      let releaseGate!: (v: Row | PromiseLike<Row>) => void;
      let failGate!: (e: unknown) => void;
      const gate = new Promise<Row>((resolve, reject) => {
        releaseGate = resolve;
        failGate = reject;
      });
      connector.createCheckoutSession.mockImplementationOnce(async () => gate);
      // Synchronisation DÉTERMINISTE : `claimed` se résout exactement au
      // commit du CAS de reprise (DISPATCHED + propriétaire neuf) — le
      // premier octet réseau n'est émis qu'après ce commit, jamais avant.
      // Un échec du chemin (exception) rejette immédiatement, sans attente.
      let claimCommitted!: () => void;
      let claimFailed!: (e: unknown) => void;
      const claimed = new Promise<void>((resolve, reject) => {
        claimCommitted = resolve;
        claimFailed = reject;
      });
      const claimCas = prisma.cardPayment.updateMany.getMockImplementation()!;
      prisma.cardPayment.updateMany.mockImplementation(
        async (args: { where?: Row; data?: Row }) => {
          const res = await claimCas(args);
          if (
            res.count === 1 &&
            (args.data as Row | undefined)?.providerCallState === 'DISPATCHED'
          ) {
            claimCommitted();
          }
          return res;
        },
      );
      const pending = service.refreshOrderPayment('ord1', user);
      pending.catch((e) => claimFailed(e));
      await claimed; // prise de possession EFFECTIVE (ou échec du chemin)
      expect(db.providerCallState).toBe('DISPATCHED');
      expect(db.dispatchOwner).not.toBe('owner-ancien-v5');
      // Le webhook confirme (règlement de commande) pendant la suspension.
      lockRow = db as CardPayment;
      tx.$queryRaw
        .mockResolvedValueOnce([db]) // verrou PAIEMENT
        .mockResolvedValueOnce([lockOrderRow()]); // verrou COMMANDE
      const confirmed = await service.confirmPaid({
        sessionRef: 'cs_sim_1',
        paymentRef: 'pi_sim_1',
        amountTotalCents: 1500,
        currency: 'usd',
        livemode: false,
        source: 'webhook',
        providerCode: 'simulated',
      });
      return { db, releaseGate, failGate, pending, confirmed };
    };

    it('V5 §1 ORDER : webhook confirme puis TIMEOUT tardif → PAID conservé, AUCUNE dégradation', async () => {
      const { db, failGate, pending, confirmed } = await v5SuspendAndConfirmOrder();
      expect(confirmed).toMatchObject({ outcome: 'settled' });
      expect(db.status).toBe(CardPaymentStatus.SUCCEEDED);
      expect(db.providerCallState).toBe('RESOLVED');
      expect(db.dispatchOwner).toBeNull(); // revendication invalidée par le webhook
      expect(checkout.confirmOrderWithin).toHaveBeenCalledTimes(1);

      failGate(new StripeHttpError('network timeout', 0, 'api_error'));
      const view = await pending; // réponse tardive = aucun effet sur la décision
      expect(db.status).toBe(CardPaymentStatus.SUCCEEDED); // jamais UNCERTAIN/FAILED
      expect(db.providerCallState).toBe('RESOLVED');
      expect(db.dispatchOwner).toBeNull();
      expect(db.interventionNeeded).toBe(false);
      expect(db.failureCode).toBeNull();
      expect(view.status).toBe(CardPaymentStatus.SUCCEEDED);
      expect(wallet.applyWithClient).not.toHaveBeenCalled(); // zéro mouvement wallet
      expect(checkout.confirmOrderWithin).toHaveBeenCalledTimes(1); // pas de second règlement
    });

    it('V5 §1 ORDER : webhook confirme puis REFUS certain tardif → jamais de FAILED après le règlement', async () => {
      const { db, failGate, pending } = await v5SuspendAndConfirmOrder();
      failGate(new StripeHttpError('card declined', 402, 'card_error'));
      const view = await pending;
      expect(db.status).toBe(CardPaymentStatus.SUCCEEDED);
      expect(db.providerCallState).toBe('RESOLVED');
      expect(db.failureCode).toBeNull();
      expect(view.status).toBe(CardPaymentStatus.SUCCEEDED);
      expect(checkout.confirmOrderWithin).toHaveBeenCalledTimes(1);
      expect(wallet.applyWithClient).not.toHaveBeenCalled();
    });

    it('V5 §1 ORDER : webhook confirme puis SUCCÈS tardif → CAS perdu, référence webhook conservée', async () => {
      const { db, releaseGate, pending } = await v5SuspendAndConfirmOrder();
      const refAfterWebhook = db.providerPaymentRef;
      releaseGate({
        sessionRef: 'cs_sim_late',
        paymentRef: 'pi_sim_late',
        checkoutUrl: '/late',
        livemode: false,
        expiresAt: new Date(),
      });
      const view = await pending;
      expect(db.providerPaymentRef).toBe(refAfterWebhook); // jamais écrasé
      expect(db.status).toBe(CardPaymentStatus.SUCCEEDED);
      expect(db.providerCallState).toBe('RESOLVED');
      expect(view.status).toBe(CardPaymentStatus.SUCCEEDED);
      expect(checkout.confirmOrderWithin).toHaveBeenCalledTimes(1); // UN SEUL règlement
      expect(wallet.applyWithClient).not.toHaveBeenCalled();
    });
  });
});
