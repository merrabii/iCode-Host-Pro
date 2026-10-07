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

  constructor(private readonly webhookSecret: string) {}

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<ConnectorSession> {
    const sessionRef = `cs_sim_${randomBytes(8).toString('hex')}`;
    const paymentRef = `pi_sim_${randomBytes(8).toString('hex')}`;
    this.sessions.set(sessionRef, {
      sessionRef,
      status: 'open',
      paymentStatus: 'unpaid',
      amountTotalCents: input.amountCents,
      currency: input.currency,
      paymentRef,
      livemode: false,
    });
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
