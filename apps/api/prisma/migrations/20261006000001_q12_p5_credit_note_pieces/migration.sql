-- GO P5 — avoirs : PIÈCES DISTINCTES par remboursement (aucun cumul sur un
-- avoir déjà émis) + montants HT/taxe calculés depuis les lignes réellement
-- recréditées (traitement fiscal propre à chaque ligne, aucun taux global).
--
-- 1) `Invoice.creditNoteOfId` perd son unique : une facture d'origine peut
--    recevoir PLUSIEURS avoirs liés (numérotés sur la séquence partagée,
--    documents/PDF des pièces émises jamais mutés) ;
-- 2) `InvoiceLine.sourceLineId` : chaque ligne CREDIT référence la ligne
--    d'origine qu'elle recrédite → restes fiscaux exacts par ligne,
--    somme des pièces = totaux source sans dérive d'arrondi.

DROP INDEX "Invoice_creditNoteOfId_key";

CREATE INDEX "Invoice_creditNoteOfId_idx" ON "Invoice"("creditNoteOfId");

ALTER TABLE "InvoiceLine" ADD COLUMN "sourceLineId" TEXT;

CREATE INDEX "InvoiceLine_sourceLineId_idx" ON "InvoiceLine"("sourceLineId");
