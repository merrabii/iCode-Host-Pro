-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reconcileLastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "reconcileNextAt" TIMESTAMP(3),
ADD COLUMN     "reconcileTerminalFailures" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Deployment_status_reconcileNextAt_idx" ON "Deployment"("status", "reconcileNextAt");
