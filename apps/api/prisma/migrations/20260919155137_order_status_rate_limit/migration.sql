-- AlterTable
ALTER TABLE "SecuritySetting" ADD COLUMN     "orderStatusRateLimitEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "orderStatusRateLimitMax" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "orderStatusRateLimitWindowSec" INTEGER NOT NULL DEFAULT 60;
