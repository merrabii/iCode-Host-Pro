-- GO Stripe (lot carte) — correction d'index : PLUSIEURS remboursements
-- partiels possibles sur un même paiement carte (l'unicité d'intention est
-- portée par `Refund.idempotencyKey`, déjà unique). Additif : aucun retrait
-- de donnée.

-- DropIndex
DROP INDEX "Refund_cardPaymentId_key";

-- CreateIndex
CREATE INDEX "Refund_cardPaymentId_idx" ON "Refund"("cardPaymentId");
