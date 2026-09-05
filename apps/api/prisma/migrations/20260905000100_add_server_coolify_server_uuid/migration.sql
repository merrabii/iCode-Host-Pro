-- Phase 12 — serveur Coolify cible pour les déploiements. Additif.
-- Identique à coolifyProjectUuid : le uuid du serveur Coolify (défaut "0").
ALTER TABLE "Server" ADD COLUMN "coolifyServerUuid" TEXT;