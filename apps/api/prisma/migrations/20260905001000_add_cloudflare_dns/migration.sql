-- Phase 3 — DNS & sous-domaines Cloudflare. MIGRATION ADDITIVE.
-- TOLÉRANTE : si une migration non-trackée antérieure a déjà créé ces tables/
-- colonnes en dev (drift connu sur cette base), on ne fait pas planter `deploy`.
-- Les enregistrements DNS eux-mêmes restent LA VÉRITÉ Live chez Cloudflare ; ces
-- tables ne portent que la configuration plateforme (compte, racines, sous-domaines).

-- ────────────────────────────────────────────────────────────────────────────
-- RÉCONCILIATION DU DRIFT : une tentative antérieure NON livrée a créé des
-- tables orphelines `CloudflareSetting` (shape `enabled`/`platformDomain`/
-- `zoneId`, 1 row résiduelle e2e) et `Domain` (model par-utilisateur complète-
-- ment différent, 0 row) qui brimaient la forme du schéma. On les retire pour
-- recréer le modèle prévu proprement. La seule FK réelle (`Deployment.domainId`
-- → Domain, vide) est recréée plus bas dans cette migration.
-- ────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "ClientSubdomain" CASCADE;
DROP TABLE IF EXISTS "CloudflareSetting" CASCADE;
DROP TABLE IF EXISTS "Domain" CASCADE;

-- Enums (gardés par DO $$ … IF NOT EXISTS, Postgres < 15 sans IF NOT EXISTS).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DomainStatus') THEN
    CREATE TYPE "DomainStatus" AS ENUM ('ACTIVE', 'DISABLED');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SubdomainStatus') THEN
    CREATE TYPE "SubdomainStatus" AS ENUM ('PENDING', 'CREATED', 'ERROR');
  END IF;
END $$;

-- CloudflareSetting — SINGLETON (≤ 1 racine, même patron que SecuritySetting).
CREATE TABLE IF NOT EXISTS "CloudflareSetting" (
  "id"           TEXT NOT NULL,
  "apiTokenEnc"  TEXT,
  "accountEmail" TEXT,
  "rootDomainId" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CloudflareSetting_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CloudflareSetting_rootDomainId_key" ON "CloudflareSetting"("rootDomainId");
CREATE INDEX IF NOT EXISTS "CloudflareSetting_rootDomainId_idx" ON "CloudflareSetting"("rootDomainId");

-- Domain — zones racines importées (la "liste" admin).
CREATE TABLE IF NOT EXISTS "Domain" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "zoneId"      TEXT NOT NULL,
  "cnameTarget" TEXT,
  "status"      "DomainStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Domain_name_key" ON "Domain"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "Domain_zoneId_key" ON "Domain"("zoneId");

-- ClientSubdomain — allocation d'un sous-domaine à l'app d'un client.
CREATE TABLE IF NOT EXISTS "ClientSubdomain" (
  "id"           TEXT NOT NULL,
  "subdomain"    TEXT NOT NULL,
  "domainId"     TEXT NOT NULL,
  "fqdn"         TEXT NOT NULL,
  "recordId"     TEXT,
  "status"       "SubdomainStatus" NOT NULL DEFAULT 'PENDING',
  "deploymentId" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientSubdomain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ClientSubdomain_fqdn_key" ON "ClientSubdomain"("fqdn");
CREATE UNIQUE INDEX IF NOT EXISTS "ClientSubdomain_deploymentId_key" ON "ClientSubdomain"("deploymentId");
CREATE INDEX IF NOT EXISTS "ClientSubdomain_domainId_idx" ON "ClientSubdomain"("domainId");
CREATE INDEX IF NOT EXISTS "ClientSubdomain_status_idx" ON "ClientSubdomain"("status");

-- Deployment — colonnes (URL reachable exposée au client), additif.
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "subdomain" TEXT;
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "domainId" TEXT;
ALTER TABLE "Deployment" ADD COLUMN IF NOT EXISTS "fqdn" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Deployment_fqdn_key" ON "Deployment"("fqdn");

-- Clés étrangères (jamais recrées si présentes).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CloudflareSetting_rootDomainId_fkey') THEN
    ALTER TABLE "CloudflareSetting" ADD CONSTRAINT "CloudflareSetting_rootDomainId_fkey" FOREIGN KEY ("rootDomainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ClientSubdomain_domainId_fkey') THEN
    ALTER TABLE "ClientSubdomain" ADD CONSTRAINT "ClientSubdomain_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ClientSubdomain_deploymentId_fkey') THEN
    ALTER TABLE "ClientSubdomain" ADD CONSTRAINT "ClientSubdomain_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Deployment_domainId_fkey') THEN
    ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;