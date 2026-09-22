-- 17B.4C1 — singleton des overrides admin du réconciliateur asynchrone.
-- Migration STRICTEMENT ADDITIVE : CREATE TABLE uniquement.
-- Aucun UPDATE/DELETE/DROP, aucune modification d'une table existante,
-- aucun backfill, aucune recréation.
-- Le singleton est garanti par la PRIMARY KEY sur l'id fixe 'reconcile'
-- (convention BrandConfig « id: 'brand' ») : jamais plusieurs lignes actives.

-- CreateTable
CREATE TABLE "ReconcileSetting" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN,
    "scanIntervalMs" INTEGER,
    "batchSize" INTEGER,
    "leaseMs" INTEGER,
    "attemptAlertThreshold" INTEGER,
    "backoffInitialMs" INTEGER,
    "maxBackoffMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconcileSetting_pkey" PRIMARY KEY ("id")
);