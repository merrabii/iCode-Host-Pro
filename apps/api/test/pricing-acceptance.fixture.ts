import * as request from 'supertest';
import { GlobalPrefix } from '../src/config/constants';

/**
 * P7 (GO socle Q12) — cache de preuves d'acceptation tarifaire pour les
 * suites e2e : chaque combinaison (productSlug, paymentMethodId) utilisée
 * par un checkout est « préchargée » une fois via `POST /store/quote` (le
 * devis retourne total, devise, moyen et empreinte `quoteKey`), puis les
 * builders de corps de checkout y puisent leurs champs `accepted*`.
 *
 * La preuve vient TOUJOURS du serveur : les suites ne recalcilent jamais
 * ni total, ni taxe, ni empreinte. Une combinaison non préchargée →
 * `undefined` (le payload part sans preuve et le serveur refuse en 409,
 * échec visible et explicite), sauf chemin gratuit où l'absence est légale.
 */
export type AcceptanceBody = {
  acceptedTotalTtcCents: number;
  acceptedCurrency: string;
  acceptedPaymentMethodId: string;
  acceptedQuoteKey: string;
};

export function acceptanceKey(productSlug: string, paymentMethodId: string): string {
  return `${productSlug}|${paymentMethodId}`;
}

/** Précharge la preuve d'acceptation pour (slug, méthode) — à appeler après
 *  la création des fixtures (produit ACTIVE, moyen actif). */
export async function preloadAcceptance(
  server: unknown,
  productSlug: string,
  paymentMethodId: string,
): Promise<void> {
  const q = await request(server as never)
    .post(`/${GlobalPrefix}/store/quote`)
    .send({ productSlug, paymentMethodId })
    .expect(201);
  storeAcceptance(productSlug, paymentMethodId, q.body);
}

const cache = new Map<string, AcceptanceBody>();

/** Enregistre une preuve déjà obtenue (devis exécuté par la suite elle-même). */
export function storeAcceptance(
  productSlug: string,
  paymentMethodId: string,
  quoteBody: {
    amountTtcCents: number;
    currency: string;
    paymentMethodId: string | null;
    quoteKey: string;
  },
): void {
  if (quoteBody.paymentMethodId === null) {
    throw new Error(
      `storeAcceptance: devis SANS paymentMethodId pour ${productSlug} (quote sans méthode).`,
    );
  }
  cache.set(acceptanceKey(productSlug, quoteBody.paymentMethodId), {
    acceptedTotalTtcCents: quoteBody.amountTtcCents,
    acceptedCurrency: quoteBody.currency,
    acceptedPaymentMethodId: quoteBody.paymentMethodId,
    acceptedQuoteKey: quoteBody.quoteKey,
  });
}

/** Preuve préchargée pour (slug, méthode) ; `undefined` si non préchargée
 *  (payload sans preuve — 409 côté serveur si le chemin est payant). */
export function acceptanceFor(
  productSlug: string,
  paymentMethodId: string,
): AcceptanceBody | undefined {
  return cache.get(acceptanceKey(productSlug, paymentMethodId));
}

/** Variante fail-fast pour les builders qui ne servent QUE des combinaisons
 *  payantes préchargées (erreur claire si un preload a été oublié). */
export function acceptanceOrThrow(
  productSlug: string,
  paymentMethodId: string,
): AcceptanceBody {
  const body = acceptanceFor(productSlug, paymentMethodId);
  if (!body) {
    throw new Error(
      `acceptanceOrThrow: preuve non préchargée pour ${acceptanceKey(productSlug, paymentMethodId)} (oubli de preloadAcceptance ?).`,
    );
  }
  return body;
}

/** Réinitialisation entre suites (worker partagé en runInBand). */
export function clearAcceptanceCache(): void {
  cache.clear();
}
