-- Un SEUL projet Coolify par client par serveur (Module B).
-- La clé de dédup passe de (userId, serverId, moduleId) → (userId, serverId) :
-- la 2ème app du même client réutilise le projet existant, quel que soit le module.
-- moduleId devient nullable (trace uniquement ; onDelete SetNull au lieu de Cascade).

-- DropForeignKey
ALTER TABLE "ClientProject" DROP CONSTRAINT "ClientProject_moduleId_fkey";

-- DropIndex
DROP INDEX "ClientProject_userId_serverId_moduleId_key";

-- AlterTable
ALTER TABLE "ClientProject" ALTER COLUMN "moduleId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "ClientProject" ADD CONSTRAINT "ClientProject_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "DeploymentModule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "ClientProject_userId_serverId_key" ON "ClientProject"("userId", "serverId");