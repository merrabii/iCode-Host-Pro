/**
 * Simulateur de paiement — RECETTE/TESTS uniquement.
 *
 * Contrat (GO socle commercial) :
 *  - Activation EXPLICITE : `PAYMENT_SIMULATOR_ENABLED` doit valoir EXACTEMENT
 *    `true` (comparaison stricte, au modèle de `hosting/c3-flag.ts`).
 *  - Refus en production : `NODE_ENV=production` ⇒ TOUJOURS `false`, même si
 *    l'env est positionné (aucune activation commerciale par accident).
 *  - Un tel simulateur ne concerne QUE les commandes CARTe ; virement et
 *    solde suivent leurs propres confirmations (admin / transaction dédiée).
 *  - Aucun prestataire réel n'est appelé : aucun numéros de carte ni CVV ne
 *    transite ni n'est stocké.
 */

/** Env : valeur d'activation explicite du simulateur de paiement. */
export const PAYMENT_SIMULATOR_ENABLED_ENV = 'PAYMENT_SIMULATOR_ENABLED';
/** Seule valeur d'activation acceptée (comparaison stricte, sensible à la casse). */
export const PAYMENT_SIMULATOR_ENABLED_VALUE = 'true';

/**
 * Vrai si et seulement si le simulateur est explicitement activé ET que
 * l'environnement n'est PAS la production (refus net en production).
 */
export function isPaymentSimulatorEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NODE_ENV === 'production') return false;
  return env[PAYMENT_SIMULATOR_ENABLED_ENV] === PAYMENT_SIMULATOR_ENABLED_VALUE;
}
