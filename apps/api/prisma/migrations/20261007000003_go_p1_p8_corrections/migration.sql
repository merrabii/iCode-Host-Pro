-- GO Stripe — corrections consolidées P1–P8 (Code Diali).
-- Migrations autorisées UNIQUEMENT sur les bases isolées (jamais de base live).
-- 100 % ADDITIF : aucune suppression, aucune réécriture de données existantes,
-- aucune modification des migrations déjà appliquées (20261007000001 / 2).
--
--  P3  CardPayment.providerCallState  — état de l'APPEL PRESTATAIRE de création
--      (null | DISPATCHED | RESOLVED | UNCERTAIN), distinct du statut métier :
--      une réponse perdue n'est plus tranchée en FAILED, elle est REPRENABLE
--      avec la même clé d'idempotence prestataire (rejeu sûr Stripe : 24 h).
--  P3  CardPayment.dispatchedAt       — instant du dernier envoi réseau ; au-delà
--      de 24 h la clé est épongée chez Stripe → plus de reprise automatique.
--  P5  Refund.dispatchedAt            — instant commis AVANT le réseau :
--      null = « jamais envoyée » (annulation sûre + compensation),
--      non null = « envoyée mais non résolue » (incertain, pas de recrédit).
--  P6  CardPayment.pendingRefundCents — réservations/engagements distincts des
--      montants RÉELLEMENT remboursés (refundedCents) : plafond exact, sans
--      Math.min masquant.
--  P3  PaymentWebhookEvent.reconcileAt / reconciledAt — rapprochement durable
--      d'un événement reçu avant le rattachement des références.

-- AlterTable (P6 + P3)
ALTER TABLE "CardPayment" ADD COLUMN "pendingRefundCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CardPayment" ADD COLUMN "providerCallState" TEXT;
ALTER TABLE "CardPayment" ADD COLUMN "dispatchedAt" TIMESTAMP(3);

-- AlterTable (P5)
ALTER TABLE "Refund" ADD COLUMN "dispatchedAt" TIMESTAMP(3);

-- AlterTable (P3)
ALTER TABLE "PaymentWebhookEvent" ADD COLUMN "reconcileAt" TIMESTAMP(3);
ALTER TABLE "PaymentWebhookEvent" ADD COLUMN "reconciledAt" TIMESTAMP(3);

-- CreateIndex (P6 — lookup remboursement par référence prestataire)
CREATE INDEX "Refund_providerRef_idx" ON "Refund"("providerRef");

-- CreateIndex (P3 — file de rapprochement)
CREATE INDEX "PaymentWebhookEvent_reconcileAt_idx" ON "PaymentWebhookEvent"("reconcileAt");
