-- Bloc 1 — Modèle d'abonnement order-driven.
-- L'abonnement référence sa dernière commande store (création ou upgrade).
-- Tous les abonnements passent par la procédure de commande ; l'upgrade repointe
-- la MÊME ligne. 1:1, FK portée sur Subscription (côté non-possédant `Order.subscription`
-- = simple champ de relation, sans colonne).

-- Ajoute la colonne (unique) + FK vers Order.
ALTER TABLE "Subscription" ADD COLUMN "orderId" TEXT;

CREATE UNIQUE INDEX "Subscription_orderId_key" ON "Subscription"("orderId");

-- onDelete: SetNull — une commande supprimée ne cascade pas vers l'abonnement.
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;