-- CreateEnum
CREATE TYPE "ServerPanelProvider" AS ENUM ('NONE', 'HESTIA', 'COOLIFY');

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "panelProvider" "ServerPanelProvider" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "port" INTEGER,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "quotaMaxAccounts" INTEGER,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "strictTls" BOOLEAN NOT NULL DEFAULT true;
