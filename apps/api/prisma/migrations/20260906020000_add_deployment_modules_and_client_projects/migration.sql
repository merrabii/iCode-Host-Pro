-- Phase 13 — modules/méthodes de déploiement (A/B) + projets Coolify par client.
-- Additive : tables nouvelles + ALTER TABLE ADD COLUMN IF NOT EXISTS.
-- Le quota disque (storageLimit) reste ENREGISTRÉ mais non appliqué (inchangé).

-- Module de déploiement (A = SHARED_PROJECT / B = PER_CLIENT_PROJECT).
CREATE TABLE IF NOT EXISTS "DeploymentModule" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "serverId" TEXT,
  "sharedProjectUuid" TEXT,
  "sharedProjectName" TEXT,
  "perClientPrefix" TEXT NOT NULL DEFAULT 'client',
  "overrideRamMb" INTEGER,
  "overrideCpuCores" DOUBLE PRECISION,
  "overrideStorageLimit" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeploymentModule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DeploymentModule_name_key" ON "DeploymentModule"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "DeploymentModule_code_key" ON "DeploymentModule"("code");
ALTER TABLE "DeploymentModule" ADD CONSTRAINT "DeploymentModule_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Projet Coolify dédié d'un client (Module B) — un par (client, serveur, module).
CREATE TABLE IF NOT EXISTS "ClientProject" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "moduleId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "projectUuid" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientProject_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "ClientProject" ADD CONSTRAINT "ClientProject_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientProject" ADD CONSTRAINT "ClientProject_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientProject" ADD CONSTRAINT "ClientProject_moduleId_fkey"
  FOREIGN KEY ("moduleId") REFERENCES "DeploymentModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "ClientProject_userId_serverId_moduleId_key"
  ON "ClientProject"("userId", "serverId", "moduleId");
CREATE INDEX IF NOT EXISTS "ClientProject_userId_idx" ON "ClientProject"("userId");

-- Pack : quota d'apps + module de déploiement.
ALTER TABLE "HostingPack" ADD COLUMN IF NOT EXISTS "maxApps" INTEGER;
ALTER TABLE "HostingPack" ADD COLUMN IF NOT EXISTS "deploymentModuleId" TEXT;
ALTER TABLE "HostingPack" ADD CONSTRAINT "HostingPack_deploymentModuleId_fkey"
  FOREIGN KEY ("deploymentModuleId") REFERENCES "DeploymentModule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Déploiement : trace du projet/module d'appartenance (monitoring + support).
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "coolifyProjectUuid" TEXT;
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "moduleId" TEXT;
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "clientProjectId" TEXT;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_moduleId_fkey"
  FOREIGN KEY ("moduleId") REFERENCES "DeploymentModule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_clientProjectId_fkey"
  FOREIGN KEY ("clientProjectId") REFERENCES "ClientProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;