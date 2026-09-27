-- 17B.4F-C4 — 5 tables dédiées du protocole de reprise sûre.
--
-- STRICTEMENT ADDITIVE : 4 `CREATE TYPE` + 5 `CREATE TABLE` + index (dont UN
-- index unique PARTIEL créatif). Aucune colonne n'est ajoutée à
-- "HostingServiceAllocation" ni à "OrderProvisioningTracking" (décision
-- figée : tables dédiées sans relation/FK vers C1/C3), aucun DROP, aucun
-- renommage, aucun UPDATE/DELETE, aucun backfill, aucune modification de
-- contrainte ou d'index d'une table existante.
--
--   • C4ProviderAttempt  : tentative provider durable (dispatch → retour),
--     identité (holder + targetIntentHash), outcome terminal immuable ;
--     index unique partiel : AU PLUS UNE tentative DISPATCHED de création
--     (CREATE/CONFIGURE) par allocation (garantie « jamais deux créations »).
--   • C4Takeover         : premier dispatch du périmètre, committé AVANT le
--     1er appel réseau (unique par scope).
--   • C4StopRequest      : marqueur d'arrêt opposable aux dispatchs (unique
--     par scope), jamais effacé par un changement de flag.
--   • C4ReleaseEvidence  : preuve structurée de libération (unique par
--     allocation — une seule libération locale).
--   • C4ReadinessProof   : preuve identity-bound du finalize (unique par
--     commande).
--
-- Appliquée sur base de TEST isolée pour 17B.4F-C4 ; sur la base live elle
-- restera en attente (`prisma migrate status`) jusqu'au prochain déploiement
-- validé — aucune migration n'est exécutée ici sur `icode_host_pro`.

-- CreateEnum
CREATE TYPE "C4AttemptNature" AS ENUM ('CREATE', 'CONFIGURE', 'DELETE', 'READ');

-- CreateEnum
CREATE TYPE "C4AttemptPhase" AS ENUM ('DISPATCHED', 'RETURNED');

-- CreateEnum
CREATE TYPE "C4AttemptOutcome" AS ENUM ('SUCCESS', 'REFUSED', 'DELETED', 'ABSENT', 'FAILED_RETRYABLE', 'PERMANENT_FAILURE', 'PRESENT', 'UNAVAILABLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "C4ScopeType" AS ENUM ('ORDER', 'SERVICE', 'ALLOCATION', 'DEPLOYMENT');

-- CreateTable
CREATE TABLE "C4ProviderAttempt" (
    "id" TEXT NOT NULL,
    "nature" "C4AttemptNature" NOT NULL,
    "phase" "C4AttemptPhase" NOT NULL DEFAULT 'DISPATCHED',
    "scopeType" "C4ScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "allocationId" TEXT,
    "orderId" TEXT,
    "holder" TEXT NOT NULL,
    "targetIntent" JSONB,
    "targetIntentHash" TEXT,
    "outcome" "C4AttemptOutcome",
    "returnedIdentifiers" JSONB,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedAt" TIMESTAMP(3),

    CONSTRAINT "C4ProviderAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "C4Takeover" (
    "id" TEXT NOT NULL,
    "scopeType" "C4ScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "targetIntent" JSONB,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "C4Takeover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "C4StopRequest" (
    "id" TEXT NOT NULL,
    "scopeType" "C4ScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "C4StopRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "C4ReleaseEvidence" (
    "id" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "orderId" TEXT,
    "ownerUserId" TEXT,
    "appIdentifier" TEXT,
    "dnsIdentifier" TEXT,
    "appOutcome" TEXT,
    "dnsOutcome" TEXT,
    "attemptIds" JSONB,
    "details" JSONB,
    "releasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "C4ReleaseEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "C4ReadinessProof" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "coolifyUuid" TEXT NOT NULL,
    "serverId" TEXT,
    "providerStatus" TEXT,
    "evidence" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "C4ReadinessProof_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "C4ProviderAttempt_orderId_idx" ON "C4ProviderAttempt"("orderId");

-- CreateIndex
CREATE INDEX "C4ProviderAttempt_allocationId_nature_idx" ON "C4ProviderAttempt"("allocationId", "nature");

-- CreateIndex
CREATE INDEX "C4ProviderAttempt_scopeType_scopeId_idx" ON "C4ProviderAttempt"("scopeType", "scopeId");

-- CreateIndex
-- UNIQUE PARTIEL créatif : au plus une tentative DISPATCHED de création
-- (CREATE/CONFIGURE) par allocation — garantie « jamais deux créations »
-- (aucun rejeu de création concurrent, H1/H6).
CREATE UNIQUE INDEX "C4ProviderAttempt_open_creative_key" ON "C4ProviderAttempt"("allocationId")
    WHERE "phase" = 'DISPATCHED' AND "nature" IN ('CREATE', 'CONFIGURE') AND "allocationId" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "C4Takeover_scopeType_scopeId_key" ON "C4Takeover"("scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "C4StopRequest_scopeType_scopeId_key" ON "C4StopRequest"("scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "C4ReleaseEvidence_allocationId_key" ON "C4ReleaseEvidence"("allocationId");

-- CreateIndex
CREATE UNIQUE INDEX "C4ReadinessProof_orderId_key" ON "C4ReadinessProof"("orderId");
