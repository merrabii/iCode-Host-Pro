/**
 * 17B.4F-C4 — garde serveur du protocole de reprise sûre (tentatives
 * durables, arrêt/cleanup/libération, finalize).
 *
 * Contrat (D8 — identique au gabarit C3, cf. `c3-flag.ts`) :
 *  - `HOSTING_C4_ENABLED` doit valoir EXACTEMENT la valeur d'activation
 *    `true` pour activer le protocole ; absent, vide, `false`, `1`, `TRUE`…
 *    ⇒ OFF. Comparaison stricte d'égalité : JAMAIS `Boolean("false")`.
 *  - OFF (défaut strict) : contrat C1/C2/C3/historique inchangé, AUCUNE
 *    table C4 n'est lue ni écrite, aucun marqueur d'arrêt n'est opposable —
 *    mais aucun marqueur/stop/tentative déjà posé n'est jamais effacé par la
 *    bascule (OFF n'efface rien, il ne fait que cesser les nouveaux dispatchs).
 *  - ON : fail-closed sur la capability (5 tables C4 + contraintes vérifiées
 *    LIVE avant toute mutation) ; sans schéma migré ⇒ 503.
 *  - La garde est relue à L'APPEL (jamais figée au démarrage), au même modèle
 *    que C2/C3 : le runtime peut être réévalué sans redémarrage et aucun
 *    `.env` n'est modifié par ce module.
 */

/** Env : valeur d'activation explicite du protocole C4. */
export const HOSTING_C4_ENABLED_ENV = 'HOSTING_C4_ENABLED';
/** Seule valeur d'activation acceptée (comparaison stricte, sensible à la casse). */
export const HOSTING_C4_ENABLED_VALUE = 'true';

/**
 * Vrai si et seulement si la garde est positionnée à la valeur d'activation
 * explicite. Tout état absent/autre ⇒ OFF (fail-closed sur la désactivation).
 */
export function isHostingC4Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HOSTING_C4_ENABLED_ENV] === HOSTING_C4_ENABLED_VALUE;
}
