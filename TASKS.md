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

# PHASE 3 — CONSOLE /MANAGER COMPLÈTE : GESTION ADMINS + DASHBOARD (owner-validated 2026-08-31) ✓

## 2026-08-31 — 3.6 Close & commit
- Action: owner validated Phase 3 in browser (« tout est ok, validé »).
- Files modified: PROJECT_STATUS.md (Phase 3 ✓), TASKS.md, CHANGELOG.md, HANDOVER.md.
- Command: git add + commit (Phase 3 baseline). Offer push.

## 2026-08-31 — 3.0 GO & périmètre
- Owner chose direction **« Dashboard /manager + gestion admins »** (AskUserQuestion).
- GO incluant l'exclusion explicite : **inscription par invitation / fermeture de l'inscription ouverte = HORS Phase 3** (différé, à faire plus tard avec un flux d'invitation).
- Périmètre: gestion utilisateurs admin, catalogue /manager enrichi (transitions de statut, hostname éditable), dashboard /manager (synthèse). Aucune nouvelle table ni migration (réutilise `User.role` / `User.isActive` / `Product.status` / `Server.status`).

## 2026-08-31 — 3.1 Backend: gestion utilisateurs admin (ADR-018)
- Files created: `apps/api/src/users/dto/update-user.dto.ts` (`UpdateUserDto`: role IsEnum + isActive IsBoolean, optionnels).
- Files modified: `apps/api/src/users/users.service.ts` (+`findAll` admin list; +`update(id,dto,actorId)` avec **règles anti-verrouillage**), `apps/api/src/users/users.controller.ts` (+`GET /api/users` et `PATCH /api/users/:id`, **ADMIN only**).
- Anti-verrouillage: on ne peut PAS modifier son propre rôle/actif; on ne peut PAS rétrograder/désactiver le **dernier** ADMIN actif (ForbiddenException). `toPublic` strippe toujours `passwordHash`.
- Files created: `apps/api/src/manager/manager.module.ts` + `manager.controller.ts` + `manager.service.ts` — `GET /api/manager/summary` (agrégation produits/serveurs/utilisateurs), **ADMIN only**.
- Files modified: `apps/api/src/app.module.ts` (importe ManagerModule).

## 2026-08-31 — 3.2 Tests + builds (all PASS)
- Files created: `apps/api/src/users/users.service.spec.ts` (8 unit: profil/liste/isolation passwordHash, anti-verrouillage self, dernier admin, promotion, désactivation user), `apps/api/src/manager/manager.service.spec.ts` (2 unit: agrégation + maps zéro), `apps/api/test/admin.e2e-spec.ts` (RBAC e2e: USER 403 sur /users + /manager/summary + PATCH; ADMIN liste + summary + promotion/démotion + self-guard 403 + role invalide 400).
- Commands: `test` → **21/21**; `test:e2e` → **23/23, 4 suites**; builds API + web PASS. Note: la ligne rouge `corepack : ...` vue en console PowerShell est un rendu de stderr, PAS un échec.

## 2026-08-31 — 3.3 Web /manager (dashboard + utilisateurs + catalogue enrichi)
- Files modified: `apps/web/src/lib/api.ts` (+`apiJson`, `apiError`, `ManagerSummary`, `UserAdmin`, `listUsers`, `updateUser`, `getManagerSummary`).
- Files modified: `apps/web/src/app/manager/page.tsx` (dashboard synthèse via /manager/summary; serveurs: création + statut + **hostname éditable inline**; produits: création + **transition de statut** DRAFT/ACTIVE/SUSPENDED/DISABLED; lien → /manager/utilisateurs).
- Files created: `apps/web/src/app/manager/utilisateurs/page.tsx` (liste comptes; **Promouvoir/Rétrograder** ADMIN↔USER; **Activer/Désactiver**; erreurs 403 anti-verrouillage affichées).

## 2026-08-31 — 3.4 Live smoke + restart web dev
- Live API :3001: `/api/users` & `/api/manager/summary` 401 sans token; admin login OK → `/api/users` 9 comptes (aucun `passwordHash`); `/api/manager/summary` agrège 1 produit / 1 serveur / 9 users.
- Live: **self-guard** PATCH rôle self → 403 « Vous ne pouvez pas modifier votre propre rôle... ». Message clair.
- Web build PASS (routes `/`, `/auth`, `/manager`, `/manager/utilisateurs`). Dev server arrêté avant le build (évite corruption `.next`), `.next` purgé, puis `next dev` relancé.
- Live web: `/manager` 200, `/manager/utilisateurs` 200, proxy `/api/health` 200.

## 2026-08-31 — 3.5 Correctif anti-verrouillage : rétrogradation d'un admin déjà inactif (bug signalé par le propriétaire)
- **Bug signalé** : le propriétaire a promu `u_1788135183287@example.com` en ADMIN puis n'a pas pu le rétrograder — « il faut avoir au moins un admin » alors que `admin@icodehost.local` existe bien en ADMIN. Sur d'autres utilisateurs, promotion/rétrogradation fonctionnait.
- **Diagnostic (requête DB)** : `u_1788135183287@example.com` était `role=ADMIN, isActive=false` (déjà inactif avant la promotion). Le compte ADMIN actif n'était donc que 1 (admin@icodehost.local). L'ancien garde-fou se déclenchait sur TOUTE rétrogradation/désactivation d'un ADMIN, y compris un admin DÉJÀ inactif (qui ne réduit jamais le pool d'admins actifs).
- **Correctif** (`apps/api/src/users/users.service.ts`) : le garde-fou ne s'applique que quand la modification RETIRE un ADMIN ACTIF — `isActiveAdmin = role===ADMIN && isActive`, et `removingActiveAdmin = isActiveAdmin && (nextRole!==ADMIN || nextActive===false)`. Rétrograder/désactiver un admin déjà inactif est désormais toujours permis (pas d'appel à `count`).
- **Tests de régression** : 2 unit (`apps/api/src/users/users.service.spec.ts` — garde-fou ne doit PAS se déclencher, `count` non appelé) + 1 e2e (`apps/api/test/admin.e2e-spec.ts` — ADMIN peut rétrograder un admin déjà inactif, 200).
- **Commandes** : `test` → **23/23** (5 suites); `test:e2e` → **24/24** (4 suites).
- **Résultat** : le propriétaire peut désormais rétrograder `u_1788135183287@example.com` via l'UI (fix live sur l'API de dev :3001).

