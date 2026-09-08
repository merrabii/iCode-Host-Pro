-- Phase 14bis: option IMAGE « afficher aussi le texte » — logoShowText.
-- ADDITIVE / SAFE: colonne booléenne non-nulle avec défaut false.

ALTER TABLE "BrandConfig" ADD COLUMN IF NOT EXISTS "logoShowText" BOOLEAN NOT NULL DEFAULT false;