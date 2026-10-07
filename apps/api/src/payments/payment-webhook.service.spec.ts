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
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    /** Lien événement ↔ paiement (résolution par la référence CDP-…). */
    cardPayment: { findUnique: jest.Mock };
  };
  let provider: { webhookSecretFor: jest.Mock };
  let cards: {
    confirmPaid: jest.Mock;
    markExpired: jest.Mock;
    markFailed: jest.Mock;
    markProcessing: jest.Mock;
    applyChargeRefunded: jest.Mock;
    applyDispute: jest.Mock;
  };
  let audit: { record: jest.Mock };
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
      },
      cardPayment: {
        findUnique: jest.fn(async (args: { where: { reference?: string } }) =>
          args.where?.reference ? { id: 'cp1' } : null,
        ),
      },
    };
    provider = { webhookSecretFor: jest.fn(async () => SECRET) };
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
    };
    audit = { record: jest.fn(async () => undefined) };
    service = new PaymentWebhookService(
      prisma as never,
      provider as never,
      cards as never,
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
    expect(cards.markExpired).toHaveBeenCalledWith('cs_9');

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
    expect(cards.markProcessing).toHaveBeenCalledWith('cs_async', 'pi_async');
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
});
