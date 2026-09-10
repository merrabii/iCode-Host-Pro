-- CreateEnum
CREATE TYPE "CheckoutFieldType" AS ENUM ('TEXT', 'EMAIL', 'TEL');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "allowEditConfig" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "installationFeeCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ProductCheckoutField" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "CheckoutFieldType" NOT NULL DEFAULT 'TEXT',
    "placeholder" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductCheckoutField_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductCheckoutField_productId_idx" ON "ProductCheckoutField"("productId");

-- AddForeignKey
ALTER TABLE "ProductCheckoutField" ADD CONSTRAINT "ProductCheckoutField_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

