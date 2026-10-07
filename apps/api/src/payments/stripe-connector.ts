import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorAccount,
  ConnectorRefundInput,
  ConnectorRefundOutcome,
  ConnectorSession,
  CreateCheckoutSessionInput,
  PaymentConnector,
  SessionDetails,
} from './payment-connector';
import { verifyStripeSignature } from './stripe-signature';

/** Erreur HTTP prestataire (message lisible + code, jamais de secret dedans). */
export class StripeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerCode: string | null = null,
  ) {
    super(message);
    this.name = 'StripeHttpError';
  }
}

const REQUEST_TIMEOUT_MS = 20_000;

/** `payment_intent` : string | objet | null → identifiant exploitable. */
function extractPaymentRef(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

/** Encodage application/x-www-form-urlencoded (API REST Stripe). */
export function formBody(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.append(key, value);
  }
  return params.toString();
}

/**
 * GO Stripe — connecteur REST réel (mode TEST uniquement).
 *
 *  - `Authorization: Bearer sk_test_…` (secret DÉCHIFFRÉ à l'appel, jamais
 *    stocké ni journalisé en clair, jamais renvoyé par l'API) ;
 *  - `Idempotency-Key` sur toute écriture (POST) → rejeu sans double effet ;
 *  - corps de réponse BRUT conservé pour signature webhook / diagnostics ;
 *  - aucun numéro de carte ni CVV : page hébergée du prestataire uniquement ;
 *  - `livemode: true` refusé en amont (le GO interdit tout appel live).
 */
@Injectable()
export class StripeConnector implements PaymentConnector {
  readonly code = 'stripe';
  readonly displayName = 'Stripe';

  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly webhookSecret: string;

  constructor(secretKey: string, webhookSecret: string, config: ConfigService) {
    this.secretKey = secretKey;
    this.webhookSecret = webhookSecret;
    this.baseUrl = (
      config.get<string>('STRIPE_API_BASE') ?? 'https://api.stripe.com'
    ).replace(/\/+$/, '');
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { form?: Record<string, string>; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
    };
    if (opts.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.form ? formBody(opts.form) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new StripeHttpError(
        `Impossible de joindre le prestataire (${path}) : ${err instanceof Error ? err.message : String(err)}`,
        0,
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      let message = `Prestataire : HTTP ${res.status} sur ${path}.`;
      let code: string | null = null;
      try {
        const parsed = JSON.parse(text) as {
          error?: { message?: string; code?: string };
        };
        if (parsed.error?.message) message = parsed.error.message;
        if (parsed.error?.code) code = parsed.error.code;
      } catch {
        // Corps non JSON : on conserve le message HTTP générique.
      }
      throw new StripeHttpError(message, res.status, code);
    }
    return JSON.parse(text) as T;
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<ConnectorSession> {
    const meta = { reference: input.reference, ...(input.metadata ?? {}) };
    const form: Record<string, string> = {
      mode: 'payment',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.reference,
      customer_email: input.customerEmail,
      'line_items[0][price_data][currency]': input.currency,
      'line_items[0][price_data][unit_amount]': String(input.amountCents),
      'line_items[0][price_data][product_data][name]':
        'Recharge de portefeuille Code Diali',
      'line_items[0][quantity]': '1',
    };
    for (const [k, v] of Object.entries(meta)) form[`metadata[${k}]`] = v;
    for (const [k, v] of Object.entries(meta)) {
      form[`payment_intent_data[metadata][${k}]`] = v;
    }

    const created = await this.request<{
      id: string;
      url?: string;
      livemode?: boolean;
      expires_at?: number;
      payment_intent?: unknown;
      status?: string;
    }>('POST', '/v1/checkout/sessions', {
      form,
      // GO P3 — clé STABLE par opération (`topup:<référence>`) : un rejeu après
      // réponse perdue retourne la MÊME session (Stripe : ≤ 24 h), jamais une
      // seconde. Une opération distincte = une référence = une clé distincte.
      idempotencyKey: input.idempotencyKey,
    });

    if (!created.url) {
      throw new StripeHttpError(
        'Le prestataire n’a pas renvoyé de page de paiement.',
        502,
        null,
      );
    }
    const livemode = created.livemode === true;
    if (livemode) {
      throw new StripeHttpError(
        'Réponse LIVE refusée : ce déploiement n’est autorisé qu’en mode test.',
        502,
        null,
      );
    }
    return {
      sessionRef: created.id,
      paymentRef: extractPaymentRef(created.payment_intent),
      checkoutUrl: created.url,
      livemode,
      expiresAt:
        typeof created.expires_at === 'number'
          ? new Date(created.expires_at * 1000)
          : null,
    };
  }

  async retrieveSession(sessionRef: string): Promise<SessionDetails> {
    const data = await this.request<{
      id: string;
      status?: string;
      payment_status?: string;
      amount_total?: number | null;
      currency?: string | null;
      payment_intent?: unknown;
      livemode?: boolean;
    }>('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionRef)}`);

    const status: SessionDetails['status'] =
      data.status === 'open' ||
      data.status === 'complete' ||
      data.status === 'expired'
        ? data.status
        : 'unknown';
    const paymentStatus: SessionDetails['paymentStatus'] =
      data.payment_status === 'unpaid' ||
      data.payment_status === 'paid' ||
      data.payment_status === 'no_payment_required'
        ? data.payment_status
        : 'unknown';

    return {
      sessionRef: data.id,
      status,
      paymentStatus,
      amountTotalCents:
        typeof data.amount_total === 'number' ? data.amount_total : null,
      currency: data.currency ?? null,
      paymentRef: extractPaymentRef(data.payment_intent),
      livemode: typeof data.livemode === 'boolean' ? data.livemode : null,
    };
  }

  async createRefund(input: ConnectorRefundInput): Promise<ConnectorRefundOutcome> {
    const data = await this.request<{
      id: string;
      status?: string;
      amount?: number;
      failure_reason?: string | null;
    }>('POST', '/v1/refunds', {
      form: {
        payment_intent: input.paymentRef,
        amount: String(input.amountCents),
        reason: 'requested_by_customer',
      },
      idempotencyKey: input.idempotencyKey,
    });

    const status: ConnectorRefundOutcome['status'] =
      data.status === 'pending' ||
      data.status === 'requires_action' ||
      data.status === 'succeeded' ||
      data.status === 'failed' ||
      data.status === 'canceled'
        ? data.status
        : 'pending';

    return {
      providerRef: data.id,
      status,
      amountCents: typeof data.amount === 'number' ? data.amount : input.amountCents,
      failureReason: data.failure_reason ?? null,
    };
  }

  verifyWebhookSignature(rawBody: string | Buffer, header: string | undefined): void {
    const result = verifyStripeSignature({ rawBody, header, secret: this.webhookSecret });
    if (!result.ok) {
      throw new StripeHttpError(
        `Signature webhook invalide (${result.reason ?? 'inconnue'}).`,
        401,
        null,
      );
    }
  }

  async verifyAccount(): Promise<ConnectorAccount> {
    const data = await this.request<{ id?: string; livemode?: boolean }>(
      'GET',
      '/v1/account',
    );
    if (!data.id) {
      throw new StripeHttpError('Compte marchand introuvable (réponse vide).', 502, null);
    }
    return {
      accountId: data.id,
      livemode: typeof data.livemode === 'boolean' ? data.livemode : null,
    };
  }
}
