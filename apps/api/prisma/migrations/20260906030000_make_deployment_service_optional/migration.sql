-- Phase 13 — le client peut déployer SANS choisir un Service (cible résolue
-- depuis le pack ACTIF → module A/B). serviceId devient optionnel.
-- Additive : simple DROP NOT NULL, aucune donnée touchée.
ALTER TABLE "Deployment" ALTER COLUMN "serviceId" DROP NOT NULL;
