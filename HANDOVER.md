# HANDOVER

## Read in order
README.md → PROJECT_CONTEXT.md → PROJECT_STATUS.md → DECISIONS.md → TASKS.md → CHANGELOG.md → MASTER_PROMPT.md → docs references.

## Before changing code
Determine current phase, actual implementation, proposed versus approved decisions, blockers and owner test requirements. If unclear, analyze rather than guess.

## Current state (Phase 1 — COMPLETE, owner-validated 2026-08-31)
Implementation of Phase 1 (Authentication & first tables) is COMPLETE and owner-validated ("validé", 2026-08-31). Summary:
- Auth (ADR-015): JWT Bearer access token (15m) + httpOnly refresh cookie (rotated, sha256-hashed, revocable in DB), bcryptjs, minimal ADMIN/USER RBAC + guards. Endpoints: register, login, refresh, logout, `GET /users/me`.
- First business tables (ADR-016): `users` + `refresh_tokens` via migration `20260830053420_init_auth`.
- Web `/auth` page (login/register) + same-origin `/api/*` rewrite so the httpOnly cookie works.
- `@nestjs/jwt` pinned `^11.0.2` (CJS) to keep jest/tsc happy.
- Dev servers running in background: api on :3001 (`dev`), web on :3000 (`dev`).
- Decided to document later in DECISIONS.md: ADR-001..005, 011..016 APPROVED; ADR-006 full, 007, 008, 009, 010 stay PROPOSED.

Reported decisions: ADR-001..005 + 011..014 APPROVED (Phase 0); ADR-015 + 016 APPROVED (Phase 1); ADR-006 full, 007, 008, 009, 010 stay PROPOSED.

## Common commands (dev)
- Install:   `corepack pnpm install`
- Postgres:  `docker compose up -d postgres` / `docker compose ps`
- Prisma:    `corepack pnpm --filter @icode-host-pro/api generate` / `... run migrate --name <name>` (use `--name`, never the literal `--` origin it into an interactive prompt)
- Tests:     `corepack pnpm --filter @icode-host-pro/api test` / `... test:e2e`
- Servers:   `corepack pnpm --filter @icode-host-pro/api start` (quai :3001) ; `corepack pnpm --filter @icode-host-pro/web dev` (quai :3000)
- Build:     `corepack pnpm build`
Note: pnpm runs via `corepack pnpm ...` on this machine (corepack `enable` is blocked by a protected Program Files dir; the subcommand form needs no admin).

## After every phase
Update TASKS.md, PROJECT_STATUS.md, CHANGELOG.md, docs/sql-commandes.txt for database work, DECISIONS.md only for genuine decision changes, and HANDOVER.md when continuation instructions change.

## Never
Never fabricate approval, erase history, commit secrets, assume existing code is correct or perform major architecture changes without recording them.
