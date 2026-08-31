# PROJECT_STATUS — iCode Host Pro

## Overall status
**PHASE 2 COMPLETE & OWNER-VALIDATED — CORE MODEL + /MANAGER CONSOLE**

## Current phase
**Phase 2 — Core model (Product + Server) + /manager admin console. COMPLETE, owner-validated 2026-08-31.**

## State (real, as of this update)
- Monorepo: pnpm workspaces + Turborepo (ADR-001). `apps/web` (Next.js 15), `apps/api` (NestJS 11), `packages/` reserved.
- API: `GET /api/health` (app + real DB connectivity via `SELECT 1`), validated startup config socle (ADR-011), global `/api` prefix, dev CORS, OpenAPI/Swagger at `/api/docs` (ADR-005).
- **Auth (Phase 1, ADR-015)**: stateless JWT Bearer access token (short-lived `15m`) + refresh token in httpOnly cookie (rotated, revocable, persisted hashed in DB, sha256). bcryptjs hashing. Minimal RBAC role `ADMIN | USER` + guards. Open registration (Phase 1 scope). Endpoints: `POST /api/auth/register`, `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`, `GET /api/users/me` (protected). Swagger carries a Bearer JWT scheme.
- DB (Phase 1, ADR-016): first real business tables `users` + `refresh_tokens` created via migration `20260830053420_init_auth` (first migration baseline; `_prisma_migrations` now exists). Prisma client v6.19.3.
- **Core model (Phase 2, ADR-017)**: two platform-GLOBAL reference entities, possessed by the platform (NO ownerId): `Product` (catalogue: name unique, kind string default `generic`, status enum) and `Server` (infrastructure host: name unique, hostname, status enum), via migration `20260831000649_init_core`. Client-owned resources (Subscription/Service/Deployment) deliberately deferred.
- **RBAC (ADR-017)**: `Product` read = any authenticated (ADMIN+USER); `Product` mutation & ALL `Server` routes = ADMIN only (internal infra never exposed to clients). Unges 401/403 via existing JwtAuthGuard + RolesGuard (ADR-015).
- **Admin bootstrap**: idempotent `db:seed` (prisma/seed.ts) creates/promotes the ADMIN from `ADMIN_EMAIL`/`ADMIN_PASSWORD` in gitignored `apps/api/.env`; placeholders only in `.env.example`; no real secret in Git.
- Web: login/register at `/auth`; same-origin `/api/*` rewrite (httpOnly cookie works through :3000); **`/manager`** admin console (list + create + delete servers & products) gated to ADMIN, access token minted from the httpOnly refresh cookie (no localStorage token). Homepage links to /auth and /manager.
- `@nestjs/jwt` pinned to **^11.0.2** (CJS dist) — v12 ships ESM-only dist that breaks our CJS jest/toolchain.
- Docker Postgres 16 (ADR-012) up and healthy.

## Verified (real checks, not assumed) — 2026-08-31
- `corepack pnpm --filter @icode-host-pro/api test` → **11/11 unit pass** (health 2 + products 5 + servers 4).
- `corepack pnpm --filter @icode-host-pro/api test:e2e` → **15/15 pass, 3 suites** (health + auth + core RBAC).
- `corepack pnpm --filter @icode-host-pro/api build` → PASS; `--filter @icode-host-pro/web build` → PASS (routes `/`, `/auth`, `/manager`).
- Live smoke on :3001 `/api`: admin login (seeded) OK; USER GET /products → 200; USER POST /products → 403; USER GET /servers → 403 (infra hidden); no token → 401; ADMIN create product 201 + server 201; admin lists both.
- Live: Swagger `/api/docs` 200. Web proxy `GET localhost:3000/api/health` → 200; `/` 200; `/manager` 200 (admin shell).
- `.next` cache reset on web dev server (HMR corruption from Phase 1 session) + manager page relocated to `src/app/manager/` (correct App Router location).

## Pending
- Proposal for Phase 3 (on owner request).

## Decisions
- ADR-001..005, 011..014: **APPROVED** (Phase 0). ADR-015 + 016: **APPROVED** (Phase 1). **ADR-017** (core model Product+Server): **APPROVED** (Phase 2 GO, 2026-08-31). ADR-006 full, 007, 008, 009, 010: **PROPOSED** (untouched). See DECISIONS.md.

## Next action
Propose Phase 3 on owner request (and/or push the Phase 2 commit).

## Out of scope (do not build yet)
Client-owned resources (Subscription/Service/Deployment), providers (Coolify/Hestia — ADR-010), jobs/Redis (ADR-007), billing, OAuth, licensing. (Product + Server platform reference data now exist; client consumption of them is deferred.)