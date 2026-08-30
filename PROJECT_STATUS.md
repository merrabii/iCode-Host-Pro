# PROJECT_STATUS — iCode Host Pro

## Overall status
**PHASE 1 COMPLETE & OWNER-VALIDATED — AUTHENTICATION & FIRST TABLES**

## Current phase
**Phase 1 — Authentication & first real business tables — COMPLETE, owner-validated 2026-08-31.**

## State (real, as of this update)
- Monorepo: pnpm workspaces + Turborepo (ADR-001). `apps/web` (Next.js 15), `apps/api` (NestJS 11), `packages/` reserved.
- API: `GET /api/health` (app + real DB connectivity via `SELECT 1`), validated startup config socle (ADR-011), global `/api` prefix, dev CORS, OpenAPI/Swagger at `/api/docs` (ADR-005).
- **Auth (Phase 1, ADR-015)**: stateless JWT Bearer access token (short-lived `15m`) + refresh token in httpOnly cookie (rotated, revocable, persisted hashed in DB, sha256). bcryptjs hashing. Minimal RBAC role `ADMIN | USER` + guards. Open registration (Phase 1 scope). Endpoints: `POST /api/auth/register`, `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`, `GET /api/users/me` (protected). Swagger carries a Bearer JWT scheme.
- DB (Phase 1, ADR-016): first real business tables `users` + `refresh_tokens` created via migration `20260830053420_init_auth` (first migration baseline; `_prisma_migrations` now exists). Prisma client v6.19.3.
- `@nestjs/jwt` pinned to **^11.0.2** (CJS dist) — v12 ships ESM-only dist that breaks our CJS jest/toolchain.
- Web: login/register page at `/auth` (client auth form), same-origin `/api/*` rewrite/proxy (API_UPSTREAM) so the httpOnly refresh cookie works through :3000. Homepage still shows the diagnostic + link to /auth.
- Docker Postgres 16 (ADR-012) up and healthy.

## Verified (real checks, not assumed) — 2026-08-31
- `corepack pnpm --filter @icode-host-pro/api test` → **2/2 unit pass**.
- `corepack pnpm --filter @icode-host-pro/api test:e2e` → **6/6 pass, 2 suites** (health + auth full flow: register 201, /users/me with token 200, /users/me without token 401, wrong password 401, refresh).
- `corepack pnpm --filter @icode-host-pro/api build` → PASS; `--filter @icode-host-pro/web build` → PASS (incl. `/auth` route).
- Live smoke on :3001 `/api`: register→201 [accessToken+refresh cookie ✓], `GET /users/me` with Bearer → 200 (email ok, passwordHash absent), no token → 401, refresh → 201 new accessToken, `GET /users/me` with refreshed token → 200, logout → 201, refresh after logout (revoked) → 401.
- Live: `/api/docs` (Swagger) → 200, spec declares `bearer`/`bearerFormat: JWT` securityScheme.
- Live web proxy: `GET http://localhost:3000/api/health` → 200 `{"status":"ok","database":"ok",...}` (rewrite works); `/auth` page → 200.

## Pending
- Proposal for Phase 2 (on owner request).

## Decisions
- ADR-001..005, 011..014: **APPROVED** (Phase 0). ADR-015 (auth) + ADR-016 (auth tables): **APPROVED** (Phase 1 GO, 2026-08-30). ADR-006 full, 007, 008, 009, 010: **PROPOSED** (untouched). See DECISIONS.md.

## Next action
Present Phase 1 validation steps to owner; on validation, close Phase 1 and commit.

## Out of scope (do not build yet)
Dashboard/portal, providers (Coolify/Hestia), jobs/Redis, billing, OAuth, licensing, product catalog.