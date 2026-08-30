# DECISIONS — Architecture Decision Register

## Status rules
**PROPOSED**: recommendation, not approved.
**APPROVED**: explicitly approved by owner.
**REJECTED**: explicitly rejected by owner.

Never infer approval.

## Phase 0 approval
On 2026-08-30 the owner gave an explicit GO to start Phase 0 (Architecture & Foundations) and approved decisions D1–D8 of the Phase 0 plan. The following ADR statuses were updated PROPOSED → APPROVED at the start of implementation. This is owner approval, not an inferred one. Phase 0 itself is now IN PROGRESS for implementation.

## ADR-001 — Monorepo
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: Turborepo + pnpm workspaces.

## ADR-002 — Frontend
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: Next.js App Router.

## ADR-003 — Backend
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: NestJS.

## ADR-004 — Database
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: Prisma.

## ADR-005 — API
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: versioned REST + OpenAPI.

## ADR-006 — Docker development
**Status: PROPOSED** (full scope not yet approved)
Base infrastructure compose plus development, production-like and test configurations. Redis remains conditional on final jobs architecture.
Note: the Phase 0 socle is covered separately by ADR-012 (PostgreSQL-only development compose, no Redis). ADR-006 full scope stays PROPOSED.

## ADR-007 — Async jobs
**Status: PROPOSED — NOT APPROVED**
Options discussed: BullMQ+Redis; PostgreSQL jobs/pg-boss; Temporal; custom queue. A prior recommendation favored pg-boss for self-hosted simplicity, but the owner has not approved it.

## ADR-008 — Config and encryption
**Status: PROPOSED — NOT APPROVED** (includes the Phase 0 socle config decision scope)
Direction: environment infrastructure config, database-backed configuration where appropriate, application-level authenticated encryption and validated startup configuration.
Note: ADR-008 is **not** partially approved by the Phase 0 GO. The minimal non-structuring development config socle used in Phase 0 (dev env vars, startup validation, .env.example) is a separate approved decision: see ADR-011. No secret management, no provider credential encryption and no persisted configuration architecture were decided; they remain to be decided later under a full ADR-008.

## ADR-009 — Installation lifecycle
**Status: PROPOSED**
Direction: CLI-first, resumable/idempotent phases and persisted state. Any exact dual lock mechanism previously mentioned remains a proposal, not an owner decision.

## ADR-010 — Provider adapters
**Status: PROPOSED**
Direction: fine-grained capability interfaces and provider isolation. Coolify/Hestia capabilities require verification.

# APPROVED
- ADR-001 Monorepo (Turborepo + pnpm workspaces) — 2026-08-30.
- ADR-002 Frontend (Next.js App Router) — 2026-08-30.
- ADR-003 Backend (NestJS) — 2026-08-30.
- ADR-004 Database (Prisma) — 2026-08-30.
- ADR-005 API (versioned REST + OpenAPI) — 2026-08-30.
- ADR-011 Socle config minimal Phase 0 (below) — 2026-08-30.
- ADR-012 Docker dev Phase 0 (below) — 2026-08-30.
- ADR-013 Conventions nommage (below) — 2026-08-30.
- ADR-014 Zero table métier en Phase 0 (below) — 2026-08-30.
- ADR-015 Approche authentication (below) — 2026-08-30.
- ADR-016 Modèle de données Phase 1 (below) — 2026-08-30.

## ADR-011 — Socle config minimal (Phase 0)
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: minimal non-structuring development config socle only: development environment variables, minimal startup validation (fail early on missing required socle values), `.env.example` files. Does NOT decide ADR-008 (secret management, provider credential encryption, persisted configuration architecture all remain open).

## ADR-012 — Docker dev minimal (Phase 0)
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: development compose runs PostgreSQL only in Docker Desktop (named volume, healthcheck). No Redis until the async jobs architecture (ADR-007) is decided. Does NOT supersede full ADR-006.

## ADR-013 — Conventions de nommage (Phase 0)
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: root package `icode-host-pro`; applications in `apps/web` (frontend, Next.js) and `apps/api` (backend, NestJS); shared code in `packages/`.

## ADR-014 — Zero table métier en Phase 0
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: no artificial domain table (no HealthCheck). The Phase 0 Prisma schema declares no business models. DB/Prisma connectivity is proven by a real raw query (`SELECT 1`) in the health check. The only database artifact is Prisma's own `_prisma_migrations` framework table (baseline for the real migration chain). Any future table requires a real architectural justification in its phase.

## ADR-015 — Approche authentication (Phase 1)
**Status: APPROVED** (2026-08-30, Phase 1 GO)
Decision: stateless JWT Bearer access token (short-lived) + refresh token in a httpOnly cookie (rotated, revocable, persisted in DB). Password hashing with bcrypt. RBAC minimal: `role` (ADMIN/USER) on User + guards. Registration open in Phase 1 (to be tightened later). OAuth, MFA, password-reset, email verification fully deferred.

## ADR-016 — Modèle de données Phase 1
**Status: APPROVED** (2026-08-30, Phase 1 GO)
Decision: first real justified business tables — `User` (email unique, password hash, name, role, active) and `RefreshToken` (hashed token, FK user, expiry, revocation, for rotation). Introduces the real migration baseline (`_prisma_migrations`), superseding the zero-table Phase 0 (ADR-014) for the auth domain only. No provider credentials, no other domain tables yet.

# REJECTED
None recorded in this clean baseline.
