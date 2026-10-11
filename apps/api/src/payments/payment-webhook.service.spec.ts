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
  let provider: {
    /** GO V3 §3 — UNE lecture (secret + identité source du même snapshot). */
    webhookAuthContext: jest.Mock;
  };
  let cards: {
    confirmPaid: jest.Mock;
    markExpired: jest.Mock;
    markFailed: jest.Mock;
    markProcessing: jest.Mock;
    applyChargeRefunded: jest.Mock;
    applyDispute: jest.Mock;
    markFailureNotice: jest.Mock;
    recordRefundObservation: jest.Mock;
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
          where: {
            providerCode_eventId?: { providerCode: string; eventId: string };
            id?: string;
          };
        }) => {
          // Relecture par id (V6 §1 — relecture de l'identité enregistrée).
          if (args.where.id) return rowsById.get(args.where.id) ?? null;
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
        updateMany: jest.fn(async (args: {
          where: { id: string; merchantAccount?: null; status?: unknown };
          data?: Row;
        }) => {
          const row = rowsById.get(args.where.id);
          if (!row) return { count: 0 };
          // CAS de complétion d'identité (V6 §1) : borné `merchantAccount: null`.
          if (args.where.merchantAccount === null) {
            if (row.merchantAccount != null) return { count: 0 }; // CAS perdu (déjà identité)
            if (args.data) Object.assign(row, args.data);
            stored = row;
            return { count: 1 };
          }
          // Incrément d'attempts (rejeu).
          row.attempts = Number(row.attempts ?? 1) + 1;
          return { count: 1 };
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
      // Identité du fournisseur authentifié (GO P1/P4 + V3 §3) : secret et
      // identité proviennent d'UN même snapshot de configuration.
      webhookAuthContext: jest.fn(async () => ({
        secret: SECRET,
        identity: {
          settingId: 'set_stripe_1',
          configVersion: new Date('2026-10-12T00:00:00.000Z'),
          merchantAccount: 'acct_stripe_test',
        },
        identityError: null,
      })),
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
      // GO revue §1 — observation d'identité (union) pour un remboursement
      // externe succeeded non rattaché.
      recordRefundObservation: jest.fn(async () => null),
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
    provider.webhookAuthContext.mockRejectedValue(new Error('Secret webhook non configuré'));
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
        // GO V3 §3 — identité SOURCE DURABLE capturée à la réception.
        merchantAccount: 'acct_stripe_test',
        payload,
        attempts: 1,
        reconcileAt: new Date(Date.now() - 1000),
      },
    ]);
    // Aucune cible connue pour ce fournisseur → encore à rapprocher.
    prisma.cardPayment.findFirst.mockResolvedValue(null);
    const out = await service.reconcileDue(5);
    expect(out).toEqual({ replayed: 1, attached: 0 });
    // GO V3 §3 — le rejeu ne lit JAMAIS la configuration courante.
    expect(provider.webhookAuthContext).not.toHaveBeenCalled();
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

  // ── GO revue §3a — les RECEIVED SANS échéance (crash) sont repris ────────

  it('§3a : la file prend aussi les RECEIVED sans échéance (après grâce 60 s)', async () => {
    prisma.paymentWebhookEvent.findMany.mockResolvedValue([]);
    await service.reconcileDue(7);
    expect(prisma.paymentWebhookEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: PaymentWebhookStatus.RECEIVED,
          OR: expect.arrayContaining([
            expect.objectContaining({ reconcileAt: { lte: expect.any(Date) } }),
            expect.objectContaining({
              reconcileAt: null,
              receivedAt: { lte: expect.any(Date) },
            }),
          ]),
        }),
      }),
    );
  });

  it('§3a : l’orphelin (RECEIVED, reconcileAt null, reçu depuis) est réellement rejoué', async () => {
    const payload = JSON.parse(
      eventOf('checkout.session.expired', { id: 'cs_orphan_stale' }),
    ) as Row;
    prisma.paymentWebhookEvent.findMany.mockResolvedValue([
      {
        id: 'evtrow-stale',
        providerCode: 'stripe',
        merchantAccount: 'acct_stripe_test',
        payload,
        attempts: 0,
        reconcileAt: null,
        receivedAt: new Date(Date.now() - 5 * 60_000),
      },
    ]);
    // Aucune cible connue pour ce fournisseur → re-classement RECEIVED + échéance.
    prisma.cardPayment.findFirst.mockResolvedValue(null);
    const out = await service.reconcileDue(5);
    expect(out).toEqual({ replayed: 1, attached: 0 });
    expect(prisma.paymentWebhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evtrow-stale' },
        data: expect.objectContaining({
          status: PaymentWebhookStatus.RECEIVED,
          reconcileAt: expect.any(Date),
        }),
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
    provider.webhookAuthContext.mockResolvedValue({
      secret: SECRET,
      identity: null,
      identityError: 'Identité marchande non établie',
    });
    const raw = eventOf('checkout.session.expired', { id: 'cs_noid' });
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(res.httpStatus).toBe(503);
    expect(res.body).toMatchObject({ reason: 'provider_identity_unavailable' });
    expect(cards.markExpired).not.toHaveBeenCalled();
    expect(cards.confirmPaid).not.toHaveBeenCalled();
  });

  it('P1 : identité indisponible sur un type HORS PÉRIMÈTRE → 200 IGNORED (aucun effet)', async () => {
    provider.webhookAuthContext.mockResolvedValue({
      secret: SECRET,
      identity: null,
      identityError: 'Identité marchande non établie',
    });
    const raw = eventOf('customer.updated', { id: 'cus_9' });
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(res.httpStatus).toBe(200);
    expect(res.body).toMatchObject({ result: 'ignored' });
    expect(stored).toMatchObject({ status: PaymentWebhookStatus.IGNORED });
    expect(cards.confirmPaid).not.toHaveBeenCalled();
  });

  // ── GO §2 — identité d'ORIGINE conservée (fournisseur + compte + env) ────

  it('§2 : origine COMPATIBLE (compte + environnement) → traitement normal', async () => {
    prisma.cardPayment.findFirst.mockResolvedValue({
      id: 'cp1',
      providerCode: 'stripe',
      merchantAccount: 'acct_stripe_test',
      environment: 'test',
    });
    const raw = eventOf('checkout.session.expired', { id: 'cs_ok' });
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(res.httpStatus).toBe(200);
    expect(res.body).toMatchObject({ result: 'processed' });
    expect(cards.markExpired).toHaveBeenCalledWith('cs_ok', 'stripe');
    expect(stored).toMatchObject({ status: PaymentWebhookStatus.PROCESSED, cardPaymentId: 'cp1' });
  });

  it('§2 : compte marchand d’origine ≠ identité courante → IGNORED, AUCUN effet', async () => {
    prisma.cardPayment.findFirst.mockResolvedValue({
      id: 'cp1',
      providerCode: 'stripe',
      merchantAccount: 'acct_ancien',
      environment: 'test',
    });
    const raw = eventOf('charge.refunded', {
      id: 'ch_ancien',
      payment_intent: 'pi_ancien',
      amount_refunded: 1000,
      refunds: { data: [{ id: 're_1' }] },
    });
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(res.httpStatus).toBe(200);
    expect(res.body).toMatchObject({ result: 'ignored' });
    expect(cards.applyChargeRefunded).not.toHaveBeenCalled();
    expect(cards.recordRefundObservation).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ status: PaymentWebhookStatus.IGNORED, cardPaymentId: 'cp1' });
    expect(String(stored?.error)).toContain('origine refusée');
    expect(String(stored?.error)).toContain('acct_ancien');
  });

  it('§2 : événement LIVE en mode test → refus explicite (aucun effet)', async () => {
    prisma.cardPayment.findFirst.mockResolvedValue({
      id: 'cp1',
      providerCode: 'stripe',
      merchantAccount: 'acct_stripe_test',
      environment: 'test',
    });
    const raw = JSON.stringify({
      id: 'evt_live_1',
      type: 'checkout.session.expired',
      livemode: true,
      data: { object: { id: 'cs_live' } },
    });
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(res.httpStatus).toBe(200);
    expect(res.body).toMatchObject({ result: 'ignored' });
    expect(cards.markExpired).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ status: PaymentWebhookStatus.IGNORED, cardPaymentId: 'cp1' });
    expect(String(stored?.error)).toContain('LIVE');
  });

  it('§2 : remboursement CONNU mais origine divergente → AUCUNE répercussion', async () => {
    prisma.refund.findFirst.mockResolvedValue({
      id: 'rf1',
      cardPaymentId: 'cp1',
      cardPayment: {
        id: 'cp1',
        providerCode: 'stripe',
        merchantAccount: 'acct_ancien',
        environment: 'test',
      },
    });
    const raw = eventOf('refund.updated', {
      id: 're_connu',
      status: 'succeeded',
      payment_intent: 'pi_1',
      amount: 500,
    });
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(res.httpStatus).toBe(200);
    expect(res.body).toMatchObject({ result: 'ignored' });
    expect(refunds.applyProviderRefundStatus).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ status: PaymentWebhookStatus.IGNORED, cardPaymentId: 'cp1' });
    expect(String(stored?.error)).toContain('origine refusée');
  });

  // ── GO V3 §3 — identité source DURABLE (capture + rejeu sans config courante) ──

  it('V3 §3 : capture DURABLE de l’identité source à la réception', async () => {
    const raw = eventOf('checkout.session.expired', { id: 'cs_v3_capture' });
    await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(stored).toMatchObject({
      merchantAccount: 'acct_stripe_test',
      sourceSettingId: 'set_stripe_1',
      sourceConfigVersion: new Date('2026-10-12T00:00:00.000Z'),
    });
  });

  it('V3 §3 : rotation de configuration APRÈS réception → le rejeu reste sous l’identité D’ORIGINE', async () => {
    // 1) Réception sous le compte A (cible absente → échéance de rejeu).
    provider.webhookAuthContext.mockResolvedValue({
      secret: SECRET,
      identity: {
        settingId: 'set_stripe_1',
        configVersion: new Date('2026-10-12T00:00:00.000Z'),
        merchantAccount: 'acct_A',
      },
      identityError: null,
    });
    prisma.cardPayment.findFirst.mockResolvedValue(null);
    const raw = eventOf('checkout.session.expired', { id: 'cs_rot' });
    await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    const row = stored as Row;
    expect(row).toMatchObject({ merchantAccount: 'acct_A' });

    // 2) Rotation : la configuration COURANTE expose désormais le compte B.
    provider.webhookAuthContext.mockClear(); // la réception ci-dessus l'a lue
    provider.webhookAuthContext.mockResolvedValue({
      secret: SECRET,
      identity: {
        settingId: 'set_stripe_1',
        configVersion: new Date('2026-10-12T01:00:00.000Z'),
        merchantAccount: 'acct_B',
      },
      identityError: null,
    });

    // 3) Le rejeu rejoue sous A (identité persistée) : la cible « A » est
    //    applicable (traitée), JAMAIS refusée au profit de B.
    prisma.cardPayment.findFirst.mockResolvedValue({
      id: 'cp1',
      providerCode: 'stripe',
      merchantAccount: 'acct_A',
      environment: 'test',
    });
    prisma.paymentWebhookEvent.findMany.mockResolvedValue([
      {
        ...row,
        payload: JSON.parse(raw) as Row,
        attempts: 1,
        reconcileAt: new Date(Date.now() - 1000),
      },
    ]);
    const out = await service.reconcileDue(5);
    expect(out).toEqual({ replayed: 1, attached: 1 });
    expect(cards.markExpired).toHaveBeenCalledWith('cs_rot', 'stripe');
    // Aucune relecture de la configuration courante pendant le rejeu.
    expect(provider.webhookAuthContext).not.toHaveBeenCalled();
  });

  it('V3 §3 : événement SANS identité persistée (antérieur au lot) → FAILED visible, jamais d’origine inventée', async () => {
    const payload = JSON.parse(
      eventOf('checkout.session.expired', { id: 'cs_legacy' }),
    ) as Row;
    prisma.paymentWebhookEvent.findMany.mockResolvedValue([
      {
        id: 'evtrow-legacy',
        providerCode: 'stripe',
        merchantAccount: null, // ligne antérieure à la capture d'identité
        payload,
        attempts: 1,
        reconcileAt: new Date(Date.now() - 1000),
      },
    ]);
    const out = await service.reconcileDue(5);
    expect(out).toEqual({ replayed: 1, attached: 0 });
    expect(cards.markExpired).not.toHaveBeenCalled();
    expect(prisma.paymentWebhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evtrow-legacy' },
        data: expect.objectContaining({
          status: PaymentWebhookStatus.FAILED,
          reconcileAt: null,
          error: expect.stringContaining('identité source absente'),
        }),
      }),
    );
  });

  // ── GO V5 §2 — identité atomique + reprise sans réattribution ────────────

  it('V5 §2 : échec de persistance → AUCUN dispatch, exception propagée (500 = rejeu prestataire)', async () => {
    prisma.paymentWebhookEvent.create.mockRejectedValueOnce(
      new Error('db indisponible'),
    );
    const raw = eventOf('checkout.session.completed', {
      id: 'cs_v5_persist',
      payment_status: 'paid',
      payment_intent: 'pi_v5',
      amount_total: 5000,
      currency: 'usd',
      livemode: false,
    });
    // L'exception remonte du service (le contrôleur la propage → 500 Nest).
    await expect(post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }))).rejects.toThrow(
      'db indisponible',
    );
    // Zéro effet métier : ni dispatch, ni écriture de résultat, ni lien.
    expect(cards.confirmPaid).not.toHaveBeenCalled();
    expect(cards.markExpired).not.toHaveBeenCalled();
    expect(cards.markFailed).not.toHaveBeenCalled();
    expect(cards.markProcessing).not.toHaveBeenCalled();
    expect(prisma.paymentWebhookEvent.update).not.toHaveBeenCalled();
    expect(prisma.paymentWebhookEvent.updateMany).not.toHaveBeenCalled();
  });

  it('V5 §2 : interruption APRÈS inscription durable → reprise SANS rélecture de config (identité d’origine)', async () => {
    // 1) Réception sous le compte A : l'événement est inscrit (identité A),
    //    puis le dispatch échoue (interruption simulée) → 500 = rejeu.
    provider.webhookAuthContext.mockResolvedValue({
      secret: SECRET,
      identity: {
        settingId: 'set_stripe_1',
        configVersion: new Date('2026-10-12T00:00:00.000Z'),
        merchantAccount: 'acct_A',
      },
      identityError: null,
    });
    cards.confirmPaid.mockRejectedValueOnce(new Error('interruption'));
    const raw = JSON.stringify({
      id: 'evt_v5_resume',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_v5_resume',
          payment_status: 'paid',
          payment_intent: 'pi_v5_resume',
          amount_total: 5000,
          currency: 'usd',
          livemode: false,
        },
      },
    });
    const header = signStripeWebhook({ rawBody: raw, secret: SECRET });
    const first = await post(raw, header);
    expect(first.httpStatus).toBe(500);
    expect(stored).toMatchObject({
      status: PaymentWebhookStatus.FAILED,
      merchantAccount: 'acct_A',
    });

    // 2) Rotation : la configuration COURANTE expose désormais le compte B.
    provider.webhookAuthContext.mockResolvedValue({
      secret: SECRET,
      identity: {
        settingId: 'set_stripe_1',
        configVersion: new Date('2026-10-12T01:00:00.000Z'),
        merchantAccount: 'acct_B',
      },
      identityError: null,
    });
    // La cible porte l'origine A : sous l'identité B elle serait refusée —
    // la reprise doit donc se faire sous A pour aboutir.
    prisma.cardPayment.findFirst.mockResolvedValue({
      id: 'cp1',
      providerCode: 'stripe',
      merchantAccount: 'acct_A',
      environment: 'test',
    });

    // 3) Rejeu du MÊME événement : reprise directe (FAILED déjà inscrite),
    //    AUCUNE seconde lecture de la configuration pour le dispatch.
    cards.confirmPaid.mockResolvedValue({ outcome: 'credited', reference: 'CDP-1' });
    const second = await post(raw, header);
    expect(second.httpStatus).toBe(200);
    expect(second.body).toMatchObject({ received: true, result: 'processed' });
    // La configuration courante (B) n'a PAS été relue pendant le rejeu.
    expect(provider.webhookAuthContext).toHaveBeenCalledTimes(2); // réception 1 + rejeu 1 (signature)
    // La ligne conserve son identité d'origine : aucune réattribution à B.
    expect(stored).toMatchObject({
      status: PaymentWebhookStatus.PROCESSED,
      merchantAccount: 'acct_A',
    });
    expect(cards.confirmPaid).toHaveBeenCalledTimes(2); // échec + reprise
  });

  it('V5 §2 : rotation A→B puis rejeu d’un événement DÉJÀ TRAITÉ → doublon neutre, AUCUNE réattribution', async () => {
    // 1) Traitement complet sous le compte A.
    provider.webhookAuthContext.mockResolvedValue({
      secret: SECRET,
      identity: {
        settingId: 'set_stripe_1',
        configVersion: new Date('2026-10-12T00:00:00.000Z'),
        merchantAccount: 'acct_A',
      },
      identityError: null,
    });
    const raw = JSON.stringify({
      id: 'evt_v5_dup',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_v5_dup',
          payment_status: 'paid',
          payment_intent: 'pi_v5_dup',
          amount_total: 5000,
          currency: 'usd',
          livemode: false,
        },
      },
    });
    const header = signStripeWebhook({ rawBody: raw, secret: SECRET });
    const first = await post(raw, header);
    expect(first.httpStatus).toBe(200);
    expect(stored).toMatchObject({
      status: PaymentWebhookStatus.PROCESSED,
      merchantAccount: 'acct_A',
    });

    // 2) Rotation : la configuration courante expose désormais le compte B.
    provider.webhookAuthContext.mockResolvedValue({
      secret: SECRET,
      identity: {
        settingId: 'set_stripe_1',
        configVersion: new Date('2026-10-12T01:00:00.000Z'),
        merchantAccount: 'acct_B',
      },
      identityError: null,
    });

    // 3) Rejeu (retransmission prestataire) : doublon NEUTRE — aucun second
    //    traitement, aucun dispatch, et JAMAIS d'écrasement de l'origine A.
    const second = await post(raw, header);
    expect(second.httpStatus).toBe(200);
    expect(second.body).toMatchObject({ received: true, duplicate: true });
    expect(cards.confirmPaid).toHaveBeenCalledTimes(1); // UN SEUL traitement
    expect(prisma.cardPayment.findFirst).not.toHaveBeenCalled(); // pas de dispatch
    expect(stored).toMatchObject({
      status: PaymentWebhookStatus.PROCESSED,
      merchantAccount: 'acct_A', // jamais réattribuée à B
    });
  });

  // ── GO V6 §1 — reprise sans identité : complétion contrôlée, sans absorption ─

  /** Ligne antérieure à la capture d'identité (merchantAccount null). */
  const legacyEventAndRow = (
    eventId: string,
    sessionId: string,
    status: PaymentWebhookStatus,
  ) => {
    const raw = JSON.stringify({
      id: eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          payment_status: 'paid',
          payment_intent: `pi_${sessionId}`,
          amount_total: 5000,
          currency: 'usd',
          livemode: false,
        },
      },
    });
    const row: Row = {
      id: `evtrow-${eventId}`,
      providerCode: 'stripe',
      eventId,
      type: 'checkout.session.completed',
      status,
      merchantAccount: null, // SANS identité
      sourceSettingId: null,
      sourceConfigVersion: null,
      payload: JSON.parse(raw),
      attempts: 1,
    };
    rowsByKey.set(`stripe:${eventId}`, row);
    rowsById.set(String(row.id), row);
    return { raw, row };
  };

  it('V6 §1a : ligne SANS identité + complétion REFUSÉE → exception propagée (500 = rejeu), zéro effet métier', async () => {
    const { raw } = legacyEventAndRow('evt_v6a', 'cs_v6a', PaymentWebhookStatus.FAILED);
    // L'écriture de complétion (CAS) est REFUSÉE (erreur de persistance).
    prisma.paymentWebhookEvent.updateMany.mockImplementationOnce(() => {
      throw new Error('persistance refusée');
    });
    // Rejeu authentifié : l'exception remonte (500 = rejeu prestataire), AUCUN dispatch.
    await expect(post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }))).rejects.toThrow(
      'persistance refusée',
    );
    expect(cards.confirmPaid).not.toHaveBeenCalled();
    expect(cards.markExpired).not.toHaveBeenCalled();
    expect(cards.markFailed).not.toHaveBeenCalled();
    expect(cards.markProcessing).not.toHaveBeenCalled();
    expect(stored).toBeNull(); // aucune écriture de résultat
  });

  it('V6 §1b : complétion OK mais relecture INTERROMPUE → aucune poursuite sans preuve durable (500 = rejeu)', async () => {
    const { raw, row } = legacyEventAndRow('evt_v6b', 'cs_v6b', PaymentWebhookStatus.RECEIVED);
    // Le 1er findUnique (lookup P2002) retourne la ligne ; le 2e (relecture
    // par id de l'identité enregistrée) est INTERROMPUE.
    prisma.paymentWebhookEvent.findUnique
      .mockResolvedValueOnce(row) // lookup P2002
      .mockRejectedValueOnce(new Error('relecture interrompue')); // relecture par id
    await expect(post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }))).rejects.toThrow(
      'relecture interrompue',
    );
    expect(cards.confirmPaid).not.toHaveBeenCalled();
    expect(cards.markExpired).not.toHaveBeenCalled();
    expect(cards.markFailed).not.toHaveBeenCalled();
    expect(cards.markProcessing).not.toHaveBeenCalled();
  });

  it('V6 §1b′ : complétion non JUSTIFIABLE (relecture sans identité) → refus explicite (503/FAILED), événement conservé', async () => {
    const { raw } = legacyEventAndRow('evt_v6b2', 'cs_v6b2', PaymentWebhookStatus.RECEIVED);
    // Le CAS s'exécute mais n'enregistre RIEN (count 0, aucun écrasement possible)
    // et la relecture retrouve la ligne TOUJOURS SANS identité → non justifiable.
    prisma.paymentWebhookEvent.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    // Refus EXPLICITE : 503 (rejeu après rétablissement), AUCUN dispatch.
    expect(res.httpStatus).toBe(503);
    expect(res.body).toMatchObject({
      received: false,
      retry: true,
      reason: 'provider_identity_unavailable',
    });
    // L'événement est conservé pour intervention (FAILED), jamais acquitté en 200.
    expect(stored).toMatchObject({ status: PaymentWebhookStatus.FAILED });
    expect(cards.confirmPaid).not.toHaveBeenCalled();
  });

  it('V6 §1c : course de complétion → identité ENREGISTRÉE (gagnant) utilisée, JAMAIS celle du perdant', async () => {
    const { raw } = legacyEventAndRow('evt_v6c', 'cs_v6c', PaymentWebhookStatus.RECEIVED);
    // Notre rejeu porte l'identité 'acct_loser' (config courante du perdant).
    provider.webhookAuthContext.mockResolvedValue({
      secret: SECRET,
      identity: {
        settingId: 'set_loser',
        configVersion: new Date('2026-10-12T02:00:00.000Z'),
        merchantAccount: 'acct_loser',
      },
      identityError: null,
    });
    // COURSE : notre CAS PERT (count 0) car un rejeu concurrent a déjà persisté
    // 'acct_winner'. La relecture doit lire 'acct_winner' (l'identité ENREGISTRÉE).
    prisma.paymentWebhookEvent.updateMany.mockImplementationOnce(async (args: Row) => {
      const where = args.where as { id: string; merchantAccount?: null };
      const row = rowsById.get(where.id);
      if (row && where.merchantAccount === null) {
        // Le concurrent a gagné juste avant notre CAS : il a persisté la sienne.
        row.merchantAccount = 'acct_winner';
        row.sourceSettingId = 'set_winner';
        row.sourceConfigVersion = new Date('2026-10-12T01:30:00.000Z');
      }
      return { count: 0 }; // notre CAS a perdu
    });
    // La cible porte l'origine 'acct_winner' : le dispatch doit utiliser le gagnant.
    prisma.cardPayment.findFirst.mockResolvedValue({
      id: 'cp1',
      providerCode: 'stripe',
      merchantAccount: 'acct_winner',
      environment: 'test',
    });
    cards.confirmPaid.mockResolvedValue({ outcome: 'credited', reference: 'CDP-1' });
    const res = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(res.httpStatus).toBe(200);
    // Le dispatch utilise l'identité ENREGISTRÉE (gagnant), JAMAIS 'acct_loser'.
    expect(cards.confirmPaid).toHaveBeenCalledWith(
      expect.objectContaining({ merchantAccount: 'acct_winner' }),
    );
    // La ligne conserve l'identité du gagnant.
    expect(stored).toMatchObject({ merchantAccount: 'acct_winner' });
  });

  it('V6 §1d : reprise NOMINALE (ligne sans identité, complétion OK) → identité persistée + dispatch, puis DOUBLON neutre', async () => {
    const { raw } = legacyEventAndRow('evt_v6d', 'cs_v6d', PaymentWebhookStatus.FAILED);
    // Rejeu authentifié sous 'acct_replay'.
    provider.webhookAuthContext.mockResolvedValue({
      secret: SECRET,
      identity: {
        settingId: 'set_replay',
        configVersion: new Date('2026-10-12T03:00:00.000Z'),
        merchantAccount: 'acct_replay',
      },
      identityError: null,
    });
    prisma.cardPayment.findFirst.mockResolvedValue({
      id: 'cp1',
      providerCode: 'stripe',
      merchantAccount: 'acct_replay',
      environment: 'test',
    });
    cards.confirmPaid.mockResolvedValue({ outcome: 'credited', reference: 'CDP-1' });
    // Reprise nominale : complétion OK, dispatch sous l'identité DURABLE.
    const first = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(first.httpStatus).toBe(200);
    expect(cards.confirmPaid).toHaveBeenCalledTimes(1);
    expect(cards.confirmPaid).toHaveBeenCalledWith(
      expect.objectContaining({ merchantAccount: 'acct_replay' }),
    );
    expect(stored).toMatchObject({
      status: PaymentWebhookStatus.PROCESSED,
      merchantAccount: 'acct_replay', // complétion persistée
    });
    // DOUBLON (retransmission) : neutre, aucun second traitement.
    const second = await post(raw, signStripeWebhook({ rawBody: raw, secret: SECRET }));
    expect(second.httpStatus).toBe(200);
    expect(second.body).toMatchObject({ received: true, duplicate: true });
    expect(cards.confirmPaid).toHaveBeenCalledTimes(1); // UN SEUL traitement
    expect(stored).toMatchObject({ merchantAccount: 'acct_replay' }); // jamais réattribuée
  });
});