# PHASE 4 — JOURNAL D'AUDIT « QUI A FAIT QUOI » (owner-validated 2026-08-31) ✓

## 2026-08-31 — 4.6 Close & commit
- Action: owner validated Phase 4 (« validé »), incl. la colonne « Ressource » du journal rendue lisible (nom + hostname serveur, JSON brut conservé en infobulle).
- Files modified: PROJECT_STATUS.md (Phase 4 ✓), TASKS.md, CHANGELOG.md, HANDOVER.md.
- Command: unit **28/28** + e2e **29/29** re-confirmés verts (clôture), puis git add + commit unique (Phase 4 baseline). Push offert. `apps/web` typecheck PASS sur le correctif UI.

## 2026-08-31 — 4.0 GO & périmètre
- Owner chose direction **« D. Audit journal »** (AskUserQuestion). GO donné.
- Périmètre (comme proposé) : tracer les actions sensibles (mutations admin + événements d'auth). Nouvelle table `AuditLog` ; lecture ADMIN only ; append-only ; émission côté service (pas de bus d'événements — choix réversible noté) ; UI `/manager/journal`. ADR-019 APPROVED au GO.
- Note : `/auto-mode-setup` invoqué en cours de travail n'est pas un skill disponible dans ma liste => non exécutable.

## 2026-08-31 — 4.1 Modèle + migration (ADR-019)
- Files modified: `apps/api/prisma/schema.prisma` — modèle `AuditLog` (actorId nullable FK User onDelete SetNull, actorEmail dénormalisé, action, resourceType/resourceId polymorphiques, details Json, createdAt; indexes createdAt/resourceType/action) + relation `User.auditLogs`.
- Command: `corepack pnpm --filter @icode-host-pro/api run migrate --name init_audit` → migration `20260831024151_init_audit` appliquée. `generate` du client a échoué en EPREM (DLL verrouillée par les dev servers en cours) → arrêt de tous les node sauf web, `generate` OK (client v6.19.3 régénéré), puis relance des dev servers API :3001 + web :3000 en fond.

