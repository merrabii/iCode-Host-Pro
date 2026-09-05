-- Phase 12 — Catalogue Produit → Catégorie + Pack (limites).
-- NB : volontairement ADDITIF. Les tables `Domain`/`CloudflareSetting` (et enums
-- associées) restent dans la base dev pour la Phase 3 (sélection de domaine via
-- l'API Cloudflare) ; elles ne sont pas retirées ici.

-- CreateEnum
CREATE TYPE "PackStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "categoryId" TEXT,
ADD COLUMN "packId" TEXT;

-- CreateTable
CREATE TABLE "HostingPack" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ramMb" INTEGER NOT NULL,
    "cpuCores" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "diskGb" INTEGER,
    "bandwidth" TEXT,
    "status" "PackStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostingPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "recommendedPackId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HostingPack_name_key" ON "HostingPack"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_name_key" ON "ProductCategory"("name");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_packId_fkey" FOREIGN KEY ("packId") REFERENCES "HostingPack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_recommendedPackId_fkey" FOREIGN KEY ("recommendedPackId") REFERENCES "HostingPack"("id") ON DELETE SET NULL ON UPDATE CASCADE;