import { ReconcileSettings, RECONCILE_DEFAULT_SETTINGS } from './reconcile-settings';

/**
 * 17B.4B — delai de backoff EXPONENTIEL BORNE du reconciliateur (module PUR,
 * aucune import Nest, testable sans environnement).
 *
 *   delay(attempt) = min(backoffInitialMs * 2^(attempt-1), maxBackoffMs)
 *
 * `attempt` = numero de TENTATIVE APRES INCREMENT (post-claim, 1-based).
 * Garanties :
 *  - attempt < 1 est ramene a 1 (jamais un delai inferieur a l initial) ;
 *  - protection contre l overflow : si le facteur 2^(attempt-1) depasse
 *    maxBackoffMs/backoffInitialMs (ou n'est pas fini), on retourne maxBackoffMs
 *    sans jamais evaluer un produit debordant ;
 *  - borne superieure stricte : jamais plus de maxBackoffMs (pas de famine) ;
 *  - deterministe : meme (attempt, settings) ⇒ meme delai.
 */
export function reconcileBackoffDelayMs(
  attempt: number,
  settings: Pick<ReconcileSettings, 'backoffInitialMs' | 'maxBackoffMs'> = RECONCILE_DEFAULT_SETTINGS,
): number {
  const initial = settings.backoffInitialMs;
  const max = settings.maxBackoffMs;
  const n = attempt < 1 ? 1 : attempt;

  // Facteur borne AVANT multiplication : si 2^(n-1) > max/initial, l'echeance
  // est deja au palier maximum — aucun besoin (ni risque) de calculer le produit.
  const ratio = max / initial;
  const factor = Math.pow(2, n - 1);
  if (!Number.isFinite(factor) || factor > ratio) {
    return max;
  }
  return Math.min(initial * factor, max);
}