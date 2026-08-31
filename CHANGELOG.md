# CHANGELOG

## Phase 2 — COMPLETE and owner-validated (2026-08-31)
Owner picked direction "Modèle cœur + dashboard" with the core architecture resolved: Product & Server are PLATFORM-GLOBAL reference data (NO ownerId), administration console `/manager` (ADMIN only), client-owned resources deferred.
### Added
- **Core model (ADR-017)** — tables `Product` (catalogue: name unique, kind string, status enum `ProductStatus`) and `Server` (infrastructure: name unique, hostname, status enum `ServerStatus`), migration `20260831000649_init_core`. Global, no ownerId.
- **RBAC**: Product read = any authenticated; Product mutation & all Server routes = ADMIN only (internal infra never exposed to clients). 401/403 via existing JwtAuthGuard + RolesGuard.
- **`/manager`** admin console (list + create + delete servers & products), ADMIN-gated, token minted from the httpOnly refresh cookie (no localStorage token).
- **Admin bootstrap**: idempotent `db:seed` (prisma/seed.ts) from gitignored `.env` credentials; placeholders only in `.env.example`.
- API `/api/products` + `/api/servers` (CRUD) with Swagger tags; DTO validation.

### Changed
- DECISIONS.md: ADR-017 APPROVED (Phase 2 GO). (ADR-015/016 already approved; ADR-006/007/008/009/010 remain PROPOSED.)
- Web: homepage links + `/manager` route; `.next` dev cache reset (HMR corruption) and manager page relocated under `src/app/`.
- PROJECT_STATUS.md, TASKS.md, docs/sql-commandes.txt updated.

### Verified (2026-08-31)
- Unit **11/11**; e2e **15/15, 3 suites** (health + auth + core RBAC); builds API + web pass (`/`, `/auth`, `/manager`).
- Live RBAC smoke: seeded admin OK; USER GET /products 200, POST /products 403, GET /servers 403, GET/POST servers blocked; no token 401; ADMIN create product+server 201; lists OK.
- Web: `/` 200, `/manager` 200, proxy `/api/health` 200.

### Owner validation (2026-08-31)
- Owner confirmed live: `/manager` admin console (admin login, create/list products & servers), `/api/docs` Swagger group with products/servers CRUD + RBAC, and the 401/403 behavior. Phase 2 closed.

### Pending (not yet done)
- Commit of Phase 2 (in progress).

## Phase 1 — COMPLETE and owner-validated (2026-08-31)
Owner gave GO for "Auth + 1res tables", then confirmed the browser validation ("validé"). Phase 1 closed.
### Added
- **Auth (ADR-015)**: `apps/api/src/auth/*` — JWT Bearer access token (short-lived, `15m`) + refresh token in httpOnly cookie (rotated, revocable, stored sha256-hashed), bcryptjs hashing, minimal RBAC `ADMIN | USER` + JWT/Roles guards. Endpoints: `POST /api/auth/register|login|refresh|logout`, `GET /api/users/me` (protected). Open registration (Phase 1 scope).
- **First business tables (ADR-016)**: Prisma `User` + `RefreshToken` + `Role` enum; migration `20260830053420_init_auth` (first migration baseline — `_prisma_migrations`, `users`, `refresh_tokens`). Config socle extended with `JWT_SECRET`, `JWT_EXPIRES_IN`, `REFRESH_EXPIRES_IN_DAYS`, `COOKIE_NAME` + fail-early validation.
- **Web auth page** `apps/web/src/app/auth/page.tsx` (login/register → /api with credentials:'include', GET /users/me with Bearer, logout) + same-origin `/api/*` rewrite in `next.config.mjs` so the httpOnly cookie survives in the browser.
- Swagger Bearer JWT security scheme.
- Tests: auth e2e suite (full flow).

### Changed
- DECISIONS.md: ADR-015 + ADR-016 APPROVED at Phase 1 GO (2026-08-30).
- `@nestjs/jwt` pinned `^11.0.2` (CJS dist) — fixes jest "Cannot use import statement outside a module" (v12 ships ESM-only dist).
- `auth.module.ts` registers the JWT secret via `JwtModule.registerAsync` so signing and the guard's verification share one config (fixed 401 on `/users/me` found by e2e).
- PROJECT_STATUS.md, TASKS.md, docs/sql-commandes.txt updated.

### Verified (2026-08-31)
- Unit 2/2; e2e **6/6 across 2 suites** (health + auth); builds API + web pass (incl. `/auth` route).
- Live smoke on `/api`: register→login→refresh→logout→revocation (401) all correct; httpOnly refresh cookie captured; `/users/me` returns profile without passwordHash.
- Swagger `/api/docs` 200 with `bearer`/`bearerFormat: JWT`.
- Web proxy `GET localhost:3000/api/health` 200; web `/auth` page 200.

### Verified (2026-08-31, owner browser validation)
- Owner opened the `/auth` page, created an account, retrieved `/api/users/me` (profile without passwordHash), re-logged in, and confirmed the Swagger Bearer scheme. Phase 1 closed.

## Phase 0 — COMPLETE and owner-validated (2026-08-30)
Owner confirmed the browser validation (health API, Swagger, web diagnostic page). Phase 0 closed.
### Added
- Monorepo foundation (pnpm workspaces + Turborepo): root `package.json`, `pnpm-workspace.yaml`, `turbo.json`.
- Development infrastructure `docker-compose.yml` (PostgreSQL 16 only; no Redis — ADR-012).
- Backend `apps/api` (NestJS 11): `GET /api/health`, validated startup config socle (ADR-011), global prefix, dev CORS, openPrisma wiring.
- Prisma schema with **no business models** (ADR-014); connectivity via real `SELECT 1`.
- Frontend `apps/web` (Next.js 15 App Router): diagnostic page calling the API.
- OpenAPI/Swagger setup served at `/api/docs`.
- Unit + e2e tests for the health endpoint (files authored).
- `.gitignore` strengthened; `.nvmrc`; `.env.example` for both apps (ADR-011); local `.env` (gitignored).
- `docs/sql-commandes.txt` pending update once migrations run.

### Changed
- DECISIONS.md: ADR-001..005 and ADR-011..014 marked APPROVED at owner's Phase 0 GO; ADR-006/007/008/009/010 remain PROPOSED.
- README.md: monorepo layout + quick-start.
- PROJECT_STATUS.md: reflected real Phase 0 state.

### Pending (not yet done)
- Owner browser validation of Phase 0.
- Commit of the Phase 0 baseline (on owner request).

### Verified (2026-08-30)
- Unit tests 2/2 PASS; e2e 1/1 PASS; monorepo build 2/2 PASS.
- Live: /api/health → ok/database ok; /api/docs (Swagger) 200; /api/docs-json 200 (path /api/health); web / 200 diagnostic page.
- Dev DB reset to a fresh Postgres volume (docker compose down -v && up) per owner request; no old iCodeHost build in Docker (verified).