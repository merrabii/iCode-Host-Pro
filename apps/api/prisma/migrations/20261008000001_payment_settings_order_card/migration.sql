-- Lot « paiement direct des commandes » + « réglages moyens de paiement ».
-- STRICTEMENT ADDITIF : aucune donnée existante n'est modifiée ni supprimée.
--
-- 1) `CardPaymentKind.ORDER` : règlement DIRECT d'une commande par carte
--    (aucun mouvement de portefeuille). Nouvelle valeur d'enum = nouveau
--    moyen : il n'est activé par AUCUNE écriture de migration (activation
--    explicite côté application via PaymentSettings).
-- 2) `CardPayment.orderId` : rattachement paiement → commande (NON unique :
--    tentatives multiples possibles, le règlement unique est garanti par le
--    CAS `PENDING_PAYMENT → PAID` sous verrou commande).
-- 3) `PaymentSettings` : singleton des interrupteurs de parcours.
--    RÈGLE DE MIGRATION DOCUMENTÉE : le NOUVEAU « paiement direct par carte »
--    est créé DÉSACTIVÉ (cardOrderPaymentEnabled = false) ; les réglages
--    existants sont préservés (solde et recharge carte restent disponibles,
--    cardOrderPaymentEnabled seul contrôle le nouveau parcours). Aucune ligne
--    PaymentMethod n'est touchée, aucun moyen n'est activé automatiquement.

-- AlterEnum (PG >= 12 : exécutable dans une transaction, la valeur n'est pas
-- utilisée dans ce même script)
ALTER TYPE "CardPaymentKind" ADD VALUE IF NOT EXISTS 'ORDER';

-- AlterTable
ALTER TABLE "CardPayment" ADD COLUMN IF NOT EXISTS "orderId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CardPayment_orderId_idx" ON "CardPayment"("orderId");

-- CreateTable
CREATE TABLE IF NOT EXISTS "PaymentSettings" (
    "id" TEXT NOT NULL,
    "walletPaymentEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cardOrderPaymentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "cardTopupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentSettings_pkey" PRIMARY KEY ("id")
);

-- Seed du singleton (uniquement si absent — jamais d'activation d'un nouveau moyen)
INSERT INTO "PaymentSettings" ("id", "walletPaymentEnabled", "cardOrderPaymentEnabled", "cardTopupEnabled", "updatedAt")
VALUES ('singleton', true, false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
