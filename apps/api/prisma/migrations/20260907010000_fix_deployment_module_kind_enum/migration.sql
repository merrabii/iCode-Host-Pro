-- Phase 13 (correctif) : `DeploymentModule.kind` était créé TEXT par la migration
-- 20260906020000, alors que le schéma Prisma déclare l'enum native
-- "DeploymentModuleKind" (SHARED_PROJECT / PER_CLIENT_PROJECT). Le client Prisma
-- émet des requêtes attendue un type enum PostgreSQL ; sans lui, toute écriture
-- échoue (Postgres 42704 → 500 "Internal server error" à l'ajout d'un module).
-- Additive : crée l'enum + convertit la colonne existante. Aucune donnée touchée
-- (la table est vide ou ne contient que des valeurs valides du enum).
CREATE TYPE "DeploymentModuleKind" AS ENUM ('SHARED_PROJECT', 'PER_CLIENT_PROJECT');

ALTER TABLE "DeploymentModule"
  ALTER COLUMN "kind" TYPE "DeploymentModuleKind"
  USING "kind"::"DeploymentModuleKind";
