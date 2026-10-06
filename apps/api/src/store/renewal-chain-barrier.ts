import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Barrière transactionnelle commune de la chaîne de renouvellements
 * (GO fenêtres résiduelles R1 + GO limite de chaîne) — fenêtres close :
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
 * GO limite de chaîne — la remontée est MAINTENANT UN PARCOURS COMPLET
 * (plus de « garde 50 » silencieuse qui retournait un ancêtre INTERMÉDIAIRE
 * comme racine, c'est-à-dire une clé de verrou différante selon le point de
 * départ) :
 *  - **cycle** (`renewsOrderId` circulaire) → refus explicite
 *    `chaine_cyclique`, jamais une boucle ni une racine fausse ;
 *  - **référence manquante** (mère introuvable, pointeur orphelin) → refus
 *    explicite `chaine_reference_absente`, jamais une racine fantôme ;
 *  - **profondeur** → garde `RENEWAL_CHAIN_MAX_DEPTH` → refus explicite
 *    `chaine_profondeur_depassee` (jamais de troncature silencieuse : tout
 *    échec lève une exception DANS la transaction → rollback complet) ;
 *  - toute opération d'une même chaîne, quel que soit son point de départ,
 *    dérive donc la racine RÉELLE → même clé de verrouillage.
 *
 * La racine (`renewsOrderId` remonté) est append-only : la lecture
 * préalable est stable quel que soit l'interleaving.
 */

/** Garde de profondeur : au-delà, refus EXPLICITE (jamais de troncature). */
export const RENEWAL_CHAIN_MAX_DEPTH = 1000;

/**
 * Racine RÉELLE de la chaîne de renouvellements : remonte `renewsOrderId`
 * jusqu'à la commande sans mère, avec détection de cycle, de référence
 * manquante et garde de profondeur — toute anomalie lève un
 * `ConflictException` (rollback complet côté transactionnel).
 */
export async function renewalChainRootId(
  tx: Prisma.TransactionClient,
  startId: string,
): Promise<string> {
  const visited = new Set<string>();
  let cursor = startId;
  for (;;) {
    if (visited.has(cursor)) {
      throw new ConflictException(
        `chaine_cyclique: référence circulaire détectée en remontant la chaîne (commande ${cursor}).`,
      );
    }
    if (visited.size >= RENEWAL_CHAIN_MAX_DEPTH) {
      throw new ConflictException(
        `chaine_profondeur_depassee: chaîne de renouvellement de plus de ${RENEWAL_CHAIN_MAX_DEPTH} maillons (commande ${cursor}).`,
      );
    }
    visited.add(cursor);
    const row = await tx.order.findUnique({
      where: { id: cursor },
      select: { renewsOrderId: true },
    });
    if (!row) {
      throw new ConflictException(
        `chaine_reference_absente: commande ${cursor} introuvable en remontant la chaîne de renouvellement.`,
      );
    }
    if (!row.renewsOrderId) return cursor;
    cursor = row.renewsOrderId;
  }
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
