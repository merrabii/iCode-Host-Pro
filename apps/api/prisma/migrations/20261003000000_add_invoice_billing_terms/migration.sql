-- GO socle P7 (lot D1 — facturation complète) :
--   Échéance de paiement configurable (jours après émission) utilisée pour
--   `Invoice.dueDate` à la création, aux côtés des mentions légales figées
--   (`legalMentionsSnapshot` — colonne déjà existante, remplie dès l'émission).
--   ADDITIVE uniquement : défaut 14 jours = comportement raisonnable en
--   attendant l'arbitrage owner (§6-6).
ALTER TABLE "BillingSetting" ADD COLUMN "invoiceDueDays" INTEGER NOT NULL DEFAULT 14;
