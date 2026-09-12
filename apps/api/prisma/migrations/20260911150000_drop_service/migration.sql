-- Bloc 4 — suppression entière de la table/model `Service` (Décision c) :
-- tous les abonnements/services passent par la procédure de commande store.
-- Ordre sûr : la FK Deployment.serviceId référence Service, donc on la retire
-- AVANT de supprimer la table (respect des contraintes).

-- 1) Retirer la colonne/relation Deployment.serviceId (déploiements sans Service).
ALTER TABLE "Deployment" DROP CONSTRAINT IF EXISTS "Deployment_serviceId_fkey";
DROP INDEX IF EXISTS "Deployment_serviceId_idx";
ALTER TABLE "Deployment" DROP COLUMN IF EXISTS "serviceId";

-- 2) Supprimer la table Service (ses propres FK vers Subscription/Server partent avec).
DROP TABLE IF EXISTS "Service";

-- 3) Supprimer l'enum associé.
DROP TYPE IF EXISTS "ServiceStatus";