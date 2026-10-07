import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
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

/**
 * GO P2/P3 — compteurs d'APPELS prestataire (simulateur).
 *
 * Instrumentation de preuve : le connecteur simulé est recréé à chaque
 * résolution, les compteurs sont donc MODULE pour survivre aux instances et
 * permettre de prouver, en test, qu'un rejeu ou une double soumission ne
 * multiplie PAS les créations côté prestataire.
 */
export const simulatedConnectorCounters = {
  createCheckoutSession: 0,
  createRefund: 0,
  retrieveSession: 0,
};

export function resetSimulatedConnectorCounters(): void {
  simulatedConnectorCounters.createCheckoutSession = 0;
  simulatedConnectorCounters.createRefund = 0;
  simulatedConnectorCounters.retrieveSession = 0;
}

/**
 * GO Stripe — connecteur SIMULÉ (recette/CI uniquement).
 *
 *  - Aucun appel réseau : la page « hébergée » est servie par l'API elle-même ;
 *  - Aucun numéro de carte ni CVV ne transite, jamais ;
 *  - Les événements sont ÉMIS côté serveur, signés avec le secret webhook local
 *    et passent par la MÊME chaîne que Stripe (signature → déduplication →
 *    confirmation) : aucun chemin court qui simulerait un crédit ;
 *  - Activé uniquement via `PAYMENT_SIMULATOR_ENABLED=true` et jamais en
 *    production (le drapeau est vérifié au niveau du contrôleur) ;
 *  - Distinction assumée : ce sont des PREUVES DE CLASSE C (parcours navigateur),
 *    jamais des échanges réels avec Stripe (classe B).
 */
@Injectable()
export class SimulatedConnector implements PaymentConnector {
  readonly code = 'simulated';
  readonly displayName = 'Simulateur local (aucun appel réseau)';

  private readonly sessions = new Map<string, SessionDetails>();
  /** GO P3 — même clé d'idempotence = MÊME session (comme le prestataire réel). */
  private readonly dispatched = new Map<string, SessionDetails>();

  constructor(private readonly webhookSecret: string) {}

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<ConnectorSession> {
    const replay = this.dispatched.get(input.idempotencyKey);
    if (replay) {
      return {
        sessionRef: replay.sessionRef,
        paymentRef: replay.paymentRef,
        checkoutUrl: `/api/payments/simulated/sessions/${replay.sessionRef}`,
        livemode: false,
        expiresAt: null,
      };
    }
    simulatedConnectorCounters.createCheckoutSession += 1;
    const sessionRef = `cs_sim_${randomBytes(8).toString('hex')}`;
    const paymentRef = `pi_sim_${randomBytes(8).toString('hex')}`;
    const details: SessionDetails = {
      sessionRef,
      status: 'open',
      paymentStatus: 'unpaid',
      amountTotalCents: input.amountCents,
      currency: input.currency,
      paymentRef,
      livemode: false,
    };
    this.sessions.set(sessionRef, details);
    this.dispatched.set(input.idempotencyKey, details);
    return {
      sessionRef,
      paymentRef,
      // URL RELATIVE : joignable depuis l'origine du web (proxy /api) comme
      // depuis l'API seule (parcours recette sur le port API).
      checkoutUrl: `/api/payments/simulated/sessions/${sessionRef}`,
      livemode: false,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
  }

  async retrieveSession(sessionRef: string): Promise<SessionDetails> {
    simulatedConnectorCounters.retrieveSession += 1;
    const known = this.sessions.get(sessionRef);
    if (known) return known;
    // Après redémarrage : état inconnu → aucun changement d'état côté métier.
    return {
      sessionRef,
      status: 'unknown',
      paymentStatus: 'unknown',
      amountTotalCents: null,
      currency: null,
      paymentRef: null,
      livemode: false,
    };
  }

  /** Remboursement simulé : abouti (la ME est produite par le parcours C). */
  async createRefund(input: ConnectorRefundInput): Promise<ConnectorRefundOutcome> {
    simulatedConnectorCounters.createRefund += 1;
    return {
      providerRef: `re_sim_${randomBytes(8).toString('hex')}`,
      status: 'succeeded',
      amountCents: input.amountCents,
      failureReason: null,
    };
  }

  verifyWebhookSignature(rawBody: string | Buffer, header: string | undefined): void {
    const result = verifyStripeSignature({
      rawBody,
      header,
      secret: this.webhookSecret,
    });
    if (!result.ok) {
      throw new Error(
        `Signature webhook invalide (${result.reason ?? 'inconnue'}).`,
      );
    }
  }

  async verifyAccount(): Promise<ConnectorAccount> {
    return { accountId: 'sim_merchant_local', livemode: false };
  }
}
