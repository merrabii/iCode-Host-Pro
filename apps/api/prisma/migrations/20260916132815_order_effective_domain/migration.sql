-- Phase 4 — Order.requestedDomainId / effectiveDomainId (choix + gel racine).
-- NOTE : les DROP INDEX Deployment_limitsStatus_idx / Deployment_packId_idx
-- qu'avait détectés Prisma relèvent d'une DÉRIVE de schéma PREEXISTANTE (index
-- créés par 20260913120000_add_limits_tracking mais absents du modèle Deployment).
-- Hors périmètre Phase 4 (décision #19 : aucun changement hors Phase 4) → retirés
-- de cette migration et NON supprimés. À reconcilier séparément si voulu.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "effectiveDomainId" TEXT,
ADD COLUMN     "requestedDomainId" TEXT;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_requestedDomainId_fkey" FOREIGN KEY ("requestedDomainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_effectiveDomainId_fkey" FOREIGN KEY ("effectiveDomainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;
