-- GO socle commercial — confirmation de paiement des commandes.
--
-- STRICTEMENT ADDITIVE : 4 colonnes NULLables sur "Order" + 1 index simple +
-- 1 index unique (clientKey). Aucun DROP, aucun renommage, aucune
-- UPDATE/DELETE, aucun backfill, aucune modification de contrainte ou
-- d'index existant. Les anciennes migrations sont inchangées.
--
--   -> paidAt           : instant T de la CONFIRMATION serveur du règlement
--                         (jamais inféré d'une méthode de paiement active).
--   -> idempotencyBase  : hash d'intention de contenu (chaîne des rachats
--                         après annulation SANS supprimer les anciennes clés).
--   -> clientKey        : clé d'idempotence fournie par le client (header
--                         Idempotency-Key) — unique ; conflit si contenu
--                         différent pour une même clé.
--   -> clientKeyHash    : empreinte du contenu associée à clientKey.
--
-- Toutes les nouvelles colonnes sont NULLables : ligne d'ordre existante =
-- NULL, aucun impact sur les parcours historiques.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "paidAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "idempotencyBase" TEXT;
ALTER TABLE "Order" ADD COLUMN "clientKey" TEXT;
ALTER TABLE "Order" ADD COLUMN "clientKeyHash" TEXT;

-- CreateIndex
CREATE INDEX "Order_idempotencyBase_idx" ON "Order"("idempotencyBase");

-- CreateIndex
CREATE UNIQUE INDEX "Order_clientKey_key" ON "Order"("clientKey");
