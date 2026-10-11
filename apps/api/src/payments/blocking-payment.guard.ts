import { ConflictException } from '@nestjs/common';
import { CardPaymentStatus, Prisma } from '@prisma/client';

/**
 * Client Prisma « lisible » : client complet OU transaction — la garde ne
 * fait qu'une lecture `findFirst` (aucune écriture, aucun verrou).
 */
export type BlockingPaymentReader = Pick<Prisma.TransactionClient, 'cardPayment'>;

/**
 * GO revue §4 (C4.8) — aucun NOUVEL encaissement tant qu'une opération
 * carte du client reste non résolue : `UNCERTAIN` (issue non constatée) ou
 * `NEEDS_REVIEW` avec alerte admin ouverte. Une alerte LEVÉE par l'admin
 * (`resolveIntervention`) ne bloque plus : le cas est traité, l'historique
 * `NEEDS_REVIEW` reste consultable.
 *
 * Autorité UNIQUE partagée par la RECHARGE (`createTopup`), le RÈGLEMENT DE
 * COMMANDE PAR CARTE (`createOrderPayment`) et le RÈGLEMENT PAR SOLDE
 * (`payOrderWithWallet`) : mêmes conditions, même verbiage 409 — jamais trois
 * copies divergentes (une opération non résolue interdit TOUT nouveau
 * règlement, quel qu'en soit le mode).
 */
export async function assertNoBlockingCardPayment(
  prisma: BlockingPaymentReader,
  customerId: string,
): Promise<void> {
  const blocking = await prisma.cardPayment.findFirst({
    where: {
      customerId,
      OR: [
        { providerCallState: 'UNCERTAIN' },
        { status: CardPaymentStatus.NEEDS_REVIEW, interventionNeeded: true },
      ],
    },
    select: {
      reference: true,
      status: true,
      providerCallState: true,
      interventionNeeded: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!blocking) return;
  const detail =
    blocking.providerCallState === 'UNCERTAIN'
      ? `${blocking.reference} — résultat d'appel prestataire non établi (UNCERTAIN)`
      : `${blocking.reference} — ${blocking.status} (alerte admin ouverte)`;
  throw new ConflictException(
    `Résultat de paiement non résolu (${detail}) : aucun nouvel encaissement ` +
      'tant que l’issue n’est pas établie (reprise ou traitement admin requis).',
  );
}
