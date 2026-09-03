-- Phase 11 — admin-managed Turnstile keys (ADR-027 extension)
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "turnstileSiteKey" TEXT;
ALTER TABLE "SecuritySetting" ADD COLUMN IF NOT EXISTS "turnstileSecretEnc" TEXT;
