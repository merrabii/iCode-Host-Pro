/**
 * GO Stripe — contrat du CONNECTEUR de paiement carte.
 *
 * Toute interface prestataire (Stripe aujourd'hui, PaymentCloud demain)
 * s'implémente derrière ce contrat : la plateforme ne connaît que
 * `code` + ces opérations, jamais de détail propriétaire. Aucune donnée de
 * carte ne transite ici (page hébergée ou composants du prestataire) : jamais
 * de `card_number`/`CVV` côté serveur.
 */

export interface CreateCheckoutSessionInput {
  /** Référence interne (affichable) — portée en metadata/client_reference_id. */
  reference: string;
  amountCents: number;
  /** ISO minuscules : "usd" | "eur" (MAD hors périmètre). */
  currency: string;
  customerEmail: string;
  /** URL de retour après paiement (jamais déterminée par le navigateur). */
  successUrl: string;
  cancelUrl: string;
  /** Métadonnées serveur → revérifiées à la confirmation. */
  metadata?: Record<string, string>;
}

export interface ConnectorSession {
  sessionRef: string;
  paymentRef: string | null;
  checkoutUrl: string;
  livemode: boolean;
  expiresAt: Date | null;
}

export type ProviderSessionStatus = 'open' | 'complete' | 'expired' | 'unknown';

export interface SessionDetails {
  sessionRef: string;
  status: ProviderSessionStatus;
  /** "paid" = paiement constaté par le prestataire (source du crédit serveur). */
  paymentStatus: 'unpaid' | 'paid' | 'no_payment_required' | 'unknown';
  amountTotalCents: number | null;
  currency: string | null;
  paymentRef: string | null;
  livemode: boolean | null;
}

export interface ConnectorRefundInput {
  /** Paiement d'origine (pi_…). */
  paymentRef: string;
  amountCents: number;
  /** Clé d'idempotence transmise au prestataire (rejeu = même remboursement). */
  idempotencyKey: string;
}

export type ProviderRefundStatus =
  | 'pending'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface ConnectorRefundOutcome {
  providerRef: string;
  status: ProviderRefundStatus;
  amountCents: number;
  failureReason: string | null;
}

export interface ConnectorAccount {
  accountId: string;
  livemode: boolean | null;
}

export interface PaymentConnector {
  readonly code: string;
  readonly displayName: string;
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<ConnectorSession>;
  retrieveSession(sessionRef: string): Promise<SessionDetails>;
  createRefund(input: ConnectorRefundInput): Promise<ConnectorRefundOutcome>;
  /** Vérification signature webhook — lève si invalide/expirée (jamais de bypass). */
  verifyWebhookSignature(rawBody: string | Buffer, header: string | undefined): void;
  /** Contrôle de connexion réel (appel prestataire, mode test). */
  verifyAccount(): Promise<ConnectorAccount>;
}
