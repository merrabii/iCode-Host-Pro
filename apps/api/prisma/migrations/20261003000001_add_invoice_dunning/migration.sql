-- GO socle P8 (lot D2 — abonnements récurrents / dunning) :
--   Marqueur d'idempotence de la relance d'impayé : une facture UNPAID est
--   rappelée UNE SEULE FOIS (`dunningRemindedAt`), le scheduler enchaîne ensuite
--   avec la suspension à échéance (`dueDate + dunningGraceDays`).
--   ADDITIVE uniquement : colonne nullable, aucun défaut, aucune contrainte.
ALTER TABLE "Invoice" ADD COLUMN "dunningRemindedAt" TIMESTAMP(3);
