-- 17B.4F-B1 — CORRECTIF PRÉ-COMMIT (référentiel fail-closed + CPU fini).
--
-- Migration STRICTEMENT LIMITÉE : remplacement exact des 4 FK du périmètre
-- hébergement (ON DELETE CASCADE/SET NULL → ON DELETE RESTRICT) + ajout d'UN
-- CHECK complémentaire sur la finitude de `cpuCoresSnapshot`.
-- Aucun changement de colonne, de table, de type ou d'index ; aucune donnée
-- modifiée ; aucune autre contrainte touchée. DROP CONSTRAINT + ADD CONSTRAINT
-- est autorisé ici UNIQUEMENT pour ces 4 contraintes : les tables HostingService
-- et HostingServiceAllocation sont encore VIDES (0 ligne) et les nouvelles
-- colonnes nullable ne sont liées à AUCUNE ligne (0 Deployment, 0 ClientProject
-- avec hostingServiceId NOT NULL) — aucune donnée métier n'est supprimée.
--
-- POLITIQUE RETENUE — fail-closed :
--   * HostingService.userId                      → RESTRICT (impossible de
--     supprimer un User possédant un service)
--   * HostingServiceAllocation.hostingServiceId  → RESTRICT (impossible de
--     supprimer un service portant une allocation)
--   * Deployment.hostingServiceId                → RESTRICT (impossible de
--     supprimer un service encore lié à un déploiement)
--   * ClientProject.hostingServiceId             → RESTRICT (impossible de
--     supprimer un service encore lié à un projet client)
--   → aucune désolidarisation silencieuse : cleanup métier OBLIGATOIRE avant
--     suppression. Aucun endpoint de suppression n'est ajouté.
-- Les 5 relations historiques (Order, Subscription, Product, HostingPack,
-- DeploymentModule) restent SET NULL — inchangées ci-dessous.
--
-- CPU FINI : `cpuCoresSnapshot >= 0` seul NE SUFIT PAS en PostgreSQL — vérifié
-- sur le moteur réel : 'NaN'::float8 >= 0 = vrai (NaN est le plus grand au
-- tri PG), 'Infinity'::float8 >= 0 = vrai. Seul '-Infinity' et les négatifs
-- sont déjà rejetés par le CHECK initial. Le CHECK ci-dessous ajoute donc les
-- refus explicites de NaN et ±Infinity, sans toucher au CHECK initial ni à
-- aucune donnée.

-- DropForeignKey (4, exceptionnellement autorisé — tables vides)
ALTER TABLE "ClientProject" DROP CONSTRAINT "ClientProject_hostingServiceId_fkey";
ALTER TABLE "Deployment" DROP CONSTRAINT "Deployment_hostingServiceId_fkey";
ALTER TABLE "HostingService" DROP CONSTRAINT "HostingService_userId_fkey";
ALTER TABLE "HostingServiceAllocation" DROP CONSTRAINT "HostingServiceAllocation_hostingServiceId_fkey";

-- AddForeignKey — ON DELETE RESTRICT (référentiel fail-closed)
ALTER TABLE "ClientProject" ADD CONSTRAINT "ClientProject_hostingServiceId_fkey" FOREIGN KEY ("hostingServiceId") REFERENCES "HostingService"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_hostingServiceId_fkey" FOREIGN KEY ("hostingServiceId") REFERENCES "HostingService"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HostingService" ADD CONSTRAINT "HostingService_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HostingServiceAllocation" ADD CONSTRAINT "HostingServiceAllocation_hostingServiceId_fkey" FOREIGN KEY ("hostingServiceId") REFERENCES "HostingService"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddCheck — CPU strictement FINI et positif (complément du CHECK initial).
-- Refuse : négatif (déjà couvert), NaN, Infinity, -Infinity (comportement PG
-- vérifié sur le moteur réel avant écriture de cette contrainte).
ALTER TABLE "HostingService" ADD CONSTRAINT "HostingService_cpuCoresSnapshot_finite_check" CHECK (
    "cpuCoresSnapshot" >= 0
    AND "cpuCoresSnapshot" <> 'NaN'::double precision
    AND "cpuCoresSnapshot" <> 'Infinity'::double precision
    AND "cpuCoresSnapshot" <> '-Infinity'::double precision
);
