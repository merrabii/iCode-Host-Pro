-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "lastProbeDetail" TEXT,
ADD COLUMN     "lastProbeOk" BOOLEAN;
