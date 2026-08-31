# TASKS — Detailed Execution Ledger

## Rule
Do not log only important work. Record all meaningful actions, including small changes, files created/modified/deleted, commands, database actions, tests, fixes, configuration and blockers.

## Status
- [ ] not started
- [~] in progress
- [x] implementation / automated validation done
- [✓] owner validated
- [!] blocked

# PRE-PHASE 0 — CLEAN RESTART (completed prior baseline)
- [x] Confirm local directory intentionally reset.
- [x] Confirm repository baseline cleaned.
- [x] Import fundamental pack (MASTER_PROMPT, CONTEXT, STATUS, DECISIONS, TASKS, HANDOVER, CHANGELOG, README, docs/).
- [x] Verify .gitignore (strengthened in Phase 0 — see 0.1).
- [x] Verify no secrets committed.
- [x] Initial Git commit (upstream: `9b49b91 chrome premier upload`).
- [x] Push baseline.

# FIRST AI ORIENTATION
- [x] Read continuity files.
- [x] Inspect repository.
- [x] Identify implemented code (none at baseline) vs documented.
- [x] Identify contradictions and missing information.
- [x] Verify decision statuses (all PROPOSED at baseline).
- [x] Produce first assessment.
- [x] Propose Phase 0 (plan validated and revised to 6 governance corrections).
- [x] Owner explicit GO (2026-08-30).

# PHASE 0 — ARCHITECTURE & FOUNDATIONS (owner-validated 2026-08-30) ✓

## 2026-08-30 — GO and decisions
- Action: At owner GO, promoted validated Phase 0 decisions to APPROVED in DECISIONS.md.
- Reason: Phase 0 plan approved; avoid treating historical recommendation as approval (owned decision).
- Files modified: DECISIONS.md
- Decisions APPROVED: ADR-001 (monorepo), ADR-002 (frontend), ADR-003 (backend), ADR-004 (database), ADR-005 (API), ADR-011 (config socle minimal), ADR-012 (Docker dev minimal), ADR-013 (naming), ADR-014 (zero business table).
- Left PROPOSED (untouched): ADR-006 full scope, ADR-007 (jobs/Redis), ADR-008 (config & encryption full), ADR-009 (install lifecycle), ADR-010 (provider adapters).

## 2026-08-30 — 0.1 Verrouillage repo (isolated; pnpm activated)
- Files created: `.gitignore` (strengthened: node_modules, .env.* keep .env.example, dist/.next, coverage, DB local data, IDE/OS), `.nvmrc` (22).
- Verified: working tree clean; no secrets committed.
- Toolchain: `corepack enable` hit EPERM (Program Files protected); resolved by using `corepack pnpm <cmd>` (subcommand form, no admin). Workspace install done by owner via `corepack pnpm install` → 621 packages, `pnpm-lock.yaml` created, `turbo 2.10.12`, `prisma 6.19.3`; deps resolved: TS 5.9.3, Next 15.5.24.
- Local `.env` (gitignored) created: `apps/api/.env`, `apps/web/.env`.

