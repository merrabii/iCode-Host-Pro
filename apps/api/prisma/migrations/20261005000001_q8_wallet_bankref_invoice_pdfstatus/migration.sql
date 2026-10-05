-- GO Q8 (item 8 « Durcir virements et documents privés ») — ADDITIF uniquement.
--
-- 1. `WalletTransaction.bankRef` : référence de rapprochement bancaire saisie
--    par l'ADMIN au moment de la constatation des fonds (validation). Unicité
--    PostgreSQL = un même encaissement ne peut financer qu'UN seul crédit
--    (unique violé → transaction avortée, aucun crédit partiel possible).
--    Null tant que le dépôt n'est que « justificatif déposé » (PENDING).
ALTER TABLE "WalletTransaction" ADD COLUMN "bankRef" TEXT;

-- 2. `Invoice.pdfRenderedStatus` : statut de paiement rendu dans le PDF
--    courant. Politique explicite (GO Q8) : le statut affiché est TOUJOURS le
--    statut ACTUEL de la facture à la génération ; le fichier est re-généré
--    dès que `status` change, les données d'émission restant figées.
ALTER TABLE "Invoice" ADD COLUMN "pdfRenderedStatus" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_bankRef_key" ON "WalletTransaction"("bankRef");
