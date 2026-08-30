# HANDOVER

## Read in order
README.md → PROJECT_CONTEXT.md → PROJECT_STATUS.md → DECISIONS.md → TASKS.md → CHANGELOG.md → MASTER_PROMPT.md → docs references.

## Before changing code
Determine current phase, actual implementation, proposed versus approved decisions, blockers and owner test requirements. If unclear, analyze rather than guess.

## Current state (Phase 0)
Implementation of Phase 0 (Architecture & Foundations) is COMPLETE and machine-verified; awaiting owner browser validation. Summary:
- Monorepo (pnpm + Turborepo), `apps/web` (Next.js 15), `apps/api` (NestJS 11), `packages/` reserved.
- `GET /api/health` (app + DB via real `SELECT 1`), Swagger at `/api/docs`, config socle validated at startup.
- Prisma zero business models (ADR-014); PostgreSQL 16 via Docker (ADR-012), fresh DB after reset.
- All automated checks pass; dev servers are running in background on :3001 (api) and :3000 (web).

Reported decisions: ADR-001..005, 011..014 APPROVED; ADR-006 full, 007, 008, 009, 010 stay PROPOSED.

## Common commands (dev)
- Install:   `corepack pnpm install`
- Postgres:  `docker compose up -d postgres` / `docker compose ps`
- Prisma:    `corepack pnpm --filter @icode-host-pro/api generate` / `... migrate`
- Tests:     `corepack pnpm --filter @icode-host-pro/api test` / `... test:e2e`
- Servers:   `corepack pnpm --filter @icode-host-pro/api start` (quai :3001) ; `corepack pnpm --filter @icode-host-pro/web dev` (quai :3000)
- Build:     `corepack pnpm build`
Note: pnpm runs via `corepack pnpm ...` on this machine (corepack `enable` is blocked by a protected Program Files dir; the subcommand form needs no admin).

## After every phase
Update TASKS.md, PROJECT_STATUS.md, CHANGELOG.md, docs/sql-commandes.txt for database work, DECISIONS.md only for genuine decision changes, and HANDOVER.md when continuation instructions change.

## Never
Never fabricate approval, erase history, commit secrets, assume existing code is correct or perform major architecture changes without recording them.
