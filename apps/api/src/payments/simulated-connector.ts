import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
 * GO clôture §4.5 — état d'une session simulée DURCI en base (la table
 * `CardPayment` EST la source de vérité du simulateur) : le redémarrage ou
 * une seconde instance d'API ne perd plus l'état, et une rejeu avec la même
 * clé d'idempotence retrouve la MÊME session.
 */
export interface SimulatedSessionSnapshot {
  paymentRef: string | null;
  amountTotalCents: number;
  currency: string;
  paid: boolean;
  expired: boolean;
  canceled: boolean;
}

export interface SimulatedSessionStore {
  findSession(sessionRef: string): Promise<SimulatedSessionSnapshot | null>;
  hasSession(sessionRef: string): Promise<boolean>;
}

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
 *  - §4.5 — références DÉTERMINISTES dérivées de la clé d'idempotence :
 *    deux instances (ou un redémarrage) produisent la MÊME session pour la
 *    MÊME clé, et l'état est relu depuis la base via `SimulatedSessionStore` ;
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

  constructor(
    private readonly webhookSecret: string,
    private readonly store?: SimulatedSessionStore,
  ) {}

  /** §4.5 — référence prestataire DÉTERMINISTE par clé (jamais aléatoire). */
  private deterministic(prefix: string, key: string): string {
    return `${prefix}${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
  }

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
    const sessionRef = this.deterministic('cs_sim_', input.idempotencyKey);
    const paymentRef = this.deterministic('pi_sim_', `${input.idempotencyKey}:pi`);
    // §4.5 — la base est la vérité : une session déjà ouverte pour cette clé
    // (autre instance, redémarrage) est REJOUÉE, jamais recréée.
    if (this.store && (await this.store.hasSession(sessionRef))) {
      const details: SessionDetails = {
        sessionRef,
        status: 'open',
        paymentStatus: 'unpaid',
        amountTotalCents: input.amountCents,
        currency: input.currency,
        paymentRef,
        livemode: false,
      };
      this.dispatched.set(input.idempotencyKey, details);
      return {
        sessionRef,
        paymentRef,
        checkoutUrl: `/api/payments/simulated/sessions/${sessionRef}`,
        livemode: false,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      };
    }
    simulatedConnectorCounters.createCheckoutSession += 1;
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
    // §4.5 — état relu depuis la base (le redémarrage ne perd plus l'issue :
    // expiré/annulé/succès constaté côté plateforme reste lisible).
    const snap = await this.store?.findSession(sessionRef);
    if (snap) {
      return {
        sessionRef,
        status: snap.paid
          ? 'complete'
          : snap.expired
            ? 'expired'
            : snap.canceled
              ? 'unknown'
              : 'open',
        paymentStatus: snap.paid ? 'paid' : 'unpaid',
        amountTotalCents: snap.amountTotalCents,
        currency: snap.currency,
        paymentRef: snap.paymentRef,
        livemode: false,
      };
    }
    // Jamais connue (session d'un autre prestataire / ligne purgée) :
    // état inconnu → aucun changement d'état côté métier.
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
      // §4.5 — même clé d'idempotence = MÊME référence (rejeu sûr, y compris
      // après redémarrage ou depuis une autre instance d'API).
      providerRef: this.deterministic('re_sim_', input.idempotencyKey),
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
