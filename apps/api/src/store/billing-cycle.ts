import { BillingCycle } from '@prisma/client';

/**
 * P8 (lot D2) — échéance du cycle récurrent : date de facturation suivante.
 *
 * - `MONTHLY` : même jour le mois suivant, **clampé au dernier jour du mois**
 *   (31 janv. → 28/29 févr., 31 août → 30 sept.) — jamais de dérive au 1er.
 * - `YEARLY` : même jour l'année suivante, clamp idem (29 févr. → 28 hors
 *   bissextile).
 * - `ONETIME` : `null` (aucune échéance, aucun renouvellement).
 *
 * Tout en UTC (les `paidAt`/`nextBillingDate` du dépôt sont des instants UTC) ;
 * déterministe (mêmes entrées → mêmes ms), testé par `renewal.service.spec`.
 */
export function addBillingCycle(from: Date, cycle: BillingCycle): Date | null {
  if (cycle === BillingCycle.ONETIME) return null;
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  // Avancer depuis le 1er du mois : évite la dérive JS (31 janv. + 1 mois →
  // 2/3 mars) avant de se repositionner sur le jour d'origine (clampé).
  d.setUTCDate(1);
  if (cycle === BillingCycle.YEARLY) {
    d.setUTCFullYear(d.getUTCFullYear() + 1);
  } else {
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}
