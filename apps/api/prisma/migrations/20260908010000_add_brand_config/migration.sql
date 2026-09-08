-- Phase 14 (ADR-0xx): branding white-label — singleton BrandConfig + enum.
-- ADDITIVE (CREATE ... IF NOT EXISTS / idempotent) : ne touche pas aux tables
-- existantes, sûr sur une base avec données.

CREATE TYPE "BrandLogoType" AS ENUM ('DEFAULT', 'TEXT', 'IMAGE');

CREATE TABLE IF NOT EXISTS "BrandConfig" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'iCode Host Pro',
    "sub" TEXT NOT NULL DEFAULT 'Self-hosted hosting control plane',
    "tagline" TEXT,
    "hostname" TEXT,
    "logoType" "BrandLogoType" NOT NULL DEFAULT 'DEFAULT',
    "logoText" TEXT,
    "logoUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#00b377',
    "accentColor" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BrandConfig_pkey" PRIMARY KEY ("id")
);