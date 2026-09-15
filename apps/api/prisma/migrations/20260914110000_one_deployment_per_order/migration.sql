-- Fix critique prod (2026-09-14) — une app STORE = une row Deployment dédiée,
-- liée à SA commande (`orderId` @unique). Empêche l'écrasement entre orders.
ALTER TABLE "Deployment" ADD COLUMN     "orderId" TEXT;

CREATE UNIQUE INDEX "Deployment_orderId_key" ON "Deployment"("orderId");

ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;