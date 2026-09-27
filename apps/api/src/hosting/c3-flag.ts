/**
 * 17B.4F-C3 — garde serveur du parcours C3 (provisioning des NOUVELLES
 * commandes store sous tracking dédié + réservation C1).
 *
 * Contrat (identique au gabarit C2, cf. `c2-flag.ts`) :
 *  - `HOSTING_C3_ENABLED` doit valoir EXACTEMENT la valeur d'activation `true`
 *    pour activer le parcours ; absent, vide, `false`, `1`, `TRUE`… ⇒ OFF.
 *    Comparaison stricte d'égalité : JAMAIS `Boolean("false")` (qui vaut true).
 *  - OFF : contrat historique préservé (parcours legacy inchangé), sauf pour
 *    les commandes DÉJÀ trackinguées : leur provisioning est refusé de façon
 *    explicite (409) — JAMAIS de repli legacy pour une commande C3.
 *  - ON : fail-closed sur la capability (colonnes C1 + table C3 vérifiées
 *    avant toute écriture métier) ; sans schéma migré → 503.
 *  - La garde est relue À L'APPEL (jamais figée au démarrage), au même modèle
 *    que C2 et que le keyring d'empreinte : le runtime peut être réévalué sans
 *    redémarrage et aucun `.env` n'est modifié par ce module.
 */

/** Env : valeur d'activation explicite du parcours C3. */
export const HOSTING_C3_ENABLED_ENV = 'HOSTING_C3_ENABLED';
/** Seule valeur d'activation acceptée (comparaison stricte, sensible à la casse). */
export const HOSTING_C3_ENABLED_VALUE = 'true';

/**
 * Vrai si et seulement si la garde est positionnée à la valeur d'activation
 * explicite. Tout état absent/autre ⇒ OFF (fail-closed sur la désactivation).
 */
export function isHostingC3Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HOSTING_C3_ENABLED_ENV] === HOSTING_C3_ENABLED_VALUE;
}