## 2026-08-31 — 4.2 Backend : AuditService + controller (ADR-019)
- Files created: `apps/api/src/audit/audit.service.ts` (`record` best-effort + `findAll` paginé/filtré), `audit.controller.ts` (`GET /api/audit` ADMIN only), `audit.module.ts` (`@Global`, exporte AuditService ; ré-enregistre JwtModule + RolesGuard localement pour éviter la dépendance circulaire avec AuthModule), `dto/audit-query.dto.ts` (page/perPage/actorId/action/resourceType/from/to).
- Files modified: `apps/api/src/app.module.ts` (importa AuditModule).

## 2026-08-31 — 4.3 Branchage de l'émission dans les services
- `apps/api/src/auth/auth.service.ts` : émission `auth.register`/`auth.login`/`auth.refresh`/`auth.logout` (logout récupère le user du token pour journaliser l'acteur).
- `apps/api/src/users/users.service.ts` : `update(id, dto, actor: {sub,email})` (au lieu d'un simple sub) ; émission `user.promote`/`user.demote`/`user.activate`/`user.deactivate` avec détails from→to.
- `apps/api/src/products/products.service.ts` + `servers.service.ts` : signature +`actor` sur create/update/remove ; émission `product.*`/`server.*` (create/update/delete).
- Contrôleurs users/products/servers : passent l'`@CurrentUser()` (JwtPayload) à la couche service.

## 2026-08-31 — 4.4 Tests + builds + live (all PASS)
- Files created: `apps/api/src/audit/audit.service.spec.ts` (5 unit : mapping, coercition null, best-effort, page+filtres, clamp perPage), `apps/api/test/audit.e2e-spec.ts` (RBAC : USER 403 ; ADMIN 200 shape + filtre ; register/login produisent des entrées ; une action promote visible+filtrable ; pagination).
- Files modified: `users/products/servers` specs (injection mockAudit + acteur) — ajout de assertions journalisation.
- Commands: `test` → **28/28** (6 suites); `test:e2e` → **29/29** (5 suites); builds API + web PASS (routes incl. `/manager/journal`).
- Live :3001: `/api/audit` 401 unauth; admin login → token → `/api/audit` 200 (16 entrées : auth.register/login, user.promote/demote, server.create/delete...). Web `/manager/journal` 200.

## 2026-08-31 — 4.5 Web /manager/journal
- Files modified: `apps/web/src/lib/api.ts` (+`AuditEntry`, `AuditPage`, `AuditQuery`, `listAudit`).
- Files created: `apps/web/src/app/manager/journal/page.tsx` — tableau paginé + filtres (type de ressource, action) + navigation précédent/suivant, gated ADMIN. Correctif TS (garde `data &&` dans les onClick).
- Files modified: `apps/web/src/app/manager/page.tsx` (lien → Journal d'audit).

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

# PHASE 5 — ESPACE CLIENT + ACCÈS SÉCURISÉ (owner-validated direction 2026-08-31 — implémenté, en attente de validation live + push)

## 2026-08-31 — 5.0 GO & périmètre
- Action: owner chose direction **« A puis B »** (fermer l'inscription d'abord, puis l'espace client) et a confirmé « c'est l'admin qui doit ajouter et modifier et gérer les serveurs complètement mais le client ne manipule pas l'infra ».
- Périmètre: **5B** inscription fermée + invitations (ADR-020), puis **5A** espace client Subscription+Service (ADR-021). Un seul commit à la clôture une fois les tests verts. Provisionnement = **stub de transition de statut** (pas de déploiement réel — ADR-010/007 hors périmètre). `Deployment` reste différé.
- Decisions APPROVED au GO: ADR-020 (register 410 + Invitation), ADR-021 (Subscription+Service, ownership par possession, client ne voit jamais l'infra).
- Files modified: DECISIONS.md (ADR-020/021 APPROVED au GO).

## 2026-08-31 — 5.1 Modèle + migration (ADR-020/021)
- Files modified: `apps/api/prisma/schema.prisma` — modèles `Invitation` (email, tokenHash sha256 unique, issuerId FK User SetNull, expiresAt, usedAt/revokedAt), `Subscription` (userId FK Cascade, productId FK Restrict, status PENDING/ACTIVE/REJECTED/SUSPENDED/CANCELLED), `Service` (name, subscriptionId FK Cascade, serverId nullable FK Server SetNull, status REQUESTED/PROVISIONING/ACTIVE/PROBLEM/SUSPENDED/REMOVED) + enums + back-relations User/Product/Server.
- Command: `corepack pnpm --filter @icode-host-pro/api run migrate --name init_client_access` → migration `20260831084839_init_client_access` appliquée. `generate` OK (client v6.19.3). `prisma migrate status` in sync (4 migrations).
- Files modified: `apps/api/src/config/configuration.ts` (+`inviteExpiresInDays` optionnel, défaut 7), `apps/api/.env.example` (INVITE_EXPIRES_IN_DAYS).

## 2026-08-31 — 5.2 Backend invitations (ADR-020) — inscription fermée
- Files created: `apps/api/src/invitations/dto/create-invitation.dto.ts` (email IsEmail), `invitations.service.ts` (create 409 si user ou invite pending existe, token randomBytes(32) base64url + sha256, TTL inviteExpiresInDays, list avec status dérivé pending/used/revoked/expired, revoke idempotent, **consume** par tokenHash : 400 si revoked/used/expired/email≠invited, crée USER bcrypt 10 + usedAt + audit invite.accept), `invitations.controller.ts` (POST/GET /api/invitations + POST :id/revoke, tous ADMIN via JwtAuthGuard+RolesGuard), `invitations.module.ts` (forwardRef AuthModule).
- Files modified: `apps/api/src/auth/auth.service.ts` (register → **410 Gone** « Inscription fermée — un compte se crée uniquement via une invitation. » + `acceptInvite(dto)` → invitations.consume + issueTokens), `auth.controller.ts` (POST /api/auth/accept-invite + register 410), `auth.module.ts` (forwardRef InvitationsModule), `apps/api/src/app.module.ts` (import InvitationsModule).
- Files created: `apps/api/src/auth/dto/accept-invite.dto.ts` (token IsString, email IsEmail, password MinLength 8, name optional IsString).

## 2026-08-31 — 5.3 Backend espace client (ADR-021) — subscriptions + services
- Files created: `apps/api/src/subscriptions/dto/create-subscription.dto.ts` (productId IsString), `create-service.dto.ts` (name MinLength 2 + subscriptionId IsString, **pas de serverId**), `update-subscription.dto.ts` (status IsEnum SubscriptionStatus), `update-service.dto.ts` (status? + serverId? IsString).
- Files created: `apps/api/src/subscriptions/subscriptions.service.ts` — SERVICE_SELECT via `.select` (pas `.include`), transition maps SUBSCRIPTION_TRANSITIONS + SERVICE_TRANSITIONS (whitelist, idempotent), client-scopé `where:{userId}` (404 sur id d'autrui), createSubscription (refuse DRAFT/DISABLED, PENDING), listMySubscriptions, cancelMySubscription (PENDING/ACTIVE/SUSPENDED→CANCELLED), createMyService (ACTIVE own sub only, REQUESTED), listMyServices (**select explicite SANS serverId/server**), admin listAllSubscriptions/listAllServices + updateSubscription/updateService (affecter serveur existant sinon 400, audit service.assign/remove + provision/activate stub).
- Files created: `apps/api/src/subscriptions/client.controller.ts` (GET/POST /api/client/subscriptions + PATCH :id/cancel + GET/POST /api/client/services, @UseGuards(JwtAuthGuard) any auth), `admin.controller.ts` (GET/PATCH /api/admin/subscriptions + GET/PATCH /api/admin/services, @UseGuards(JwtAuthGuard,RolesGuard)+@Roles(ADMIN)), `subscriptions.module.ts`.
- Files modified: `apps/api/src/app.module.ts` (import SubscriptionsModule).

## 2026-08-31 — 5.4 Web
- Files modified: `apps/web/src/lib/api.ts` (+Invitation/InvitationStatus, list/create/revoke, acceptInvite POST /api/auth/accept-invite, inviteLink, ProductRef/Subscription/ServerRef/Service + helpers client/admin).
- Files modified: `apps/web/src/app/auth/page.tsx` (réécrit : modes login|invite, useEffect lit ?invite=&email= pour préremplir, onglet register supprimé, accept via acceptInvite + fetchMe).
- Files created: `apps/web/src/app/manager/invitations/page.tsx` (ADMIN-gated : créer par email, token+lien copiable 1×, liste statuts, révoquer), `apps/web/src/app/manager/subscriptions/page.tsx` (ADMIN-gated : subs approve/reject/suspend/activate + services assign server via GET /api/servers + provision/activate), `apps/web/src/app/client/page.tsx` (any-authenticated : catalogue ACTIVE/SUSPENDED, s'abonner, annuler, demander un service sous sub ACTIVE, lister mes services sans infra + note « hébergement géré par l'admin »).
- Files modified: `apps/web/src/app/page.tsx` (lien → /client), `apps/web/src/app/manager/page.tsx` (liens Invitations + Souscriptions), `apps/web/src/app/manager/journal/page.tsx` (labels invite.*/subscription.*/service.* + mots ressource).

## 2026-08-31 — 5.5 Tests + builds + live (all PASS — clôture)
- Files created: `apps/api/src/invitations/invitations.service.spec.ts` (11 unit), `apps/api/src/subscriptions/subscriptions.service.spec.ts` (16 unit).
- Files created: `apps/api/test/invitations.e2e-spec.ts` (7 tests : 401/403, token 1×, duplicate 409, list pending, expired, revoke idempotent + accept revoked 400), `apps/api/test/client.e2e-spec.ts` (13 tests : register 410, USER 403 /api/admin/*, subscribe PENDING, service non-ACTIVE 400, approve→ACTIVE, request REQUESTED, assign+provision→PROVISIONING→ACTIVE stub, client list sans server/serverId, REQUESTED→ACTIVE 400, isolation inter-clients 404, cancel CANCELLED + approve 400, reject→REJECTED puis activate 400).
- Files modified: `apps/api/test/auth.e2e-spec.ts` (réécrit : admin via Prisma + invite 2 users via POST /api/invitations, register 410, accept 201, /users/me USER, 401 sans token, login wrong pwd 401, login après accept, **one-shot** second accept 400, wrong-email 400), `core.e2e-spec.ts`/`admin.e2e-spec.ts`/`audit.e2e-spec.ts` (USER créés direct via prisma.user.create + login ; audit attend ['auth.login'] plus ['auth.register','auth.login']), `test/jest-e2e.json` (testTimeout 30000).
- Commands: `test` → **62/62** (8 suites) ; `test:e2e` → **51/51** (7 suites) — verts sur Postgres réel ; `build` API + web PASS (8 routes) ; `npx tsc --noEmit` apps/web PASS ; `prisma migrate status` in sync.
- Live smoke :3001: /api/health ok ; register → 410 ; login seed admin → token ; GET /api/products 200 ; GET /api/invitations (ADMIN) 200.
- Fixes en cours de phase: invitations spec mock call index (calls[0]→calls[0][0]), Prisma `include` scalaire→`select` (SERVICE_SELECT) + serverId scalar, client listMyServices select sans serverId, invitations e2e stray `});`, hook timeout 30s sous 7 suites, DB transient unreachable → retry.
- Docs: DECISIONS.md (ADR-020/021 APPROVED), CHANGELOG.md (Phase 5 Added/Changed/Verified/Pending), PROJECT_STATUS.md (Phase 5 COMPLETE, 4 migrations, 62/51), docs/sql-commandes.txt (Phase 5 DB entry).

## 2026-08-31 — 5.6 Close & commit (done)
- Action: clôture documentaire + **commit unique** Phase 5 (`6f80115`).
- Files modified: PROJECT_STATUS.md, TASKS.md, CHANGELOG.md, HANDOVER.md, docs/sql-commandes.txt.
- Command: git add -A + git commit (Bash heredoc, Co-Authored-By) — `feat: Phase 5 — espace client + accès sécurisé (ADR-020 invitations, ADR-021 client workspace)`, 45 fichiers. Push offert.

## 2026-08-31 — 5.7 Owner validation (✓)
- Action: owner a validé la Phase 5 en live (« validé ») : invitation → accept → login → `/client` s'abonner → approbation `/manager/subscriptions` → demande de service → affectation serveur → ACTIVE ; register → 410 ; client sans données serveur. Phase 5 closed.
- Files modified: PROJECT_STATUS.md (Phase 5 ✓), TASKS.md (cette section), CHANGELOG.md, HANDOVER.md.
- Command: git add + commit (docs owner validation). Push offert.

# PHASE 6 — CONFIGURATION MAIL ADMIN + EMAILS D'INVITATION (ADR-022) — implémenté, en attente de validation live + push

## 2026-08-31 — 6.0 GO & périmètre
- Action: owner a demandé la stratégie email pour les invitations (« l'admin doit pouvoir ajouter/modifier/gérer la configuration de mail depuis l'interface admin (smtp, host, port…) avec possibilité de tester avec envoi de mail test »).
- Périmètre choisi via AskUserQuestion : **« Mail seul »** — SMTP config admin + test email + emails d'invitation automatiques ; OAuth/MFA/Turnstile **différés**. Stockage du mot de passe : **« Chiffré au repos »** (AES-256-GCM, clé maître `ENCRYPTION_KEY`).
- Decision APPROVED au GO : ADR-022 (singleton `MailSetting`, password AES-256-GCM, UI admin + test, emails d'invitation best-effort). Valide un périmètre ÉTROIT d'ADR-008 (chiffrement applicatif au repos) ; ADR-008 complet / ADR-006/007/009/010 restent PROPOSED.

## 2026-08-31 — 6.1 Modèle + migration + crypto (ADR-022)
- Files modified: `apps/api/prisma/schema.prisma` — modèle `MailSetting` (singleton : id, enabled Boolean @default(false), host, port Int @default(587), secure Boolean @default(false), user?, passwordEnc?, fromEmail, fromName?, timestamps).
- Command: `corepack pnpm --filter @icode-host-pro/api run migrate --name init_mail` → migration `20260831120703_init_mail` appliquée (5 migrations, `prisma migrate status` in sync). Dev servers arrêtés avant migrate (EPERM DLL) puis vérifiés.
- Files created: `apps/api/src/crypto/crypto.service.ts` (AES-256-GCM : clé = sha256(ENCRYPTION_KEY), payload base64 `iv||tag||data`, `MailCryptoError` si clé absente), `crypto.module.ts` (non-global, exporte CryptoService).
- Files modified: `apps/api/src/config/configuration.ts` (+`encryptionKey`/`publicBaseUrl` optionnels — set fail-early intact), `apps/api/.env.example` (+ENCRYPTION_KEY, PUBLIC_BASE_URL), `apps/api/.env` local (gitignored) (+ENCRYPTION_KEY de dev).
- Deps: `corepack pnpm --filter @icode-host-pro/api add nodemailer` (+`-D @types/nodemailer`) → nodemailer 9.1.0, CJS, jest-safe.

## 2026-08-31 — 6.2 Backend module mail
- Files created: `apps/api/src/mail/mail-transport.factory.ts` (couture de test — `create(cfg)` → nodemailer transporter), `mail.service.ts` (sans état : `sendMail(cfg,msg)` → `MailException` avec message SMTP ; `buildInviteMessage` = lien `/auth?invite=<token>&email=<email>` sur `publicBaseUrl`), `mail-settings.service.ts` (get masqué — jamais `passwordEnc`, `hasPassword` seulement ; `update` PATCH-semantics : `enabled=true` requiert host+fromEmail 400, password ''/absent = inchangé, valeur = chiffrée, user/fromName '' = effacés ; `getMailConfig` déchiffre ; `test` sur config enregistrée → ok ou 400 message SMTP + audit `mail.test` ; `sendInvitationMail` ; `isEnabled`), `dto/update-mail-settings.dto.ts` (tout @IsOptional), `dto/test-mail.dto.ts` (IsEmail), `mail-settings.controller.ts` (`@Controller('admin/mail')`, JwtAuthGuard+RolesGuard+@Roles(ADMIN), `GET|PUT /` + `POST /test`), `mail.module.ts`.
- Files modified: `apps/api/src/app.module.ts` (import MailModule).
- **Fix cycle d'import (trouvé par l'e2e)** : la chaîne Mail→Auth→Invitations→Mail est circulaire au niveau des fichiers ; `mail.module.ts` importe AuthModule via `forwardRef` (même pattern qu'Auth↔Invitations).
- Commands: `corepack pnpm build` PASS (2 itérations — typage Prisma UpdateInput/CreateInput séparés).

## 2026-08-31 — 6.3 Invitations — email automatique best-effort
- Files modified: `apps/api/src/invitations/invitations.module.ts` (import MailModule), `invitations.service.ts` (injecte MailSettingsService ; dans `create()` après audit `invite.create` : si `isEnabled()` → `sendInvitationMail` try/catch **never throw**, retour `emailSent: boolean` (token manuel conservé), audit `invite.email` `{email, emailSent, reason?}`).
- Le token one-shot reste le fallback affiché dans `/manager/invitations` — aucun envoi ne casse jamais la création.

## 2026-08-31 — 6.4 Web
- Files modified: `apps/web/src/lib/api.ts` (+MailSettings/TestMailResult/CreatedInvitation, getMailSettings/updateMailSettings/sendTestMail).
- Files created: `apps/web/src/app/manager/mail/page.tsx` (ADMIN-gated : formulaire SMTP — Activer, host, port 465/587/25, secure, user, password « inchangé si vide », fromEmail, fromName ; badge Configuré/Non configuré + warning hasPassword ; section test SMTP avec erreur remontée ; validation host+fromEmail requise).
- Files modified: `apps/web/src/app/manager/invitations/page.tsx` (après création : ✅ « Email envoyé à X » sinon ⚠️ bannière config mail absente/échec + lien manuel toujours copiable), `apps/web/src/app/manager/page.tsx` (lien « Configuration mail → »).

## 2026-08-31 — 6.5 Tests + builds + live smoke (all PASS)
- Files created: `apps/api/src/crypto/crypto.service.spec.ts` (5 unit : round-trip, IV aléatoire, mauvaise clé, payload altéré, clé manquante → MailCryptoError), `apps/api/src/mail/mail.service.spec.ts` (5 unit : message FR + lien, PUBLIC_BASE_URL, auth user / from nu, erreur → MailException), `apps/api/src/mail/mail-settings.service.spec.ts` (14 unit : defaults masqués, hasPassword jamais exposé, encrypt+store, '' = inchangé, user/fromName '' = null, enabled sans host 400, first-create, ENCRYPTION_KEY absente 400, getMailConfig déchiffre/échoue MailException, test ok/erreur/no-config, sendInvitationMail).
- Files modified: `apps/api/src/invitations/invitations.service.spec.ts` (+mock MailSettingsService ; mail off → emailSent false, mail on → true + audit `invite.email`, send échoue → false + raison journalisée).
- Files created: `apps/api/test/mail.e2e-spec.ts` (10 tests : 401/403 RBAC, GET defaults masqués, PUT store → GET hasPassword jamais raw, PUT enabled sans host 400, test OK via **overrideProvider(MailTransportFactory)**, test 400 message SMTP, invite email enlevé→true / désactivé→false, audit mail.settings.update masqué) — aucun SMTP réel contacté.
- Commands: `test` → **90/90** (11 suites) ; `test:e2e` → **61/61** (8 suites) ; `build` API + web PASS (route `/manager/mail` incluse) ; `npx tsc --noEmit` apps/web PASS ; `prisma migrate status` in sync (5 migrations).
- Fixes en cours: spec mail.service transporter capturé par test (pas mock.results[0]), spec invitations rejette avec vrais MailException, `.env` local +ENCRYPTION_KEY (e2e : PUT password sans clé → 400 de cascade).
- Live smoke :3001: admin login OK → `GET /api/admin/mail` defaults masqués `{host:null,hasPassword:false}` → `POST /api/admin/mail/test` sans config → 400 « Configuration mail non définie. ». API dev (nest watch) laissée en cours pour la validation propriétaire.

# OPEN ITEMS
- [x] Authentication architecture (ADR-015 APPROVED — Phase 1).
- [x] Inscription par invitation / fermeture de l'inscription ouverte (ADR-020 APPROVED — Phase 5 : `POST /api/auth/register` → 410, `POST /api/auth/accept-invite` + `Invitation`).
- [x] Espace client : souscription + service (ADR-021 APPROVED — Phase 5 : `Subscription` + `Service`, ownership par possession, client ne touche jamais l'infra — provisionnement stub).
- [x] Email strategy (ADR-022 APPROVED — Phase 6 : SMTP config admin + test email + emails d'invitation best-effort ; ENCRYPTION_KEY pour le password at rest ; jeton manuel conservé en fallback).
- [ ] Async jobs architecture (ADR-007 — provisionnement réel différé).
- [ ] Redis requirement (depends on ADR-007).
- [ ] Coolify API verification.
- [ ] HestiaCP API verification.
- [ ] Turnstile details.
- [ ] OAuth / MFA (différés par le propriétaire au profit du « Mail seul » en Phase 6).
- [ ] Asset storage.
- [ ] Reverse proxy/SSL.
- [ ] Observability.
- [ ] ADR-008 complet (gestion de secrets, architecture de config persistée — Phase 6 n'a validé qu'un périmètre étroit : chiffrement applicatif au repos).

# COMPLETED HISTORY
- Clean baseline (Pre-Phase 0): documentation pack + first AI orientation.
- Phase 0: source tree and config files authored; runtime execution (install, generate, migrate, tests) pending toolchain availability.
- Phase 1: Auth + first tables (User + RefreshToken) — owner-validated, poussée.
- Phase 2: Modèle cœur Product+Server globaux plateforme + console /manager — owner-validated, poussée.
- Phase 3: gestion utilisateurs admin + dashboard /manager + catalogue enrichi — owner-validated 2026-08-31.
- Phase 4: journal d'audit « qui a fait quoi » (ADR-019) — owner-validated 2026-08-31, commitée.
- Phase 5: espace client + accès sécurisé (ADR-020 invitations 410 + ADR-021 Subscription/Service) — owner-validated 2026-08-31, tests 62/62 + 51/51 verts, builds PASS.
- Phase 6: configuration mail admin + emails d'invitation (ADR-022) — implémenté 2026-08-31, tests 90/90 unit + 61/61 e2e (8 suites), builds PASS, en attente de validation live propriétaire + push.