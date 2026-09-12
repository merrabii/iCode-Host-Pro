-- Plan Gratuit sans checkout + build file-based (codediali.toml).
ALTER TABLE "Product" ADD COLUMN "freePlan" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Deployment"
  ADD COLUMN "baseDirectory" TEXT,
  ADD COLUMN "buildCommand" TEXT,
  ADD COLUMN "installCommand" TEXT,
  ADD COLUMN "publishDirectory" TEXT,
  ADD COLUMN "functionsDirectory" TEXT,
  ADD COLUMN "environment" JSONB;
