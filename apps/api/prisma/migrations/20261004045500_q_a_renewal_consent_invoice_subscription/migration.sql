-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "subscriptionId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "renewalConsentAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
