import { CardPayment, CardPaymentStatus, Prisma, RefundStatus } from '@prisma/client';

export interface RefundSyncResult {
  refundedCents: number;
  overflow: boolean;
  changed: boolean;
  uncertain: boolean;
}

/**
 * GO revue §1 — comptabilisation UNITAIRE et monotone par UNION DES IDENTITÉS,
 * sous verrou ligne `FOR UPDATE`.
 *
 *   refundedCents = max(courant,
 *                       somme des remboursements INTERNES soldés (Refund),
 *                       somme des OBSERVATIONS EXTERNES distinctes
 *                         (RefundObservation, identité = providerRef,
 *                          non couvertes par une identité interne),
 *                       plancher CUMULATIF prestataire (charge.amount_refunded))
 *
 *  - le montant INDIVIDUEL d'un `refund.*` n'est JAMAIS traité comme un cumul :
 *    chaque identité externe compte UNE fois (deux remboursements externes 300
 *    puis 400 = UNION 700, jamais max → 400) ;
 *  - une observation portant la `providerRef` d'un remboursement interne
 *    (soldé ou en cours) décrit la MÊME opération : jamais recomptée ;
 *  - rejeu / concurrence : unicité `[cardPaymentId, providerRef]` + `max`
 *    monotone rendent le double count structurellement impossible ;
 *  - une observation `succeeded` SANS montant, non acquittée, est une
 *    INCERTITUDE explicite : `interventionNeeded` + motif « rapprochement » ;
 *    elle bloque les opérations dépendantes du plafond jusqu'à la levée
 *    admin (`acknowledgedAt`) — jamais lissée, jamais perdue ;
 *  - un dépassement du montant encaissé devient `NEEDS_REVIEW` + intervention ;
 *  - un état `NEEDS_REVIEW` préexistant n'est JAMAIS redescendu
 *    silencieusement par une observation ultérieure.
 *
 * Doit être appelé DANS une transaction déjà ouverte (l'appelant tient le
 * commit) ; la fonction reprend le verrou ligne (réentrant dans la même tx).
 */
export async function syncRefundedCents(
  tx: Prisma.TransactionClient,
  cardPaymentId: string,
  opts: { observedCumulativeCents?: number } = {},
): Promise<RefundSyncResult | null> {
  const rows = await tx.$queryRaw<CardPayment[]>`
    SELECT * FROM "CardPayment" WHERE id = ${cardPaymentId} FOR UPDATE`;
  const pay = rows[0];
  if (!pay) return null;

  const settled = await tx.refund.aggregate({
    where: { cardPaymentId: pay.id, status: RefundStatus.SUCCEEDED },
    _sum: { amountCents: true },
  });
  const internalSettled = settled._sum.amountCents ?? 0;

  // Identités internes déjà connues : une observation portant la même
  // providerRef décrit la MÊME opération (une identité = un montant).
  const internalRefs = new Set(
    (
      await tx.refund.findMany({
        where: { cardPaymentId: pay.id, providerRef: { not: null } },
        select: { providerRef: true },
      })
    )
      .map((r) => r.providerRef)
      .filter((v): v is string => v !== null),
  );

  const observations = await tx.refundObservation.findMany({
    where: { cardPaymentId: pay.id },
    select: { providerRef: true, amountCents: true, acknowledgedAt: true },
  });

  let observedExternal = 0;
  let uncertain = false;
  for (const obs of observations) {
    if (internalRefs.has(obs.providerRef)) continue;
    if (obs.amountCents === null) {
      if (!obs.acknowledgedAt) uncertain = true;
      continue;
    }
    observedExternal += Math.max(0, obs.amountCents);
  }

  const observedFloor = Math.max(0, Math.floor(opts.observedCumulativeCents ?? 0));
  // UNION : les identités INTERNES et EXTERNES non couvertes sont DISTINCTES
  // → elles se SOMMENT (400 interne ∪ 300 externe = 700, jamais max → 400) ;
  // le plancher cumulatif reste un plancher (jamais sommé deux fois) et le
  // courant est conservé (monotonie : aucun recul silencieux).
  const target = Math.max(
    pay.refundedCents,
    internalSettled + observedExternal,
    observedFloor,
  );
  const overflow = target > pay.amountCents;

  if (overflow) {
    await tx.cardPayment.update({
      where: { id: pay.id },
      data: {
        refundedCents: target,
        status: CardPaymentStatus.NEEDS_REVIEW,
        interventionNeeded: true,
        interventionReason: `remboursement cumulé (${target}) > montant encaissé (${pay.amountCents})`,
      },
    });
    return { refundedCents: target, overflow: true, changed: true, uncertain };
  }

  if (!uncertain && target === pay.refundedCents) {
    return { refundedCents: pay.refundedCents, overflow: false, changed: false, uncertain };
  }

  const nextStatus =
    pay.status === CardPaymentStatus.NEEDS_REVIEW || target <= 0
      ? undefined
      : target >= pay.amountCents
        ? CardPaymentStatus.REFUNDED
        : CardPaymentStatus.PARTIALLY_REFUNDED;

  await tx.cardPayment.update({
    where: { id: pay.id },
    data: {
      refundedCents: target,
      ...(nextStatus ? { status: nextStatus } : {}),
      ...(uncertain
        ? {
            interventionNeeded: true,
            interventionReason:
              'observation prestataire sans montant : rapprochement requis avant toute opération dépendante du plafond',
          }
        : {}),
    },
  });
  return {
    refundedCents: target,
    overflow: false,
    changed: target !== pay.refundedCents,
    uncertain,
  };
}
