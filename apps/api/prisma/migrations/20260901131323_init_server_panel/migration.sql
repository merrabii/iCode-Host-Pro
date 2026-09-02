-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "apiBaseUrl" TEXT,
ADD COLUMN     "apiTokenEnc" TEXT,
ADD COLUMN     "apiUser" TEXT,
ADD COLUMN     "panelDetail" TEXT,
ADD COLUMN     "panelOk" BOOLEAN,
ADD COLUMN     "panelVerifiedAt" TIMESTAMP(3);
