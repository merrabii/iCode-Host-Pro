-- Phase 17 (3a/3c/3d) — QotaLimites (par pack) + suivi de l'application des limites
-- Sur Deployment :
--   * packId                    (FK HostingPack, SetNull) — pack à l'origine de la création
--   * limitsStatus              (enum LimitsStatus) — APPLIED | FAILED | PENDING_RETRY
--   * limitsRamMb / limitsCpu   — limites EFFECTIVES appliquées à la création (override module incluse)
--   * limitsRetryCount / limitsLastError — suivi re-application manuelle (anti-spam)

ALTER TABLE "Deployment" ADD COLUMN "packId" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "limitsRamMb" INTEGER;
ALTER TABLE "Deployment" ADD COLUMN "limitsCpu" DOUBLE PRECISION;
ALTER TABLE "Deployment" ADD COLUMN "limitsRetryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Deployment" ADD COLUMN "limitsLastError" TEXT;

-- Enum LimitsStatus : géré via un champ texte + contrainte CHECK (équiv. `prisma enum`).
CREATE TYPE "LimitsStatus" AS ENUM ('APPLIED', 'FAILED', 'PENDING_RETRY');
ALTER TABLE "Deployment" ADD COLUMN "limitsStatus" "LimitsStatus";

-- FK partielle vers HostingPack (les apps legacy sans pack gardent packId = NULL).
ALTER TABLE "Deployment"
  ADD CONSTRAINT "Deployment_packId_fkey"
  FOREIGN KEY ("packId") REFERENCES "HostingPack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Deployment_packId_idx" ON "Deployment"("packId");
CREATE INDEX "Deployment_limitsStatus_idx" ON "Deployment"("limitsStatus");