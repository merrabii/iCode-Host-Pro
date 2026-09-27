-- 17B.4F-C3 — table dédiée de tracking de provisioning C3.
--
-- STRICTEMENT ADDITIVE : une seule `CREATE TABLE` + FK vers "Order".
-- Aucune colonne n'est ajoutée à "Order" (décision du plan corrigé : le
-- fail-fast boot sur colonnes Order a été rejeté au profit d'une table
-- dédiée), aucun DROP, aucun renommage, aucun UPDATE/DELETE, aucun backfill,
-- aucune modification de contrainte ou d'index d'une table existante.
-- Les commandes existantes n'ont AUCUNE ligne ici : sous OFF, le routage
-- legacy est préservé ; sous ON, l'absence de ligne = ancien achat (legacy
-- sécurisé par la capability C1+C3).
--
--   orderId    : PK = FK vers "Order" (1:1, Cascade — une ligne par commande) ;
--   intent     : payload de réservation figé au checkout (ReservationPayload) ;
--   leaseUntil : expiration du lease du claim du worker ;
--   claimToken : jeton d'identité du worker détenteur du claim.
--
-- Appliquée sur base de TEST isolée pour 17B.4F-C3 ; sur la base live elle
-- restera en attente (`prisma migrate status`) jusqu'au prochain déploiement
-- validé — aucune migration n'est exécutée ici sur `icode_host_pro`.

-- CreateTable
CREATE TABLE "OrderProvisioningTracking" (
    "orderId" TEXT NOT NULL,
    "intent" JSONB NOT NULL,
    "leaseUntil" TIMESTAMP(3),
    "claimToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderProvisioningTracking_pkey" PRIMARY KEY ("orderId")
);

-- AddForeignKey
ALTER TABLE "OrderProvisioningTracking" ADD CONSTRAINT "OrderProvisioningTracking_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
