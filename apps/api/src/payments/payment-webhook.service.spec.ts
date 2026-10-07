import { UnauthorizedException } from '@nestjs/common';
import { PaymentWebhookStatus, Prisma } from '@prisma/client';
import { PaymentWebhookService } from './payment-webhook.service';
import { signStripeWebhook } from './stripe-signature';

// GO Stripe §4 — réception webhook SANS réseau : signature obligatoire,
// déduplication durable, types gérés, acquittement par code HTTP.
type Row = Record<string, unknown>;

const SECRET = 'whsec_test_webhook_0123456789';

const eventOf = (type: string, object: Row): string =>
  JSON.stringify({ id: `evt_${type}_${Math.random().toString(16).slice(2)}`, type, data: { object } });

describe('PaymentWebhookService (GO §4 — webhook signé, idempotent)', () => {
  let prisma: {
    paymentWebhookEvent: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    /** Lien événement ↔ paiement (résolution par la référence CDP-…). */
    cardPayment: { findUnique: jest.Mock; findFirst: jest.Mock };
    /** Remboursement connu ? (GO P6 — idempotence par providerRef). */
    refund: { findFirst: jest.Mock };
  };
  let provider: { webhookSecretFor: jest.Mock; currentIdentity: jest.Mock };
  let cards: {
    confirmPaid: jest.Mock;
    markExpired: jest.Mock;
    markFailed: jest.Mock;
    markProcessing: jest.Mock;
    applyChargeRefunded: jest.Mock;
    applyDispute: jest.Mock;
    markFailureNotice: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let refunds: { applyProviderRefundStatus: jest.Mock };
  let service: PaymentWebhookService;
  /** Dernière ligne insérée (l'unicité réelle est `providerCode:eventId`). */
  let stored: Row | null;
  let rowsByKey: Map<string, Row>;
  let rowsById: Map<string, Row>;

  const post = (rawBody: string, header: string | undefined) =>
    service.handleSignedPayload({ providerCode: 'stripe', rawBody, header });

  beforeEach(() => {
    stored = null;
    rowsByKey = new Map();
    rowsById = new Map();
    prisma = {
      paymentWebhookEvent: {
        create: jest.fn(async (args: { data: Row }) => {
          const data = args.data;
          const key = `${String(data.providerCode)}:${String(data.eventId)}`;
          if (rowsByKey.has(key)) {
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint', {
              code: 'P2002',
              clientVersion: 'test',
            });
          }
          const row: Row = { id: `evtrow${rowsById.size + 1}`, ...data };
          rowsByKey.set(key, row);
          rowsById.set(String(row.id), row);
          stored = row;
          return row;
        }),
        findUnique: jest.fn(async (args: {
          where: { providerCode_eventId?: { providerCode: string; eventId: string } };
        }) => {
          const k = args.where.providerCode_eventId;
          if (!k) return null;
          return rowsByKey.get(`${k.providerCode}:${k.eventId}`) ?? null;
        }),
        update: jest.fn(async (args: { where: { id: string }; data: Row }) => {
          const row = rowsById.get(args.where.id);
          if (!row) return null;
          Object.assign(row, args.data);
          stored = row;
          return row;
        }),
        updateMany: jest.fn(async (args: { where: { id: string } }) => {
          const row = rowsById.get(args.where.id);
          if (row) row.attempts = Number(row.attempts ?? 1) + 1;
          return { count: row ? 1 : 0 };
        }),
        // File du rapprochement (GO P3).
        findMany: jest.fn(async () => [] as Row[]),
      },
      cardPayment: {
        findUnique: jest.fn(async (args: { where: { reference?: string } }) =>
          args.where?.reference ? { id: 'cp1' } : null,
        ),
        /** Cible de l'événement (GO P1/P3) : présente pour CE fournisseur. */
        findFirst: jest.fn(async () => ({ id: 'cp1' })),
      },
      refund: { findFirst: jest.fn(async () => null) },
    };
    provider = {
      webhookSecretFor: jest.fn(async () => SECRET),
      // Identité du fournisseur authentifié (GO P1/P4).
      currentIdentity: jest.fn(async () => 'acct_stripe_test'),
    };
    cards = {
      confirmPaid: jest.fn(async () => ({
        outcome: 'credited',
        reference: 'CDP-1',
        balanceCents: 5000,
      })),
      markExpired: jest.fn(async () => true),
      markFailed: jest.fn(async () => 'cp1'),
      markProcessing: jest.fn(async () => undefined),
      applyChargeRefunded: jest.fn(async () => null),
      applyDispute: jest.fn(async () => null),
      markFailureNotice: jest.fn(async () => null),
    };
    audit = { record: jest.fn(async () => undefined) };
    // GO P6 — issue des remboursements INTERNES (par providerRef).
    refunds = { applyProviderRefundStatus: jest.fn(async () => null) };
    service = new PaymentWebhookService(
      prisma as never,
      provider as never,
      cards as never,
      refunds as never,
      audit as never,
    );
  });

  it('refuse (401) une signature absente ou invalide — aucun traitement', async () => {
    const raw = eventOf('checkout.session.completed', { id: 'cs_1' });
    await expect(post(raw, undefined)).rejects.toThrow(UnauthorizedException);
    await expect(post(raw, 't=1,v1=bad')).rejects.toThrow(UnauthorizedException);
    expect(cards.confirmPaid).not.toHaveBeenCalled();
    expect(prisma.paymentWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('traite un événement signé valide et acquitte en 200', async () => {
    const raw = eventOf('checkout.session.completed', {
      id: 'cs_1',
      payment_status: 'paid',
      payment_intent: 'pi_1',
      amount_total: 5000,
      currency: 'usd',
      livemode: false,
    });
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(res.httpStatus).toBe(200);
    expect(res.body).toMatchObject({ received: true, result: 'processed' });
    expect(cards.confirmPaid).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionRef: 'cs_1',
        paymentRef: 'pi_1',
        amountTotalCents: 5000,
        source: 'webhook',
      }),
    );
    expect(stored).toMatchObject({
      status: PaymentWebhookStatus.PROCESSED,
      cardPaymentId: 'cp1',
    });
  });

  it('neutralise un DOUBLON (même eventId) sans second traitement', async () => {
    const raw = JSON.stringify({
      id: 'evt_dup',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', payment_status: 'paid' } },
    });
    const header = signStripeWebhook({ rawBody: raw, secret: SECRET });
    const first = await post(raw, header);
    expect(first.httpStatus).toBe(200);

    // Deuxième livraison : la création échoue sur l’unicité → doublon neutre.
    const second = await post(raw, header);
    expect(second.httpStatus).toBe(200);
    expect(second.body).toMatchObject({ duplicate: true });
    expect(cards.confirmPaid).toHaveBeenCalledTimes(1);
  });

  it('classe en IGNORED un type hors périmètre (200, aucun effet)', async () => {
    const raw = eventOf('customer.created', { id: 'cus_1' });
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(res.httpStatus).toBe(200);
    expect(res.body).toMatchObject({ result: 'ignored' });
    expect(cards.confirmPaid).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ status: PaymentWebhookStatus.IGNORED });
  });

  it('mappe expiration / échec / annulation sans crédit', async () => {
    const exp = eventOf('checkout.session.expired', { id: 'cs_9' });
    await post(exp, signStripeWebhook({ rawBody: exp, secret: SECRET }));
    expect(cards.markExpired).toHaveBeenCalledWith('cs_9', 'stripe');

    const fail = eventOf('payment_intent.payment_failed', {
      id: 'pi_9',
      last_payment_error: { message: 'Refusé' },
    });
    await post(fail, signStripeWebhook({ rawBody: fail, secret: SECRET }));
    expect(cards.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRef: 'pi_9', status: 'FAILED' }),
    );

    const cancel = eventOf('payment_intent.canceled', { id: 'pi_10' });
    await post(cancel, signStripeWebhook({ rawBody: cancel, secret: SECRET }));
    expect(cards.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRef: 'pi_10', status: 'CANCELED' }),
    );
    expect(cards.confirmPaid).not.toHaveBeenCalled();
  });

  it('enregistre un paiement asynchrone non payé en PROCESSING (aucun crédit)', async () => {
    const raw = eventOf('checkout.session.completed', {
      id: 'cs_async',
      payment_status: 'unpaid',
      payment_intent: 'pi_async',
    });
    await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(cards.markProcessing).toHaveBeenCalledWith('cs_async', 'pi_async', 'stripe');
    expect(cards.confirmPaid).not.toHaveBeenCalled();
  });

  it('répond 500 (rejeu prestataire) si le traitement échoue et journalise FAILED', async () => {
    cards.confirmPaid.mockRejectedValueOnce(new Error('PG indisponible'));
    const raw = eventOf('checkout.session.completed', { id: 'cs_2', payment_status: 'paid' });
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(res.httpStatus).toBe(500);
    expect(stored).toMatchObject({ status: PaymentWebhookStatus.FAILED });

    // Rejeu du MÊME événement : l’incréments d’essais est conservé, on traite à nouveau.
    cards.confirmPaid.mockResolvedValueOnce({
      outcome: 'credited',
      reference: 'CDP-1',
      balanceCents: 5000,
    });
    const retry = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(retry.httpStatus).toBe(200);
    expect(prisma.paymentWebhookEvent.updateMany).toHaveBeenCalled();
  });

  it('refuse un corps JSON illisible ou incomplet (400)', async () => {
    const broken = '{pas-du-json';
    await expect(
      post(broken, signStripeWebhook({ rawBody: broken, secret: SECRET })),
    ).rejects.toThrow('JSON');
    const raw = JSON.stringify({ data: {} });
    await expect(
      post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET })),
    ).rejects.toThrow('incomplet');
  });

  it('répond 503 si aucun secret webhook n’est configuré (refus net)', async () => {
    provider.webhookSecretFor.mockRejectedValue(new Error('Secret webhook non configuré'));
    const res = await service.handleSignedPayload({
      providerCode: 'stripe',
      rawBody: '{}',
      header: undefined,
    });
    expect(res.httpStatus).toBe(503);
    expect(res.body).toMatchObject({ reason: 'webhook_secret_not_configured' });
  });

  // ── GO P7 — l'intent départage : jamais de terminal abusif ──────────────

  it('P7 : échec sur intent encore VIVANT → note l’erreur sans verrouiller l’état', async () => {
    const raw = eventOf('payment_intent.payment_failed', {
      id: 'pi_live',
      status: 'requires_payment_method',
      last_payment_error: { message: 'Refusé' },
    });
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(res.httpStatus).toBe(200);
    expect(cards.markFailureNotice).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRef: 'pi_live', code: 'payment_failed' }),
    );
    expect(cards.markFailed).not.toHaveBeenCalled();
    expect(cards.confirmPaid).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ status: PaymentWebhookStatus.PROCESSED });
  });

  it('P7 : intent ANNULÉ après échec → CANCELED terminal (jamais FAILED)', async () => {
    const raw = eventOf('payment_intent.payment_failed', {
      id: 'pi_cancel',
      status: 'canceled',
      last_payment_error: { message: 'Refusé' },
    });
    await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(cards.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentRef: 'pi_cancel',
        status: expect.stringContaining('CANCELED'),
      }),
    );
    expect(cards.markFailureNotice).not.toHaveBeenCalled();
  });

  it('P7 : sans champ status (simulateur) → échec tranché FAILED (comportement D1)', async () => {
    const raw = eventOf('payment_intent.payment_failed', {
      id: 'pi_sim',
      last_payment_error: { message: 'Refusé' },
    });
    await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(cards.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentRef: 'pi_sim',
        status: expect.stringContaining('FAILED'),
      }),
    );
    expect(cards.markFailureNotice).not.toHaveBeenCalled();
  });

  // ── GO P3 — un événement géré non rattaché n’est JAMAIS « ignoré » ──────

  it('P3 : rapproche l’événement à échéance (replay borné, cible réattachable)', async () => {
    const payload = JSON.parse(
      eventOf('checkout.session.expired', { id: 'cs_orphan_2' }),
    ) as Row;
    prisma.paymentWebhookEvent.findMany.mockResolvedValue([
      {
        id: 'evtrow-reconcile',
        providerCode: 'stripe',
        payload,
        attempts: 1,
        reconcileAt: new Date(Date.now() - 1000),
      },
    ]);
    // Aucune cible connue pour ce fournisseur → encore à rapprocher.
    prisma.cardPayment.findFirst.mockResolvedValue(null);
    provider.currentIdentity.mockResolvedValue('acct_stripe_test');
    const out = await service.reconcileDue(5);
    expect(out).toEqual({ replayed: 1, attached: 0 });
    expect(provider.currentIdentity).toHaveBeenCalledWith('stripe');
    expect(cards.markExpired).not.toHaveBeenCalled();
    expect(prisma.paymentWebhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evtrow-reconcile' },
        data: expect.objectContaining({
          status: PaymentWebhookStatus.RECEIVED,
          reconcileAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.paymentWebhookEvent.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PaymentWebhookStatus.IGNORED }),
      }),
    );
  });

  it('P3 : la file ne réclame que les événements RECEIVED arrivés à échéance', async () => {
    prisma.paymentWebhookEvent.findMany.mockResolvedValue([]);
    const out = await service.reconcileDue(3);
    expect(out).toEqual({ replayed: 0, attached: 0 });
    expect(prisma.paymentWebhookEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: PaymentWebhookStatus.RECEIVED }),
        take: 3,
      }),
    );
  });

  it('P3 : un événement sans cible est conservé en RECEIVED avec une échéance (backoff)', async () => {
    const raw = eventOf('checkout.session.expired', { id: 'cs_orphan' });
    // Aucun paiement connu pour CE fournisseur → rapprochement, pas d'IGNORED.
    prisma.cardPayment.findFirst.mockResolvedValue(null);
    await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(cards.markExpired).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ status: PaymentWebhookStatus.RECEIVED });
    expect(stored?.reconcileAt).toBeInstanceOf(Date);
    expect(stored?.status).not.toBe(PaymentWebhookStatus.IGNORED);
  });

  // ── GO P1 — identité de la source absente : traitable = 503, sinon neutre ─

  it('P1 : identité marchande indisponible sur un type TRAITÉ → 503, aucun effet', async () => {
    provider.currentIdentity.mockRejectedValue(new Error('Identité marchande non établie'));
    const raw = eventOf('checkout.session.expired', { id: 'cs_noid' });
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(res.httpStatus).toBe(503);
    expect(res.body).toMatchObject({ reason: 'provider_identity_unavailable' });
    expect(cards.markExpired).not.toHaveBeenCalled();
    expect(cards.confirmPaid).not.toHaveBeenCalled();
  });

  it('P1 : identité indisponible sur un type HORS PÉRIMÈTRE → 200 IGNORED (aucun effet)', async () => {
    provider.currentIdentity.mockRejectedValue(new Error('Identité marchande non établie'));
    const raw = eventOf('customer.updated', { id: 'cus_9' });
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(res.httpStatus).toBe(200);
    expect(res.body).toMatchObject({ result: 'ignored' });
    expect(stored).toMatchObject({ status: PaymentWebhookStatus.IGNORED });
    expect(cards.confirmPaid).not.toHaveBeenCalled();
  });
});
