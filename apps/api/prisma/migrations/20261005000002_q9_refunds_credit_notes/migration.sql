-- GO Q9 (item 9 « Achever remboursements et avoirs du périmètre ») — ADDITIF.
--
-- `Refund` = journal des intentions de remboursement liées au paiement
-- d'origine (orderId + invoiceId) :
--   • plafond cumulé (PENDING + SUCCEEDED ≤ encaissé) appliqué sous verrou
--     FOR UPDATE de la commande (sérialisation propre à chaque commande) ;
--   • idempotence : `idempotencyKey` unique (même clé + même intention =
--     rejeu sans effet ; même clé + intention différente = 409) ;
--   • interne (WALLET_CREDIT) : wallet crédité dans la même transaction ;
--   • externe (EXTERNAL_CARD) : reste PENDING tant que le prestataire n'a pas
--     confirmé réellement (`providerRef` null) — jamais de succès déclaré sans
--     confirmation réelle (adaptateur carte non configuré, GO item 9) ;
--   • avoirs : `issueCreditNote` émet un Invoice lié via `creditNoteOfId`.

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundKind" AS ENUM ('WALLET_CREDIT', 'EXTERNAL_CARD');

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "kind" "RefundKind" NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "reason" TEXT,
    "issueCreditNote" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,
    "walletTransactionId" TEXT,
    "creditNoteInvoiceId" TEXT,
    "providerRef" TEXT,
    "createdByUserId" TEXT,
    "createdByEmail" TEXT,
    "failureReason" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "Refund"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_walletTransactionId_key" ON "Refund"("walletTransactionId");

-- (pas d'unicité sur creditNoteInvoiceId : plusieurs remboursements peuvent
--  cumuler le MÊME avoir — invariant « un seul avoir par facture » porté par
--  Invoice.creditNoteOfId unique, hérité du tunnel boutique 9a7968c)

-- CreateIndex
CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_walletTransactionId_fkey" FOREIGN KEY ("walletTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_creditNoteInvoiceId_fkey" FOREIGN KEY ("creditNoteInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
