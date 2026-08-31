# PROJECT_STATUS — iCode Host Pro

## Overall status
**PHASE 3 COMPLETE + owner-validated 2026-08-31 — /MANAGER CONSOLE COMPLÈTE (ADMINS + DASHBOARD)**

## Current phase
**Phase 3 — Gestion utilisateurs admin + dashboard /manager + catalogue enrichi. COMPLETE + owner-validated 2026-08-31.**

## State (real, as of this update)
- Monorepo: pnpm workspaces + Turborepo (ADR-001). `apps/web` (Next.js 15), `apps/api` (NestJS 11), `packages/` reserved.
- API: `GET /api/health` (app + real DB connectivity via `SELECT 1`), validated startup config socle (ADR-011), global `/api` prefix, dev CORS, OpenAPI/Swagger at `/api/docs` (ADR-005).
- **Auth (Phase 1, ADR-015)**: stateless JWT Bearer access token (short-lived `15m`) + refresh token in httpOnly cookie (rotated, revocable, persisted hashed in DB, sha256). bcryptjs hashing. Minimal RBAC role `ADMIN | USER` + guards. Open registration (Phase 1 scope). Endpoints: `POST /api/auth/register`, `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`, `GET /api/users/me` (protected). Swagger carries a Bearer JWT scheme.
- DB (Phase 1, ADR-016): first real business tables `users` + `refresh_tokens` created via migration `20260830053420_init_auth` (first migration baseline; `_prisma_migrations` now exists). Prisma client v6.19.3.
- **Core model (Phase 2, ADR-017)**: two platform-GLOBAL reference entities, possessed by the platform (NO ownerId): `Product` (catalogue: name unique, kind string default `generic`, status enum) and `Server` (infrastructure host: name unique, hostname, status enum), via migration `20260831000649_init_core`. Client-owned resources (Subscription/Service/Deployment) deliberately deferred.
- **RBAC (ADR-017)**: `Product` read = any authenticated (ADMIN+USER); `Product` mutation & ALL `Server` routes = ADMIN only (internal infra never exposed to clients). Unges 401/403 via existing JwtAuthGuard + RolesGuard (ADR-015).
- **Admin bootstrap**: idempotent `db:seed` (prisma/seed.ts) creates/promotes the ADMIN from `ADMIN_EMAIL`/`ADMIN_PASSWORD` in gitignored `apps/api/.env`; placeholders only in `.env.example`; no real secret in Git.
- Web: login/register at `/auth`; same-origin `/api/*` rewrite (httpOnly cookie works through :3000); **`/manager`** admin console gated to ADMIN, access token minted from the httpOnly refresh cookie (no localStorage token). Homepage links to /auth and /manager.
- **Admin console (Phase 3, ADR-018)**: `/api/users` list + `/api/users/:id` PATCH (promote/demote, activate/deactivate) — ADMIN only, with **anti-lockout guards** (no self role change, keep ≥1 active ADMIN); `/api/manager/summary` dashboard aggregation — ADMIN only. Web: `/manager` dashboard + catalog (product/server **status transitions**, **editable server hostname**) + **`/manager/utilisateurs`** (promote/demote, activate/deactivate). Data model UNCHANGED — no migration. Registration still OPEN (invitation flow explicitly deferred).
- `@nestjs/jwt` pinned to **^11.0.2** (CJS dist) — v12 ships ESM-only dist that breaks our CJS jest/toolchain.
- Docker Postgres 16 (ADR-012) up and healthy.

## Verified (real checks, not assumed) — 2026-08-31
- `corepack pnpm --filter @icode-host-pro/api test` → **11/11 unit pass** (health 2 + products 5 + servers 4).
- `corepack pnpm --filter @icode-host-pro/api test:e2e` → **15/15 pass, 3 suites** (health + auth + core RBAC).
- `corepack pnpm --filter @icode-host-pro/api build` → PASS; `--filter @icode-host-pro/web build` → PASS (routes `/`, `/auth`, `/manager`).
- Live smoke on :3001 `/api`: admin login (seeded) OK; USER GET /products → 200; USER POST /products → 403; USER GET /servers → 403 (infra hidden); no token → 401; ADMIN create product 201 + server 201; admin lists both.
- Live: Swagger `/api/docs` 200. Web proxy `GET localhost:3000/api/health` → 200; `/` 200; `/manager` 200 (admin shell).
- `.next` cache reset on web dev server (HMR corruption from Phase 1 session) + manager page relocated to `src/app/manager/` (correct App Router location).

## Verified (Phase 3 — real checks, 2026-08-31)
- Unit **23/23** (health 2 + products 5 + servers 4 + users 10 + manager 2; incl. 2 regressions anti-verrouillage).
- e2e **24/24, 4 suites** (health + auth + core RBAC + admin RBAC; incl. 1 régression admin inactif).
- Builds API + web PASS (web routes `/`, `/auth`, `/manager`, `/manager/utilisateurs`).
- Live API :3001: `/api/users` + `/api/manager/summary` → 401 unauth; admin login → `/api/users` returns 9 accounts with **no `passwordHash`**; `/api/manager/summary` aggregates 1 product (ACTIVE) / 1 server (UNKNOWN) / 9 users (1 ADMIN, 8 USER, 9 active). **Self-demote guard live → 403** with clear French message.
- **Correctif anti-verrouillage (3.5)**: rétrogradation/désactivation d'un admin DÉJÀ inactif désormais permise (garde-fou ne s'applique qu'au retrait d'un ADMIN actif). Tests de régression verts.
- Live web: `/manager` 200, `/manager/utilisateurs` 200, proxy `/api/health` 200. Web dev server restarted clean (build done first, `.next` purged).

## Owner validation (2026-08-31)
- Owner confirmed live: gestion admins (promotion/rétrogradation/activation/désactivation), dashboard `/manager`, catalogue enrichi et transitions de statut. Phase 3 closed.

## Pending
- Proposal for Phase 4 (on owner request).

## Decisions
- ADR-001..005, 011..014: **APPROVED** (Phase 0). ADR-015 + 016: **APPROVED** (Phase 1). **ADR-017** (core model Product+Server): **APPROVED** (Phase 2 GO, 2026-08-31). **ADR-018** (admin console /manager): **APPROVED** (Phase 3 GO, 2026-08-31). ADR-006 full, 007, 008, 009, 010: **PROPOSED** (untouched). See DECISIONS.md.

## Next action
Propose Phase 4 on owner request (and/or push the Phase 3 commit).

## Out of scope (do not build yet)
Client-owned resources (Subscription/Service/Deployment), providers (Coolify/Hestia — ADR-010), jobs/Redis (ADR-007), billing, OAuth, licensing. (Product + Server platform reference data now exist; client consumption of them is deferred.)