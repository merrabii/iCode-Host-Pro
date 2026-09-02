-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "bandwidthLimit" TEXT,
ADD COLUMN     "cpuCores" INTEGER,
ADD COLUMN     "diskGb" INTEGER,
ADD COLUMN     "ramMb" INTEGER;
