# HANDOVER

## Read in order
README.md → PROJECT_CONTEXT.md → PROJECT_STATUS.md → DECISIONS.md → TASKS.md → CHANGELOG.md → MASTER_PROMPT.md → docs references.

## Before changing code
Determine current phase, actual implementation, proposed versus approved decisions, blockers and owner test requirements. If unclear, analyze rather than guess.

## Current state (Phase 3 — COMPLETE + owner-validated 2026-08-31)
Implementation is current. Summary of the stack:
- **Auth (Phase 1, ADR-015/016)**: JWT Bearer access (15m) + httpOnly refresh cookie (rotated, sha256-hashed, revocable), bcryptjs, ADMIN/USER RBAC + RolesGuard. Tables `User` + `RefreshToken` (migration `init_auth`). Web `/auth`.
- **Core model (Phase 2, ADR-017)**: tables `Product` + `Server` — PLATFORM-GLOBAL reference data, **no ownerId** (migration `init_core`). Product read = any authenticated; Product mutation & all Server routes = ADMIN only. No client ownership by design: client resources (Subscription/Service/Deployment) are deferred.
- **Admin console (Phase 3, ADR-018)**: **no data model change** (no migration). Backend: `GET /api/users` list + `PATCH /api/users/:id` (promote/demote, activate/deactivate) — ADMIN only, **anti-lockout guards** (no self role change; keep ≥1 active ADMIN); `GET /api/manager/summary` — ADMIN only. Web: `/manager` dashboard + catalog (product/server **status transitions**, **editable server hostname**) + **`/manager/utilisateurs`**. Registration still OPEN (invitation flow explicitly deferred by owner at Phase 3 GO).
- **Admin bootstrap**: `db:seed` (idempotent, from gitignored `.env` ADMIN_EMAIL/ADMIN_PASSWORD).
- `@nestjs/jwt` pinned `^11.0.2` (CJS) to keep jest/tsc happy.
- Dev servers running in background: api on :3001 (`dev`), web on :3000 (`dev`).

Reported decisions: ADR-001..005 + 011..014 APPROVED (Phase 0); ADR-015 + 016 APPROVED (Phase 1); **ADR-017 APPROVED (Phase 2)**; **ADR-018 APPROVED (Phase 3)**; ADR-006 full, 007, 008, 009, 010 stay PROPOSED.

## Common commands (dev)
- Install:   `corepack pnpm install`
- Postgres:  `docker compose up -d postgres` / `docker compose ps`
- Prisma:    `corepack pnpm --filter @icode-host-pro/api generate` / `... run migrate --name <name>` (use `--name`, never the literal `--` origin it into an interactive prompt)
- Seed admin:`corepack pnpm --filter @icode-host-pro/api run db:seed` (idempotent; requires ADMIN_EMAIL/ADMIN_PASSWORD in apps/api/.env)
- Tests:     `corepack pnpm --filter @icode-host-pro/api test` / `... test:e2e`
- Servers:   `corepack pnpm --filter @icode-host-pro/api start` (quai :3001) ; `corepack pnpm --filter @icode-host-pro/web dev` (quai :3000)
- Build:     `corepack pnpm build`
Note: pnpm runs via `corepack pnpm ...` on this machine (corepack `enable` is blocked by a protected Program Files dir; the subcommand form needs no admin).

## After every phase
Update TASKS.md, PROJECT_STATUS.md, CHANGELOG.md, docs/sql-commandes.txt for database work, DECISIONS.md only for genuine decision changes, and HANDOVER.md when continuation instructions change.

## Never
Never fabricate approval, erase history, commit secrets, assume existing code is correct or perform major architecture changes without recording them.
