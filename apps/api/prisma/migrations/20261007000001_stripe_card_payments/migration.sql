-- GO Stripe (lot carte) — Code Diali : connecteur carte en mode TEST.
-- Migrations autorisées UNIQUEMENT sur les bases isolées (pas de base live).
-- Aucune suppression, aucune réécriture de données existantes : 100 % additif
-- (avec NULL-ification de Refund.orderId, rendue possible par la nouvelle
-- alternative cardPaymentId) + rétro-remplissage démontré de la devise.

-- CreateEnum
CREATE TYPE "CardPaymentStatus" AS ENUM ('CREATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "CardPaymentKind" AS ENUM ('TOPUP');

-- CreateEnum
CREATE TYPE "PaymentWebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- AlterTable : devise EXPLICITE du solde (portefeuille mono-devise assumé).
ALTER TABLE "Customer" ADD COLUMN "walletCurrency" TEXT NOT NULL DEFAULT 'USD';

-- Rétro-remplissage sur base DÉMONTRÉE uniquement : la devise de facturation
-- de la plateforme (BillingSetting.currency, défaut USD) — jamais déduite d'un
-- montant isolé. Aucune ligne de solde n'est modifiée.
UPDATE "Customer" c
SET "walletCurrency" = COALESCE(
  (SELECT b."currency" FROM "BillingSetting" b ORDER BY b."createdAt" ASC LIMIT 1),
  'USD'
);

-- AlterTable : remboursement de recharge carte sans commande.
ALTER TABLE "Refund" ADD COLUMN     "cardPaymentId" TEXT,
ALTER COLUMN "orderId" DROP NOT NULL;

-- AlterTable : drapeau de litige visible (jamais de dette silencieuse).
ALTER TABLE "WalletTransaction" ADD COLUMN     "disputedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PaymentProviderSetting" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "environment" TEXT NOT NULL DEFAULT 'test',
    "liveEnabled" BOOLEAN NOT NULL DEFAULT false,
    "merchantAccount" TEXT,
    "publishableKey" TEXT,
    "secretKeyEnc" TEXT,
    "webhookSecretEnc" TEXT,
    "webhookEndpointUrl" TEXT,
    "allowedCurrencies" JSONB,
    "lastCheckAt" TIMESTAMP(3),
    "lastCheckAccount" TEXT,
    "lastCheckError" TEXT,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProviderSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardPayment" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" "CardPaymentKind" NOT NULL DEFAULT 'TOPUP',
    "status" "CardPaymentStatus" NOT NULL DEFAULT 'CREATED',
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "providerCode" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "merchantAccount" TEXT NOT NULL,
    "livemode" BOOLEAN,
    "providerSessionRef" TEXT,
    "providerPaymentRef" TEXT,
    "checkoutUrl" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "walletTransactionId" TEXT,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "disputedAt" TIMESTAMP(3),
    "interventionNeeded" BOOLEAN NOT NULL DEFAULT false,
    "interventionReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "providerCode" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "livemode" BOOLEAN,
    "environment" TEXT NOT NULL,
    "status" "PaymentWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB,
    "error" TEXT,
    "cardPaymentId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderSetting_code_key" ON "PaymentProviderSetting"("code");

-- CreateIndex
CREATE UNIQUE INDEX "CardPayment_reference_key" ON "CardPayment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "CardPayment_idempotencyKey_key" ON "CardPayment"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CardPayment_walletTransactionId_key" ON "CardPayment"("walletTransactionId");

-- CreateIndex
CREATE INDEX "CardPayment_customerId_idx" ON "CardPayment"("customerId");

-- CreateIndex
CREATE INDEX "CardPayment_status_idx" ON "CardPayment"("status");

-- CreateIndex
CREATE INDEX "CardPayment_providerSessionRef_idx" ON "CardPayment"("providerSessionRef");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_status_idx" ON "PaymentWebhookEvent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWebhookEvent_providerCode_eventId_key" ON "PaymentWebhookEvent"("providerCode", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_cardPaymentId_key" ON "Refund"("cardPaymentId");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_cardPaymentId_fkey" FOREIGN KEY ("cardPaymentId") REFERENCES "CardPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardPayment" ADD CONSTRAINT "CardPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_cardPaymentId_fkey" FOREIGN KEY ("cardPaymentId") REFERENCES "CardPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
