import { ConflictException } from '@nestjs/common';
import { JwtPayload } from '../auth/types';
import { CheckoutService } from './checkout.service';

// Lot « paiement direct des commandes » — règlement d'une commande PAR SOLDE :
// le réglage admin est un GATE SERVEUR (409 `PAYMENT_METHOD_DISABLED` avant
// tout débit), un règlement par CARTE encore ouvert interdit tout nouveau
// débit (409 `CARD_PAYMENT_IN_PROGRESS` — jamais de double paiement), et une
// opération carte du client non résolue (GO revue §4 / C4.8) est refusée par
// la MÊME autorité de bloquage que la recharge et le règlement carte.
describe('CheckoutService.payOrderWithWallet — gate + anti-double-paiement', () => {
  const user: JwtPayload = {
    sub: 'u1',
    email: 'client@code.test',
    role: 'CLIENT' as JwtPayload['role'],
  };

  let paymentSettings: { assertEnabled: jest.Mock; capabilities: jest.Mock };
  let wallet: { applyWithClient: jest.Mock };
  let tx: {
    $queryRaw: jest.Mock;
    cardPayment: { findFirst: jest.Mock };
    walletTransaction: { findUnique: jest.Mock; findMany: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    order: { findUnique: jest.Mock };
    walletTransaction: { findUnique: jest.Mock };
  };
  let service: CheckoutService;

  beforeEach(() => {
    paymentSettings = {
      assertEnabled: jest.fn(async () => undefined),
      capabilities: jest.fn(async () => ({
        walletPaymentEnabled: true,
        cardOrderPaymentEnabled: true,
        cardTopupEnabled: true,
      })),
    };
    wallet = {
      applyWithClient: jest.fn(async () => ({ balanceCents: 3500, replayed: false })),
    };
    tx = {
      $queryRaw: jest.fn(async () => [
        {
          id: 'ord1',
          status: 'PENDING_PAYMENT',
          amountTtcCents: 1500,
          currency: 'USD',
          autoRenew: false,
          productId: 'prod1',
          renewsOrderId: null,
        },
      ]),
      cardPayment: { findFirst: jest.fn(async () => null) },
      walletTransaction: {
        findUnique: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
      },
    };
    prisma = {
      $transaction: jest.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
      order: {
        findUnique: jest.fn(async () => ({
          id: 'ord1',
          status: 'PENDING_PAYMENT',
          currency: 'USD',
          amountTtcCents: 1500,
          customer: { id: 'cust1', userId: 'u1', walletBalanceCents: 5000 },
        })),
      },
      walletTransaction: { findUnique: jest.fn(async () => null) },
    };

    service = new CheckoutService(
      prisma as never,
      { findPublicBySlug: jest.fn() } as never,
      { record: jest.fn(async () => undefined) } as never,
      { consume: jest.fn(() => ({ allowed: true, retryAfterMs: 0 })) } as never,
      { sendPlain: jest.fn() } as never,
      { provisionOrder: jest.fn(), syncAppLimits: jest.fn() } as never,
      { checkSubdomainAvailability: jest.fn() } as never,
      { operational: jest.fn(async () => true), resolveTracking: jest.fn(async () => null) } as never,
      wallet as never,
      paymentSettings as never,
    );
  });

  it('GATE : « règlement par solde » désactivé → 409 AVANT tout débit (aucune écriture)', async () => {
    paymentSettings.assertEnabled.mockRejectedValueOnce(
      new ConflictException({
        message: 'Règlement par solde désactivé.',
        code: 'PAYMENT_METHOD_DISABLED',
        capability: 'wallet',
      }),
    );

    const err = await service
      .payOrderWithWallet('ord1', user)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'PAYMENT_METHOD_DISABLED',
      capability: 'wallet',
    });
    expect(paymentSettings.assertEnabled).toHaveBeenCalledWith('wallet');
    // le gate est EXÉCUTÉ AVANT toute lecture ni transaction
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(wallet.applyWithClient).not.toHaveBeenCalled();
  });

  it('règlement par carte encore ouvert → 409 CARD_PAYMENT_IN_PROGRESS (zéro débit)', async () => {
    tx.cardPayment.findFirst.mockResolvedValue({ reference: 'CDP-AAAA11BB' });

    const err = await service
      .payOrderWithWallet('ord1', user)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'CARD_PAYMENT_IN_PROGRESS',
    });
    expect(String((err as ConflictException).message)).toContain('CDP-AAAA11BB');
    expect(paymentSettings.assertEnabled).toHaveBeenCalledWith('wallet');
    expect(wallet.applyWithClient).not.toHaveBeenCalled();
    expect(tx.cardPayment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orderId: 'ord1' }),
      }),
    );
  });

  it('§4 : alerte NEEDS_REVIEW ouverte (customer) → 409 « non résolu », zéro débit', async () => {
    // Garde orderId (cette commande) : rien de vivant ici ; garde CUSTOMER :
    // une alerte admin ouverte sur une opération du client bloque TOUT
    // nouveau règlement — même autorité que recharge/carte (C4.8).
    tx.cardPayment.findFirst.mockImplementation(
      async (args: { where: { customerId?: string } }) =>
        args?.where?.customerId
          ? {
              reference: 'CDP-BLOCK77',
              status: 'NEEDS_REVIEW',
              providerCallState: 'RESOLVED',
              interventionNeeded: true,
            }
          : null,
    );

    const err = await service
      .payOrderWithWallet('ord1', user)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(String((err as ConflictException).message)).toContain('non résolu');
    expect(String((err as ConflictException).message)).toContain('CDP-BLOCK77');
    expect(paymentSettings.assertEnabled).toHaveBeenCalledWith('wallet');
    // Aucun débit, aucune confirmation, aucun écriture.
    expect(wallet.applyWithClient).not.toHaveBeenCalled();
    expect(tx.walletTransaction.findUnique).not.toHaveBeenCalled();
    expect(tx.cardPayment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customerId: 'cust1' }),
      }),
    );
  });

  it('§4 : aucune opération bloquante → les gardes laissent passer, débit exécuté', async () => {
    // Confirmation remplacée par une SENTINELLE : le parcours prouve qu'il a
    // franchi les deux gardes et débité le solde, sans exécuter le cœur réel.
    jest
      .spyOn(
        service as never as {
          confirmOrderInTx: (...a: unknown[]) => Promise<never>;
        },
        'confirmOrderInTx',
      )
      .mockRejectedValueOnce(new ConflictException('SENTINELLE — confirmation atteinte'));

    const err = await service
      .payOrderWithWallet('ord1', user)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(String((err as ConflictException).message)).toContain('confirmation atteinte');
    expect(wallet.applyWithClient).toHaveBeenCalledTimes(1);
    expect(tx.cardPayment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customerId: 'cust1' }),
      }),
    );
  });
});
