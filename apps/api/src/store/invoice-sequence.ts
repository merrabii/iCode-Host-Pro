import { BillingSetting, Prisma } from '@prisma/client';

/**
 * P8 (lot D2) — numérotation des factures **partagée** (D1 + renouvellements).
 *
 * Un seul chemin d'acquisition de numéro pour tout le dépôt : ligne singleton
 * `BillingSetting` créée « sûre sous concurrence » (`INSERT … ON CONFLICT DO
 * NOTHING` + relecture), puis `UPDATE … RETURNING` sous verrou de ligne →
 * séquence monotone et numéros `AAAA-<seq>` uniques **même sous concurrence
 * réelle** (preuve e2e D1 : 6 checkouts parallèles). Exécuté TOUJOURS dans la
 * transaction de la commande/facture : un rollback restitue l'acquisition.
 *
 * Déplacé hors de `CheckoutService` (P8) pour que `RenewalService` réclame ses
 * numéros de renouvellement avec la garantie exacte de l'émission initiale —
 * comportement inchangé (corps verbatim, mêmes appels Prisma sur `tx`).
 */
export async function claimInvoiceSequence(
  tx: Prisma.TransactionClient,
): Promise<{
  currency: string;
  invoiceNumber: string;
  billing: BillingSetting;
}> {
  let billing = await tx.billingSetting.findFirst({
    orderBy: { createdAt: 'asc' },
  });
  if (!billing) {
    await tx.$queryRaw`
      INSERT INTO "BillingSetting" ("id", "currency", "companyName", "createdAt", "updatedAt")
      VALUES ('billing-settings', 'USD', 'Code Diali', NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING
    `;
    billing = await tx.billingSetting.findFirstOrThrow({
      orderBy: { createdAt: 'asc' },
    });
  }
  const rows = await tx.$queryRaw<{ next: number }[]>`
    UPDATE "BillingSetting"
    SET "invoiceSequence" = "invoiceSequence" + 1, "updatedAt" = NOW()
    WHERE "id" = ${billing.id}
    RETURNING "invoiceSequence" AS "next"
  `;
  const seq = Number(rows[0]?.next ?? 1) - 1;
  const invoiceNumber = `${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
  return { currency: billing.currency, invoiceNumber, billing };
}