## 2026-08-30 — 0.2 Bootstrap monorepo (files done; install pending)
- Files created: `package.json` (root `icode-host-pro`, workspaces, turbo scripts: dev/build/test/test:e2e/lint, db:up/db:down), `pnpm-workspace.yaml` (apps/*, packages/*), `turbo.json`, `packages/README.md` (reserved; no premature package).
- Pending: `pnpm install` (blocked by toolchain activation).

## 2026-08-30 — 0.3 Backend NestJS (files done; build pending)
- Files created (apps/api): `package.json`, `nest-cli.json`, `tsconfig.json`, `tsconfig.build.json`, `.env.example`, `src/config/constants.ts` (GlobalPrefix='api'), `src/config/configuration.ts` (fail-early env validation, ADR-011), `src/app.module.ts`, `src/main.ts` (global prefix, CORS dev, Swagger bootstrap), `src/prisma/prisma.service.ts`, `src/prisma/prisma.module.ts`, `src/health/health.controller.ts`, `src/health/health.module.ts`.
- Endpoint: `GET /api/health` returns app + DB connectivity (real raw `SELECT 1`).

## 2026-08-30 — 0.4 Persistance (Docker up + Prisma — validated)
- Files created: `docker-compose.yml` (root; PostgreSQL 16, named volume `icode_pg_data`, healthcheck; no Redis — ADR-012), `apps/api/prisma/schema.prisma` (no business models — ADR-014).
- Commands (owner-run): `docker compose up -d postgres` → container `icode-postgres` started; `corepack pnpm --filter @icode-host-pro/api generate` → Prisma Client v6.19.3 generated.
- Commands: `corepack pnpm --filter @icode-host-pro/api migrate` → reported "Already in sync, no schema change or pending migration found". Expected for a zero-model schema (ADR-014). **No migration folder and no database tables (including `_prisma_migrations`) were created** — this is the truthful, intended state; connectivity is proven at runtime by the health `SELECT 1`.
- `docs/sql-commandes.txt` to be updated (see 0.4/0.8) reflecting no business tables.

## 2026-08-30 — 0.5 Frontend Next.js (files done; build pending)
- Files created (apps/web): `package.json`, `next.config.mjs`, `tsconfig.json`, `.env.example`, `next-env.d.ts`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/page.tsx` (diagnostic page calling `GET /api/health` via NEXT_PUBLIC_API_URL).

## 2026-08-30 — 0.6 OpenAPI (files done; runtime pending)
- Wired Swagger module in `apps/api/src/main.ts` (docs at `/api/docs`). Verification pending once api runs.

## 2026-08-30 — 0.7 Tests (partially executed)
- Files created: `apps/api/src/health/health.controller.spec.ts` (unit, mocked Prisma), `apps/api/test/app.e2e-spec.ts` (e2e health), `apps/api/test/jest-e2e.json`.
- Commands (run by owner in local PowerShell because session Bash/PowerShell safety classifier was temporarily unavailable): `corepack pnpm --filter @icode-host-pro/api test` → **2/2 unit tests PASS**.
- Commands: `corepack pnpm --filter @icode-host-pro/api test:e2e` → **FAILED** (1 e2e): `TypeError: (0, supertest_1.default) is not a function`.
- Fix applied: `apps/api/test/app.e2e-spec.ts` import changed from `import request from 'supertest'` to `import request = require('supertest')` (CJS/ts-jest interop without esModuleInterop).
- Pending: re-run `test:e2e` to confirm; DB connectivity via real `SELECT 1` to be proven.

## 2026-08-30 — 0.7 Tests (completed + fix)
- Unit: 2/2 PASS. e2e: 1/1 PASS (after import fix to `import request = require('supertest')`). Build: 2/2 PASS.
- Live smoke verified by Claude once its shell became available again: /api/health 200 ok/database ok; /api/docs 200; /api/docs-json 200 with /api/health path; web / 200 diagnostic page.

## 2026-08-30 — Docker state & reset (owner request)
- Action: verified no old iCodeHost image/container/volume remains in Docker (owner had deleted them). Phase 0 uses only the official `postgres:16-alpine` image — no build reuse.
- Action: reset our dev DB to a pristine state: `docker compose down -v` (removed container+volume+network) then `docker compose up -d postgres` (fresh container+volume). Postgres healthy. No data existed to lose (zero tables, ADR-014).
- Note: unrelated `omniroute` app (diegosouzapw/omniroute) left untouched (not part of this project).
- Seeding: none (out of scope).

## 2026-08-30 — 0.8 Documentation (finalizing)
- Files modified: DECISIONS.md (approvals + ADR-011..014), PROJECT_STATUS.md (Phase 0 implemented, awaiting owner validation), README.md (monorepo layout + quick start), docs/sql-commandes.txt (Phase 0 DB entry), TASKS.md, CHANGELOG.md.
- Awaiting: owner browser validation to close Phase 0.

# PHASE 1 — AUTHENTICATION & FIRST TABLES (owner-validated 2026-08-31) ✓

## 2026-08-31 — 1.6 Close & commit
- Action: owner validated Phase 1 in browser ("validé").
- Files modified: PROJECT_STATUS.md (Phase 1 ✓), TASKS.md, CHANGELOG.md, HANDOVER.md.
- Command: git add + commit (Phase 1 baseline).

## 2026-08-30 — 1.0 Direction & GO
- Action: Asked the owner to choose the Phase 1 direction among proposals; owner selected **"Auth + 1res tables"**; explicit GO given.
- Reason: Owner picks phase scope; Auth is the natural first domain slice after the Phase 0 socle.
- Decisions APPROVED at GO: ADR-015 (auth architecture: stateless JWT Bearer access + httpOnly refresh cookie, rotated/hashed/revocable, bcryptjs, minimal ADMIN/USER RBAC), ADR-016 (User + RefreshToken tables).
- Files modified: DECISIONS.md.

## 2026-08-31 — 1.1 First business tables + migration (ADR-016)
- Files created: `apps/api/prisma/schema.prisma` models `User` + `RefreshToken` (+ enum `Role` ADMIN/USER); migration `apps/api/prisma/migrations/20260830053420_init_auth/`.
- Files modified: `apps/api/.env` / `.env.example` (added `JWT_SECRET`, `JWT_EXPIRES_IN=15m`, `REFRESH_EXPIRES_IN_DAYS=30`, `COOKIE_NAME=ihp_refresh`); `apps/api/src/config/configuration.ts` (load + fail-early require `JWT_SECRET`; expose jwtSecret/jwtExpiresIn/refreshExpiresInDays/cookieName).
- Commands: `corepack pnpm --filter @icode-host-pro/api run migrate --name init_auth` (first migration baseline — `_prisma_migrations` + `users` + `refresh_tokens` created). `prisma migrate status` → in sync.
- Troubleshooting: a P1002 advisory-lock stale session from a killed migrate blocked `migrate dev`; cleared via `docker compose restart postgres`.
- DOC for future AI: do NOT pass the literal `--` to the migrate script (drops into an interactive name prompt); use `--name <name>`.

## 2026-08-31 — 1.2 Auth + users modules (ADR-015)
- Files created (apps/api/src/auth): `types.ts` (JwtPayload{sub,email,role}, AuthTokens), `dto/register.dto.ts` + `dto/login.dto.ts` (class-validator IsEmail/MinLength(8)), `guards/jwt-auth.guard.ts` (verifyAsync → attaches req.user, `AuthedRequest`), `guards/roles.guard.ts` (Reflector + ROLES_KEY), `decorators/roles.decorator.ts` + `current-user.decorator.ts`, `auth.service.ts` (register/login/refresh/logout; bcrypt cost 10; randomBytes(48) base64url refresh; sha256 hashToken; signAsync), `auth.controller.ts` (register/login/refresh/logout; httpOnly cookie read/set/clear), `auth.module.ts`.
- Files created (apps/api/src/users): `users.service.ts` (getProfile strips passwordHash), `users.controller.ts` (`GET /api/users/me` under JwtAuthGuard + @CurrentUser), `users.module.ts` (imports AuthModule).
- Files modified: `apps/api/src/main.ts` (cookieParser, enableCors credentials, Swagger addBearerAuth), `apps/api/src/app.module.ts` (import AuthModule + UsersModule).
- Endpoints: register, login, refresh, logout, users/me.

## 2026-08-31 — 1.3 Web auth page + /api proxy
- Files created: `apps/web/src/app/auth/page.tsx` (client login/register form → `/api/auth/...` with credentials:'include'; then GET `/api/users/me` with Bearer; logout).
- Files modified: `apps/web/next.config.mjs` (same-origin rewrites `/api/:path*` → `${API_UPSTREAM ?? 'http://localhost:3001'}/api/:path*`; keeps httpOnly cookie working), `apps/web/src/app/page.tsx` (link → /auth).

## 2026-08-31 — 1.4 Build + fix CJS/ESM issue with @nestjs/jwt
- Commands: `corepack pnpm --filter @icode-host-pro/api build` PASS.
- Blocker: `test:e2e` failed at import — `@nestjs/jwt@12` ships an ESM-only dist (`import jsonwebtoken from 'jsonwebtoken'`) that CJS jest cannot parse ("Cannot use import statement outside a module"). Both e2e suites failed.
- Fix: pinned `@nestjs/jwt@^11.0.2` (CJS dist, tailored for Nest 11) via `corepack pnpm --filter @icode-host-pro/api add "@nestjs/jwt@^11.0.0"`.
- Fix 2 (auth correctness found by e2e): `JwtModule.register({})` was empty, so the guard's `verifyAsync` used the default secret while `AuthService` signed with an explicit one → `GET /users/me` returned 401. Registered the secret via `JwtModule.registerAsync` (inject ConfigService, `getOrThrow('jwtSecret')`, signOptions.expiresIn from config) in `auth.module.ts`, and simplified `issueTokens` to `signAsync(payload)` (secret+expire from module config) — signing and verification now share one config.

## 2026-08-31 — 1.5 Tests + live smoke (all PASS)
- Commands: `test` → 2/2; `test:e2e` → **6/6, 2 suites** (health + auth full flow); `build` API + web PASS.
- Live smoke on `http://localhost:3001/api` (node fetch): register 201 [accessToken + refresh cookie ✓] → `GET /users/me` 200 (email ok, passwordHash absent) → no token 401 → refresh 201 (new accessToken) → `/users/me` with refreshed token 200 → logout 201 → refresh after logout 401 (revocation verified).
- Live: Swagger `/api/docs` 200, spec securityScheme `bearer`/JWT; web proxy `GET localhost:3000/api/health` 200 (rewrite works); web `/auth` 200.
- Restarted dev servers (killed stale :3000 PID 5780 that predated the /api rewrite; API run stopped to fix e2e) — api `dev` (bipix4gz3, :3001) and web `dev` (b3gyb601z, :3000) running in background.
- Docs to be updated: sql-commandes.txt (done: Phase 1 DB entry), PROJECT_STATUS.md (done), TASKS.md (this entry), CHANGELOG.md, HANDOVER.md.

# PHASE 2 — MODÈLE CŒUR + CONSOLE /MANAGER (owner-validated 2026-08-31) ✓

## 2026-08-31 — 2.6 Close & commit
- Action: owner validated Phase 2 in browser ("validé"), including Swagger (products + servers groups confirmed correct after a forced refresh of the cached page).
- Files modified: PROJECT_STATUS.md (Phase 2 ✓), TASKS.md, CHANGELOG.md, HANDOVER.md.
- Command: git add + commit (Phase 2 baseline). Offer push.

## 2026-08-31 — 2.0 Direction & correction d'ownership (owner decisions)
- Action: owner chose Phase 2 direction **"Modèle cœur + dashboard"**; then chose **"Noyau resserré : Product + Server"** (no Provider table, no Deployment join).
- **Correction structurante (owner)**: my first draft wrongly put `ownerId` (User) on Product/Server. Owner corrected: Product + Server are PLATFORM-GLOBAL reference data administered in `/manager`, NOT client-owned. Client-owned resources (Subscription/Service/Deployment) are deferred until a real workflow needs them. ADR-017 records this.
- Access rules (owner-validated): Product read = any authenticated (ADMIN+USER); Product mutation & all Server routes = ADMIN only (internal infra never exposed to clients). Surface = `/manager` (no artificial client dashboard).
- Admin bootstrap: idempotent `db:seed`, credentials from gitignored `.env`, placeholders only in `.env.example`, no real secret in Git.

## 2026-08-31 — 2.1 Schema + migration (ADR-017)
- Files created: `apps/api/prisma/schema.prisma` additions — enum `ProductStatus` (DRAFT/ACTIVE/SUSPENDED/DISABLED), enum `ServerStatus` (UNKNOWN/PROVISIONING/ACTIVE/PROBLEM/REMOVED), models `Product` (name unique, kind String default 'generic', status, timestamps) and `Server` (name unique, hostname, status, timestamps). **No ownerId/User relation** — global reference entities.
- Migration: `20260831000649_init_core` applied via `run migrate --name init_core` (tables `Product` + `Server`, unique name indexes). Prisma Client v6.19.3 regenerated.
- Database entry documented in docs/sql-commandes.txt (tables + SQL).

## 2026-08-31 — 2.2 Admin bootstrap (seed)
- Files created: `apps/api/prisma/seed.ts` (Prisma upsert: create ADMIN from ADMIN_EMAIL/ADMIN_PASSWORD; on existing user, promote to ADMIN + isActive WITHOUT touching passwordHash — idempotent, non-destructive).
- Files modified: `apps/api/package.json` (script `db:seed` = `ts-node prisma/seed.ts`; `prisma.seed` config), `apps/api/.env` (local ADMIN_EMAIL/ADMIN_PASSWORD), `apps/api/.env.example` (placeholders only).
- Deps: added `dotenv` (dev) for env loading in the standalone seed.
- Commands: ran `db:seed` twice → idempotent (both runs "Admin ensured: admin@icodehost.local (role=ADMIN, isActive=true)").

## 2026-08-31 — 2.3 API products + servers + RBAC
- Files created (apps/api/src/products): `dto/create-product.dto.ts`, `dto/update-product.dto.ts` (PartialType), `products.service.ts` (CRUD + NotFoundException), `products.controller.ts`, `products.module.ts`.
- Files created (apps/api/src/servers): same structure (create-server.dto with hostname).
- RBAC: `ProductsController` — class `@UseGuards(JwtAuthGuard)` (all routes authed); GET read routes open to any authenticated; POST/PATCH/DELETE `@UseGuards(RolesGuard)` + `@Roles(ADMIN)`. `ServersController` — class `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(ADMIN)` (all routes admin-only). Reuses Phase 1 guards/decorators.
- Files modified: `apps/api/src/app.module.ts` (import ProductsModule + ServersModule).
- Command: API build PASS.

## 2026-08-31 — 2.4 Web /manager console
- Files created: `apps/web/src/lib/api.ts` (getAccessToken via POST /api/auth/refresh credentials:'include' — mints token from httpOnly cookie, NO localStorage; fetchMe), `apps/web/src/app/manager/page.tsx` (admin console: lists + creates + deletes servers & products; gates ADMIN; redirects to /auth on 401, shows "Accès refusé" for non-admin).
- Files modified: `apps/web/src/app/page.tsx` (link → /manager).
- Fixes: manager page initially created at `src/manager/page.tsx` (wrong — routes must be under `src/app/`); relocated to `src/app/manager/page.tsx`, import path → `../../lib/api`.
- Recurring Next 15 dev blocker: "Cannot find module './837.js'" (webpack-runtime chunk) — root cause is MIXING `next build` output with `next dev` in the same `.next` (build later wrote chunks dev had already compiled, then dev required a missing one), plus orphan `next dev` processes. Fix (repeatable): stop dev, kill ALL node/next on :3000, `rm -rf apps/web/.next`, start ONE `next dev`, and do NOT run `web build` while dev is running or the cache will corrupt again. After clean restart: `/`, `/auth`, `/manager` all 200, proxy `/api/health` 200.
- Command: web build PASS (routes `/`, `/auth`, `/manager`).

## 2026-08-31 — 2.5 Tests + live smoke (all PASS)
- Files created: `apps/api/src/products/products.service.spec.ts` (5 unit), `apps/api/src/servers/servers.service.spec.ts` (4 unit), `apps/api/test/core.e2e-spec.ts` (RBAC e2e: creates ADMIN via PrismaService, registers USER; asserts 401/403/200 matrix + admin CRUD).
- Commands: `test` → **11/11**; `test:e2e` → **15/15, 3 suites**; builds API + web PASS.
- Live smoke on :3001: admin login (seeded) OK; USER GET /products 200; USER POST /products 403; USER GET /servers 403 (infra hidden); no token 401; ADMIN create product 201 + server 201; admin lists both.
- Live web: `/` 200, `/manager` 200, proxy `/api/health` 200.

# EXECUTION ENTRY TEMPLATE
## YYYY-MM-DD — Phase X
- Action:
- Reason:
- Files created:
- Files modified:
- Files deleted:
- Commands/tools:
- Database changes:
- Tests/validation:
- Result:
- Follow-up:

# OPEN ITEMS
- [x] Authentication architecture (ADR-015 APPROVED — Phase 1).
- [ ] Async jobs architecture (ADR-007).
- [ ] Redis requirement (depends on ADR-007).
- [ ] Coolify API verification.
- [ ] HestiaCP API verification.
- [ ] Turnstile details.
- [ ] Email strategy.
- [ ] Asset storage.
- [ ] Reverse proxy/SSL.
- [ ] Observability.

# COMPLETED HISTORY
- Clean baseline (Pre-Phase 0): documentation pack + first AI orientation.
- Phase 0: source tree and config files authored; runtime execution (install, generate, migrate, tests) pending toolchain availability.
- Phase 1: Auth + first tables (User + RefreshToken) — implemented & machine-verified; awaiting owner validation.