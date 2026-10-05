import { createHash } from 'crypto';

/**
 * P7 (GO socle commercial Q12) — preuve d'acceptation tarifaire.
 *
 * Une commande payante n'est créée que si le client prouve avoir accepté
 * EXACTEMENT les conditions tarifaires serveur : total TTC, devise, moyen de
 * paiement (frais compris) et empreinte du devis (configuration, prix, promo,
 * taux de taxe, installation, frais). L'omission de la preuve ne contourne
 * jamais le contrôle : refus 409 `PRICING_CHANGED` sans écriture ni débit.
 *
 * L'empreinte (`pricingQuoteKey`) est calculée par le serveur au devis
 * (`POST /store/quote`) puis ré-évaluée au checkout — le client ne fait que
 * la renvoyer : aucun montant n'est jamais cru sur parole.
 */

/** Conditions tarifaires pertinentes figées dans l'empreinte d'un devis. */
export interface PricingQuoteConditions {
  productSlug: string;
  options: { optionId: string; choiceId: string }[];
  addonIds: string[];
  paymentMethodId: string | null;
  feeType: string | null;
  feePercent: number | null;
  feeFixedCents: number | null;
  currency: string;
  activePriceHtCents: number;
  promoPriceHtCents: number | null;
  taxRatePercent: number;
  installationFeeCents: number;
  amountHtCents: number;
  taxAmountCents: number;
  amountTtcCents: number;
}

/**
 * Empreinte déterministe (sha256) des conditions d'un devis. Sérieialisation
 * canonique (ordre de clés fixé ici, listes triées) — jamais de dépendance à
 * l'ordre des propriétés de l'objet ni à l'ordre de saisie du panier.
 */
export function pricingQuoteKey(c: PricingQuoteConditions): string {
  const canonical = JSON.stringify({
    productSlug: c.productSlug,
    options: [...c.options]
      .map((o) => `${o.optionId}:${o.choiceId}`)
      .sort(),
    addonIds: [...c.addonIds].sort(),
    paymentMethodId: c.paymentMethodId,
    feeType: c.feeType,
    feePercent: c.feePercent,
    feeFixedCents: c.feeFixedCents,
    currency: c.currency,
    activePriceHtCents: c.activePriceHtCents,
    promoPriceHtCents: c.promoPriceHtCents,
    taxRatePercent: c.taxRatePercent,
    installationFeeCents: c.installationFeeCents,
    amountHtCents: c.amountHtCents,
    taxAmountCents: c.taxAmountCents,
    amountTtcCents: c.amountTtcCents,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Refus d'acceptation (→ 409 PRICING_CHANGED côté checkout). */
export type PricingAcceptanceReason =
  | 'ACCEPTANCE_REQUIRED'
  | 'TOTAL_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'PAYMENT_METHOD_MISMATCH'
  | 'QUOTE_KEY_MISMATCH';

export interface PricingAcceptanceRefusal {
  reason: PricingAcceptanceReason;
  /** Champs obligatoires absents (reason ACCEPTANCE_REQUIRED). */
  missing?: string[];
}

/** Preuve d'acceptation telle que reçue du client (4 champs optionnels au DTO). */
export interface PricingAcceptance {
  acceptedTotalTtcCents?: number;
  acceptedCurrency?: string;
  acceptedPaymentMethodId?: string;
  acceptedQuoteKey?: string;
}

/**
 * Évalue la preuve d'acceptation contre les conditions serveur.
 *
 * - **Commande payante** (total > 0) : les 4 conditions sont OBLIGATOIRES —
 *   toute omission est un refus (`ACCEPTANCE_REQUIRED`), aucun contournement ;
 *   puis total, devise, moyen et empreinte doivent correspondre dans cet ordre.
 * - **Commande gratuite** (total = 0) : aucune preuve requise (contrat
 *   explicite des chemins gratuits) ; si un champ est fourni, il doit
 *   correspondre — jamais de valeur acceptée « par défaut ».
 *
 * Retourne `null` quand la preuve est valable.
 */
export function evaluatePricingAcceptance(params: {
  amountTtcCents: number;
  server: { currency: string; paymentMethodId: string; quoteKey: string };
  accepted: PricingAcceptance;
}): PricingAcceptanceRefusal | null {
  const { amountTtcCents, server, accepted } = params;

  if (amountTtcCents > 0) {
    const missing: string[] = [];
    if (accepted.acceptedTotalTtcCents === undefined) {
      missing.push('acceptedTotalTtcCents');
    }
    if (accepted.acceptedCurrency === undefined) missing.push('acceptedCurrency');
    if (accepted.acceptedPaymentMethodId === undefined) {
      missing.push('acceptedPaymentMethodId');
    }
    if (accepted.acceptedQuoteKey === undefined) missing.push('acceptedQuoteKey');
    if (missing.length > 0) {
      return { reason: 'ACCEPTANCE_REQUIRED', missing };
    }
  }

  if (
    accepted.acceptedTotalTtcCents !== undefined &&
    accepted.acceptedTotalTtcCents !== amountTtcCents
  ) {
    return { reason: 'TOTAL_MISMATCH' };
  }
  if (
    accepted.acceptedCurrency !== undefined &&
    accepted.acceptedCurrency !== server.currency
  ) {
    return { reason: 'CURRENCY_MISMATCH' };
  }
  if (
    accepted.acceptedPaymentMethodId !== undefined &&
    accepted.acceptedPaymentMethodId !== server.paymentMethodId
  ) {
    return { reason: 'PAYMENT_METHOD_MISMATCH' };
  }
  if (
    accepted.acceptedQuoteKey !== undefined &&
    accepted.acceptedQuoteKey !== server.quoteKey
  ) {
    return { reason: 'QUOTE_KEY_MISMATCH' };
  }
  return null;
}
