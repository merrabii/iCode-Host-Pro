-- GO clôture §1 — union des remboursements DISTINCTS.
-- STRICTEMENT ADDITIF : aucune ligne existante n'est modifiée ni supprimée.
--
-- 1) Table `RefundObservation` : identité DURABLE des remboursements observés
--    côté prestataire (identité = (cardPaymentId, providerRef)). Le compteur
--    `CardPayment.refundedCents` devient une UNION de identités :
--      max(courant, internes soldés, observations externes distinctes,
--          plancher cumulatif charge.amount_refunded)
--    Le montant INDIVIDUEL d'un `refund.*` n'est plus traité comme un cumul.
-- 2) `amountCents NULL` = montant inconnu → incertitude explicite,
--    conservée jusqu'au rapprochement admin (`acknowledgedAt`).

-- CreateTable
CREATE TABLE "RefundObservation" (
    "id" TEXT NOT NULL,
    "cardPaymentId" TEXT NOT NULL,
    "providerCode" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "amountCents" INTEGER,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefundObservation_cardPaymentId_providerRef_key" ON "RefundObservation"("cardPaymentId", "providerRef");

-- CreateIndex
CREATE INDEX "RefundObservation_cardPaymentId_idx" ON "RefundObservation"("cardPaymentId");

-- AddForeignKey
ALTER TABLE "RefundObservation" ADD CONSTRAINT "RefundObservation_cardPaymentId_fkey" FOREIGN KEY ("cardPaymentId") REFERENCES "CardPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
