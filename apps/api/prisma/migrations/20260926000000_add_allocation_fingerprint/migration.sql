-- 17B.4F-C1 — allocation : empreinte de réservation + intention provider.
--
-- STRICTEMENT ADDITIVE : deux `ALTER TABLE … ADD COLUMN` NULL uniquement.
-- Aucun DROP, aucun renommage destructif, aucune suppression de colonne,
-- aucun UPDATE ni DELETE, aucun backfill, aucune modification de contrainte,
-- d'index, de type ni d'autre table. Les lignes existantes restent intactes
-- (requestFingerprint/providerIntentAt = NULL, aucune interprétation rétro-
-- active : le moteur refuse un rejeu non vérifiable au lieu de le deviner).
--
--   requestFingerprint : empreinte HMAC versionnée `fp:v1:<hex>` du payload
--     exact de réservation (jamais journalisée) ;
--   providerIntentAt   : marqueur irréversible « intention provider locale »
--     committée avant tout appel réseau (jamais posé sur RELEASED).
--
-- Appliquée sur base de TEST isolee pour 17B.4F-C1 ; sur la base live elle
-- restera en attente (`prisma migrate status`) jusqu'au prochain déploiement
-- validé — aucune migration n'est exécutée ici sur `icode_host_pro`.

-- AlterTable
ALTER TABLE "HostingServiceAllocation" ADD COLUMN "requestFingerprint" TEXT;
ALTER TABLE "HostingServiceAllocation" ADD COLUMN "providerIntentAt" TIMESTAMP(3);
