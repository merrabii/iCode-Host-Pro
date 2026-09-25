-- 17B.4F-B1 — fondation ADDITIVE : `HostingService` (service acheté) +
-- `HostingServiceAllocation` (réservation persistante d'un slot d'application)
-- + relations de TRANSITION nullable sur Deployment / ClientProject.
--
-- STRICTEMENT ADDITIVE : CREATE TYPE / CREATE TABLE / ALTER TABLE ADD COLUMN
-- nullable / CREATE INDEX / ADD CONSTRAINT uniquement. Aucun DROP, aucun
-- renommage destructif, aucune suppression de colonne, aucun UPDATE ni DELETE,
-- aucun backfill, aucune modification d'Invoice ni de statut existant, aucun
-- déplacement provider, aucun projet créé. La migration ne crée AUCUN
-- HostingService ni AUCUNE allocation : toutes les lignes existantes restent
-- intactes et tous les Deployments/ClientProjects legacy gardent
-- hostingServiceId = NULL.
--
-- Contraintes CHECK sûrs (>= 0 sur les snapshots) : défense en profondeur de
-- l'invariant « valeur négative interdite ». Vérifié sans drift Prisma
-- (`prisma migrate diff --from-url --to-schema-datamodel` → No difference
-- detected) : le moteur de migration ne gère pas les CHECK et ne les rejette
-- donc pas dans un futur `migrate dev`.

-- CreateEnum
CREATE TYPE "HostingServiceStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'CANCELLATION_PENDING', 'CANCELLED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "HostingServiceAllocationStatus" AS ENUM ('RESERVED', 'BOUND', 'RELEASING', 'RELEASED');

-- AlterTable
ALTER TABLE "ClientProject" ADD COLUMN     "hostingServiceId" TEXT;

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "hostingServiceId" TEXT;

-- CreateTable
CREATE TABLE "HostingService" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "subscriptionId" TEXT,
    "productId" TEXT,
    "packId" TEXT,
    "deploymentModuleId" TEXT,
    "status" "HostingServiceStatus" NOT NULL DEFAULT 'PROVISIONING',
    "maxAppsSnapshot" INTEGER,
    "ramMbSnapshot" INTEGER NOT NULL,
    "cpuCoresSnapshot" DOUBLE PRECISION NOT NULL,
    "storageLimitGbSnapshot" INTEGER,
    "packNameSnapshot" TEXT,
    "productNameSnapshot" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostingService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostingServiceAllocation" (
    "id" TEXT NOT NULL,
    "hostingServiceId" TEXT NOT NULL,
    "deploymentId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "HostingServiceAllocationStatus" NOT NULL DEFAULT 'RESERVED',
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "boundAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostingServiceAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HostingService_orderId_key" ON "HostingService"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "HostingService_subscriptionId_key" ON "HostingService"("subscriptionId");

-- CreateIndex
CREATE INDEX "HostingService_userId_idx" ON "HostingService"("userId");

-- CreateIndex
CREATE INDEX "HostingService_status_idx" ON "HostingService"("status");

-- CreateIndex
CREATE INDEX "HostingService_packId_idx" ON "HostingService"("packId");

-- CreateIndex
CREATE UNIQUE INDEX "HostingServiceAllocation_deploymentId_key" ON "HostingServiceAllocation"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "HostingServiceAllocation_idempotencyKey_key" ON "HostingServiceAllocation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "HostingServiceAllocation_hostingServiceId_status_idx" ON "HostingServiceAllocation"("hostingServiceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClientProject_hostingServiceId_serverId_key" ON "ClientProject"("hostingServiceId", "serverId");

-- CreateIndex
CREATE INDEX "Deployment_hostingServiceId_idx" ON "Deployment"("hostingServiceId");

-- AddCheck — snapshots contractuels jamais négatifs (maxApps null = illimité,
-- convention explicite du repo ; les autres nulls = valeur non renseignée).
ALTER TABLE "HostingService" ADD CONSTRAINT "HostingService_maxAppsSnapshot_check" CHECK ("maxAppsSnapshot" >= 0);
ALTER TABLE "HostingService" ADD CONSTRAINT "HostingService_ramMbSnapshot_check" CHECK ("ramMbSnapshot" >= 0);
ALTER TABLE "HostingService" ADD CONSTRAINT "HostingService_cpuCoresSnapshot_check" CHECK ("cpuCoresSnapshot" >= 0);
ALTER TABLE "HostingService" ADD CONSTRAINT "HostingService_storageLimitGbSnapshot_check" CHECK ("storageLimitGbSnapshot" IS NULL OR "storageLimitGbSnapshot" >= 0);

-- AddForeignKey
ALTER TABLE "ClientProject" ADD CONSTRAINT "ClientProject_hostingServiceId_fkey" FOREIGN KEY ("hostingServiceId") REFERENCES "HostingService"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_hostingServiceId_fkey" FOREIGN KEY ("hostingServiceId") REFERENCES "HostingService"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostingService" ADD CONSTRAINT "HostingService_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostingService" ADD CONSTRAINT "HostingService_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostingService" ADD CONSTRAINT "HostingService_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostingService" ADD CONSTRAINT "HostingService_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostingService" ADD CONSTRAINT "HostingService_packId_fkey" FOREIGN KEY ("packId") REFERENCES "HostingPack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostingService" ADD CONSTRAINT "HostingService_deploymentModuleId_fkey" FOREIGN KEY ("deploymentModuleId") REFERENCES "DeploymentModule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostingServiceAllocation" ADD CONSTRAINT "HostingServiceAllocation_hostingServiceId_fkey" FOREIGN KEY ("hostingServiceId") REFERENCES "HostingService"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostingServiceAllocation" ADD CONSTRAINT "HostingServiceAllocation_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
