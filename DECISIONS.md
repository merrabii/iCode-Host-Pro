# DECISIONS — Architecture Decision Register

## Status rules
**PROPOSED**: recommendation, not approved.
**APPROVED**: explicitly approved by owner.
**REJECTED**: explicitly rejected by owner.

Never infer approval.

## ADR-001 — Monorepo
**Status: PROPOSED**
Recommendation: Turborepo + pnpm workspaces.

## ADR-002 — Frontend
**Status: PROPOSED**
Recommendation: Next.js App Router.

## ADR-003 — Backend
**Status: PROPOSED**
Recommendation: NestJS.

## ADR-004 — Database
**Status: PROPOSED**
Recommendation: Prisma.

## ADR-005 — API
**Status: PROPOSED**
Recommendation: versioned REST + OpenAPI.

## ADR-006 — Docker development
**Status: PROPOSED**
Base infrastructure compose plus development, production-like and test configurations. Redis remains conditional on final jobs architecture.

## ADR-007 — Async jobs
**Status: PROPOSED — NOT APPROVED**
Options discussed: BullMQ+Redis; PostgreSQL jobs/pg-boss; Temporal; custom queue. A prior recommendation favored pg-boss for self-hosted simplicity, but the owner has not approved it.

## ADR-008 — Config and encryption
**Status: PROPOSED**
Direction: environment infrastructure config, database-backed configuration where appropriate, application-level authenticated encryption and validated startup configuration.

## ADR-009 — Installation lifecycle
**Status: PROPOSED**
Direction: CLI-first, resumable/idempotent phases and persisted state. Any exact dual lock mechanism previously mentioned remains a proposal, not an owner decision.

## ADR-010 — Provider adapters
**Status: PROPOSED**
Direction: fine-grained capability interfaces and provider isolation. Coolify/Hestia capabilities require verification.

# APPROVED
None recorded in this clean baseline.

# REJECTED
None recorded in this clean baseline.
