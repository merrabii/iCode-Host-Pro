-- GO V3 — correction des trois écarts résiduels de la revue V3.
-- STRICTEMENT ADDITIF : aucune ligne existante n'est modifiée ni supprimée.
--
-- 1) Exclusion des dispatchs concurrents (§1) : `dispatchOwner` = jeton unique
--    du propriétaire de la tentative EN COURS ; `dispatchClaimedAt` = début du
--    lease. Revendication exclusive (CAS), dépossession UNIQUEMENT si lease
--    expiré ou issue déjà tranchée en UNCERTAIN ; toutes les écritures de
--    résultat sont conditionnées au propriétaire courant (une réponse
--    TARDIVE d'un prédécesseur n'écrase jamais l'issue du successeur).
-- 2) Identité source durable des webhooks (§3) : compte marchand + ligne de
--    configuration + version (`updatedAt`) qui ont authentifié la signature,
--    persistés à la réception. Le rejeu (sweep) utilise CES colonnes, jamais
--    la configuration courante. NULL = événement antérieur à la capture →
--    rejeu conservateur visible, jamais d'origine inventée.

-- AlterTable
ALTER TABLE "CardPayment" ADD COLUMN "dispatchOwner" TEXT;
ALTER TABLE "CardPayment" ADD COLUMN "dispatchClaimedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN "dispatchOwner" TEXT;
ALTER TABLE "Refund" ADD COLUMN "dispatchClaimedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PaymentWebhookEvent" ADD COLUMN "merchantAccount" TEXT;
ALTER TABLE "PaymentWebhookEvent" ADD COLUMN "sourceSettingId" TEXT;
ALTER TABLE "PaymentWebhookEvent" ADD COLUMN "sourceConfigVersion" TIMESTAMP(3);
