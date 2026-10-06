import { Prisma } from '@prisma/client';

/**
 * Barrière transactionnelle commune de la chaîne de renouvellements
 * (GO fenêtres résiduelles R1) — deux fenêtres close :
 *
 *  - **création de descendants** (`RenewalService.createRenewalOrderInTx`,
 *    sweep) et **révocation en cascade** (`ClientStoreController.
 *    setMyOrderRenewal`, branche `enabled=false`) sérialisent sur la MÊME
 *    clé `pg_advisory_xact_lock` dérivée de la **racine** de la chaîne ;
 *  - la clé est transaction-scoped : libérée au commit/rollback, donc la
 *    révocation qui attend la barrière découvre, une fois acquise, TOUS les
 *    descendants committés (le G préparé par un renouvellement concurrent)
 *    et le renouvellement qui attend voit le CAS `autoRenew` déjà basculé
 *    (flip COUNT=0 → aucune fille armée créée) ;
 *  - un simple walk + `updateMany` séparé (sans barrière) ne suffit pas :
 *    le walk ne verrait pas le G non committé et son `updateMany` attendrait
 *    le verrou de ligne F pour, finalement, ne rien désarmer (G armé résiduel) ;
 *  - l'ordre acquisition (barrière d'abord, puis verrous de ligne) est
 *    IDENTIQUE des deux côtés : pas de deadlock possible entre les deux voies ;
 *  - le paiement manuel (`payOrderWithWallet` sans option de consentement) et
 *    l'idempotence des CAS restent hors barrière : rien n'est réarmé ni
 *    rejoué.
 *
 * La racine (`renewsOrderId` remonté, garde 50) est append-only : la lecture
 * préalable est stable quel que soit l'interleaving.
 */

/** Racine de la chaîne de renouvellements (append-only, garde 50). */
export async function renewalChainRootId(
  tx: Prisma.TransactionClient,
  startId: string,
): Promise<string> {
  let cursor = startId;
  for (let depth = 0; depth < 50; depth++) {
    const row = await tx.order.findUnique({
      where: { id: cursor },
      select: { renewsOrderId: true },
    });
    if (!row?.renewsOrderId) return cursor;
    cursor = row.renewsOrderId;
  }
  return cursor;
}

/**
 * Acquiert la barrière transactionnelle de la chaîne (libérée au commit).
 * Toute mutation qui peut ARMER un descendant, et toute révocation en cascade,
 * doivent l'acquérir EN PREMIER dans leur transaction.
 */
export async function acquireRenewalChainBarrier(
  tx: Prisma.TransactionClient,
  rootId: string,
): Promise<void> {
  // Cast `::text` : pg_advisory_xact_lock() renvoie `void`, que Prisma
  // $queryRaw ne peut pas désérialiser (sinon toute tentative d'acquisition
  // échoue avant même le verrou).
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${rootId}, 0))::text`;
}
