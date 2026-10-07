import { ConflictException } from '@nestjs/common';
import {
  CardPayment,
  CardPaymentStatus,
  Refund,
  RefundKind,
  RefundStatus,
  WalletTransactionType,
} from '@prisma/client';
import { JwtPayload } from '../auth/types';
import { CardRefundsService } from './card-refunds.service';

// GO Stripe §6 — remboursement d’une RECHARGE vers la CARTE : plafond cumulé,
// idempotence, refus si le crédit est déjà dépensé (jamais de dette implicite),
// compensation si le prestataire refuse, reprise possible si le réseau manque.
type Row = Record<string, unknown>;

const actor: JwtPayload = {
  sub: 'admin-1',
  email: 'admin@code.test',
  role: 'ADMIN' as JwtPayload['role'],
};

const payment = (over: Row = {}): CardPayment =>
  ({
    id: 'cp1',
    reference: 'CDP-AAAA11BB',
    customerId: 'cust1',
    kind: 'TOPUP',
    status: CardPaymentStatus.SUCCEEDED,
    amountCents: 5000,
    currency: 'USD',
    providerCode: 'simulated',
    environment: 'test',
    merchantAccount: 'sim_merchant_local',
    livemode: false,
    providerSessionRef: 'cs_sim_1',
    providerPaymentRef: 'pi_sim_1',
    checkoutUrl: '/pay',
    idempotencyKey: 'idem-12345678',
    walletTransactionId: 'wtx1',
    refundedCents: 0,
    failureCode: null,
    failureMessage: null,
    disputedAt: null,
    interventionNeeded: false,
    interventionReason: null,
    expiresAt: null,
    paidAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as CardPayment;

const refundRow = (over: Row = {}): Refund =>
  ({
    id: 'rfd1',
    orderId: null,
    invoiceId: null,
    cardPaymentId: 'cp1',
    kind: RefundKind.EXTERNAL_CARD,
    status: RefundStatus.PENDING,
    amountCents: 2000,
    currency: 'USD',
    reason: 'GO test',
    issueCreditNote: false,
    idempotencyKey: 'idem-refund-123456',
    walletTransactionId: null,
    creditNoteInvoiceId: null,
    providerRef: null,
    createdByUserId: 'admin-1',
    createdByEmail: 'admin@code.test',
    failureReason: null,
    processedAt: null,
    createdAt: new Date(),
    ...over,
  }) as Refund;

describe('CardRefundsService (GO §6 — recharge → carte)', () => {
  let tx: {
    $queryRaw: jest.Mock;
    refund: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      aggregate: jest.Mock;
    };
    walletTransaction: { findUnique: jest.Mock };
    cardPayment: { findUnique: jest.Mock; update: jest.Mock };
    customer: { update: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    refund: { findUnique: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock };
    cardPayment: { findUnique: jest.Mock };
  };
  let wallet: { applyWithClient: jest.Mock };
  let connector: { createRefund: jest.Mock };
  let provider: { resolve: jest.Mock };
  let audit: { record: jest.Mock };
  let service: CardRefundsService;

  let lockPayment: CardPayment;
  let lockCustomer: { walletBalanceCents: number; walletCurrency: string; email: string };
  let replayRow: Refund | null;
  let lastRow: Refund;
  let reservedSum: number | null;

  beforeEach(() => {
    lockPayment = payment();
    lockCustomer = { walletBalanceCents: 5000, walletCurrency: 'USD', email: 'c@d' };
    replayRow = null;
    lastRow = refundRow();
    reservedSum = null;

    tx = {
      $queryRaw: jest.fn((strings: TemplateStringsArray) => {
        const sql = strings.join(' ? ');
        if (sql.includes('FROM "CardPayment"')) return [lockPayment];
        if (sql.includes('FROM "Customer"')) return [lockCustomer];
        return [];
      }),
      refund: {
        findUnique: jest.fn((args: { where: Row }) =>
          args.where?.idempotencyKey !== undefined ? replayRow : lastRow,
        ),
        create: jest.fn((args: { data: Row }) => {
          lastRow = refundRow({ ...args.data });
          return lastRow;
        }),
        update: jest.fn((args: { data: Row }) => {
          lastRow = refundRow({ ...lastRow, ...args.data });
          return lastRow;
        }),
        updateMany: jest.fn((args: { data: Row }) => {
          lastRow = refundRow({ ...lastRow, ...args.data });
          return { count: 1 };
        }),
        aggregate: jest.fn(async () => ({ _sum: { amountCents: reservedSum } })),
      },
      walletTransaction: {
        findUnique: jest.fn(async () => ({ id: 'wtx-refund-1' })),
      },
      cardPayment: {
        findUnique: jest.fn(async () => ({ customerId: 'cust1' })),
        update: jest.fn((args: { data: Row }) => ({
          ...lockPayment,
          ...args.data,
        })),
      },
      customer: { update: jest.fn() },
    };
    prisma = {
      $transaction: jest.fn(async (fn: unknown) =>
        typeof fn === 'function' ? (fn as (t: typeof tx) => unknown)(tx) : null,
      ),
      refund: {
        findUnique: jest.fn(async (args: { where: Row }) =>
          args.where?.idempotencyKey !== undefined ? replayRow : lastRow,
        ),
        findMany: jest.fn(async () => [lastRow]),
        findFirst: jest.fn(async () => null),
      },
      cardPayment: {
        findUnique: jest.fn(async () => lockPayment),
      },
    };
    wallet = { applyWithClient: jest.fn(async () => ({ balanceCents: 3000, replayed: false })) };
    connector = {
      createRefund: jest.fn(async () => ({
        providerRef: 're_1',
        status: 'succeeded',
        amountCents: 2000,
        failureReason: null,
      })),
    };
    provider = {
      resolve: jest.fn(async () => ({
        settingId: 'set1',
        code: 'simulated',
        displayName: 'Simulateur',
        environment: 'test',
        merchantAccount: 'sim',
        currencies: ['USD'],
        connector,
      })),
    };
    audit = { record: jest.fn(async () => undefined) };
    service = new CardRefundsService(
      prisma as never,
      wallet as never,
      provider as never,
      audit as never,
    );
  });

  const request = (amountCents = 2000, idempotencyKey = 'idem-refund-123456') =>
    service.createTopupRefund(
      { cardPaymentId: 'cp1', amountCents, reason: 'GO test', idempotencyKey },
      actor,
    );

  it('refuse un montant supérieur au plafond cumulé du paiement', async () => {
    lockPayment = payment({ refundedCents: 4000 });
    await expect(request(2000)).rejects.toThrow(ConflictException);
    await expect(request(2000)).rejects.toThrow('Plafond de remboursement');
    expect(wallet.applyWithClient).not.toHaveBeenCalled();
    expect(connector.createRefund).not.toHaveBeenCalled();
  });

  it('compte les intentions en cours (réservations) dans le plafond', async () => {
    reservedSum = 3500;
    await expect(request(2000)).rejects.toThrow('Plafond de remboursement');
    expect(connector.createRefund).not.toHaveBeenCalled();
  });

  it('refuse si le crédit de recharge a déjà été dépensé (aucune dette implicite)', async () => {
    lockCustomer = { walletBalanceCents: 500, walletCurrency: 'USD', email: 'c@d' };
    await expect(request(2000)).rejects.toThrow(ConflictException);
    await expect(request(2000)).rejects.toThrow('déjà été dépensé');
    expect(wallet.applyWithClient).not.toHaveBeenCalled();
    expect(connector.createRefund).not.toHaveBeenCalled();
  });

  it('refuse sur un paiement non encaissé', async () => {
    lockPayment = payment({ status: CardPaymentStatus.CREATED });
    await expect(request()).rejects.toThrow('seul un paiement encaissé');
  });

  it('débite le crédit, appelle le prestataire puis confirme (crédit une seule fois)', async () => {
    const view = await request();
    expect(view.status).toBe(RefundStatus.SUCCEEDED);
    expect(view.providerRef).toBe('re_1');
    // Lien wallet → remboursement enregistré (traçabilité admin).
    expect(view.walletTransactionId).toBe('wtx-refund-1');
    expect(wallet.applyWithClient).toHaveBeenCalledTimes(1);
    expect(wallet.applyWithClient).toHaveBeenCalledWith(
      expect.anything(),
      'cust1',
      expect.objectContaining({
        amountCents: 2000,
        type: WalletTransactionType.DEBIT,
        idempotencyKey: `cardrefund:${lastRow.id}`,
      }),
      'debit',
    );
    // `reference` ABSENTE de l'opération : l'unicité (colonne UNIQUE) est
    // portée par le crédit de recharge, jamais réutilisée pour un débit.
    expect('reference' in (wallet.applyWithClient.mock.calls[0][2] as Row)).toBe(
      false,
    );
    expect(connector.createRefund).toHaveBeenCalledWith({
      paymentRef: 'pi_sim_1',
      amountCents: 2000,
      idempotencyKey: 'idem-refund-123456',
    });
    expect(tx.cardPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          refundedCents: 2000,
          status: CardPaymentStatus.PARTIALLY_REFUNDED,
        }),
      }),
    );
  });

  it('bascule REFUNDED quand le paiement est intégralement remboursé', async () => {
    lockPayment = payment({ refundedCents: 3000 });
    await request(2000);
    expect(tx.cardPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          refundedCents: 5000,
          status: CardPaymentStatus.REFUNDED,
        }),
      }),
    );
  });

  it('rejoue sans aucun second effet pour la même clé d’idempotence', async () => {
    replayRow = refundRow({ status: RefundStatus.SUCCEEDED, providerRef: 're_1' });
    const view = await request();
    expect(view.id).toBe('rfd1');
    expect(tx.refund.create).not.toHaveBeenCalled();
    expect(wallet.applyWithClient).not.toHaveBeenCalled();
    expect(connector.createRefund).not.toHaveBeenCalled();
  });

  it('garde le remboursement PENDING ré-exploitable si le réseau prestataire manque', async () => {
    connector.createRefund.mockRejectedValue(new Error('ECONNRESET'));
    const view = await request();
    expect(view.status).toBe(RefundStatus.PENDING);
    expect(view.pendingProviderCall).toBe(true);
    expect(view.failureReason).toBeNull();
    // Aucune compensation : la réservation wallet reste (reprise possible).
    expect(wallet.applyWithClient).toHaveBeenCalledTimes(1);
    expect(tx.cardPayment.update).not.toHaveBeenCalled();
  });

  it('compense (recrédit) et marque FAILED si le prestataire refuse', async () => {
    connector.createRefund.mockResolvedValue({
      providerRef: 're_fail',
      status: 'failed',
      amountCents: 2000,
      failureReason: 'Carte non remboursable',
    });
    const view = await request();
    expect(view.status).toBe(RefundStatus.FAILED);
    expect(view.failureReason).toContain('Carte non remboursable');
    expect(wallet.applyWithClient).toHaveBeenCalledTimes(2);
    expect(wallet.applyWithClient).toHaveBeenLastCalledWith(
      expect.anything(),
      'cust1',
      expect.objectContaining({
        type: WalletTransactionType.CREDIT,
        idempotencyKey: `cardrefund-back:${lastRow.id}`,
      }),
      'credit',
    );
    expect(tx.cardPayment.update).not.toHaveBeenCalled();
  });

  it('rejoue un appel prestataire interrompu avec la même clé (retry)', async () => {
    lastRow = refundRow({ status: RefundStatus.PENDING, providerRef: null });
    prisma.refund.findUnique.mockImplementation(async (args: { where: Row }) =>
      args.where?.idempotencyKey !== undefined ? replayRow : lastRow,
    );
    const view = await service.retryProviderCall('rfd1', actor);
    expect(connector.createRefund).toHaveBeenCalledTimes(1);
    expect(view.providerRef).toBe('re_1');
    expect(view.status).toBe(RefundStatus.SUCCEEDED);
  });

  it('refuse le retry sur un remboursement déjà conclu', async () => {
    lastRow = refundRow({ status: RefundStatus.SUCCEEDED, providerRef: 're_1' });
    await expect(service.retryProviderCall('rfd1', actor)).rejects.toThrow(
      ConflictException,
    );
  });

  it('annule une intention non conclue avec recrédit (aucun appel prestataire)', async () => {
    lastRow = refundRow({ status: RefundStatus.PENDING, providerRef: null });
    const view = await service.cancelRefund('rfd1', actor, 'Erreur opérateur');
    expect(view.status).toBe(RefundStatus.FAILED);
    expect(connector.createRefund).not.toHaveBeenCalled();
    expect(wallet.applyWithClient).toHaveBeenLastCalledWith(
      expect.anything(),
      'cust1',
      expect.objectContaining({ type: WalletTransactionType.CREDIT }),
      'credit',
    );
  });
});
