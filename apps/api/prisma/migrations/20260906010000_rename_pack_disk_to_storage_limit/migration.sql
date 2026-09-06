-- Renomme le quota disque du pack (Plan) `diskGb` → `storageLimit`.
-- Architecture cible : Plan.cpu_limit / memory_limit / storage_limit.
-- storageLimit est ENREGISTRÉ mais le système de quota disque n'est PAS encore
-- actif (seule RAM/CPU sont appliqués au déploiement) ; il sera branché après
-- la mise en prod. La valeur existante (ex. 2 sur "Starter Real 1Go") est
-- préservée par le RENAME.
ALTER TABLE "HostingPack" RENAME COLUMN "diskGb" TO "storageLimit";