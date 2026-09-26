/**
 * 17B.4F-C2 — garde serveur du parcours C2 (réservation sur le déploiement
 * direct client).
 *
 * Contrat :
 *  - `HOSTING_C2_ENABLED` doit valoir EXACTEMENT la valeur d'activation `true`
 *    pour activer le parcours ; absent, vide, `false`, `1`, `TRUE`… ⇒ OFF.
 *    Comparaison stricte d'égalité : JAMAIS `Boolean("false")` (qui vaut true).
 *  - OFF : contrat HTTP existant conservé (POST sans `clientRequestId` accepté),
 *    AUCUN appel au moteur hosting, AUCUN accès aux colonnes C1 non migrées
 *    (`requestFingerprint` / `providerIntentAt`), endpoint de liste inerte.
 *  - La garde est relue À L'APPEL (jamais figée au démarrage), au même modèle
 *    que le keyring d'empreinte : le runtime peut être réévalué sans redémarrage
 *    et aucun `.env` n'est modifié par ce module.
 */

/** Env : valeur d'activation explicite du parcours C2. */
export const HOSTING_C2_ENABLED_ENV = 'HOSTING_C2_ENABLED';
/** Seule valeur d'activation acceptée (comparaison stricte, sensible à la casse). */
export const HOSTING_C2_ENABLED_VALUE = 'true';

/**
 * Vrai si et seulement si la garde est positionnée à la valeur d'activation
 * explicite. Tout état absent/autre ⇒ OFF (fail-closed sur la désactivation).
 */
export function isHostingC2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HOSTING_C2_ENABLED_ENV] === HOSTING_C2_ENABLED_VALUE;
}
