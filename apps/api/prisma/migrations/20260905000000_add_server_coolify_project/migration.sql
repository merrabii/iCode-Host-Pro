-- Phase 12 — projet Coolify cible pour les déploiements. Additif.
-- Le client choisit dans quel projet Coolify l'application est créée
-- (ex. "iCode Host Project"). Absent ⇒ la plateforme utilise le projet
-- par défaut Coolify ("0").
ALTER TABLE "Server" ADD COLUMN "coolifyProjectUuid" TEXT;