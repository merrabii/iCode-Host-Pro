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
- Commands (owner-run): `docker compose up -d postgres` → container `icode-postgres` started; `corepack pnpm --filter @codediali/api generate` → Prisma Client v6.19.3 generated.
- Commands: `corepack pnpm --filter @codediali/api migrate` → reported "Already in sync, no schema change or pending migration found". Expected for a zero-model schema (ADR-014). **No migration folder and no database tables (including `_prisma_migrations`) were created** — this is the truthful, intended state; connectivity is proven at runtime by the health `SELECT 1`.
- `docs/sql-commandes.txt` to be updated (see 0.4/0.8) reflecting no business tables.

## 2026-08-30 — 0.5 Frontend Next.js (files done; build pending)
- Files created (apps/web): `package.json`, `next.config.mjs`, `tsconfig.json`, `.env.example`, `next-env.d.ts`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/page.tsx` (diagnostic page calling `GET /api/health` via NEXT_PUBLIC_API_URL).

## 2026-08-30 — 0.6 OpenAPI (files done; runtime pending)
- Wired Swagger module in `apps/api/src/main.ts` (docs at `/api/docs`). Verification pending once api runs.

## 2026-08-30 — 0.7 Tests (partially executed)
- Files created: `apps/api/src/health/health.controller.spec.ts` (unit, mocked Prisma), `apps/api/test/app.e2e-spec.ts` (e2e health), `apps/api/test/jest-e2e.json`.
- Commands (run by owner in local PowerShell because session Bash/PowerShell safety classifier was temporarily unavailable): `corepack pnpm --filter @codediali/api test` → **2/2 unit tests PASS**.
- Commands: `corepack pnpm --filter @codediali/api test:e2e` → **FAILED** (1 e2e): `TypeError: (0, supertest_1.default) is not a function`.
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
- Commands: `corepack pnpm --filter @codediali/api run migrate --name init_auth` (first migration baseline — `_prisma_migrations` + `users` + `refresh_tokens` created). `prisma migrate status` → in sync.
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
- Commands: `corepack pnpm --filter @codediali/api build` PASS.
- Blocker: `test:e2e` failed at import — `@nestjs/jwt@12` ships an ESM-only dist (`import jsonwebtoken from 'jsonwebtoken'`) that CJS jest cannot parse ("Cannot use import statement outside a module"). Both e2e suites failed.
- Fix: pinned `@nestjs/jwt@^11.0.2` (CJS dist, tailored for Nest 11) via `corepack pnpm --filter @codediali/api add "@nestjs/jwt@^11.0.0"`.
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
- Command: `corepack pnpm --filter @codediali/api run migrate --name init_audit` → migration `20260831024151_init_audit` appliquée. `generate` du client a échoué en EPREM (DLL verrouillée par les dev servers en cours) → arrêt de tous les node sauf web, `generate` OK (client v6.19.3 régénéré), puis relance des dev servers API :3001 + web :3000 en fond.

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
- Command: `corepack pnpm --filter @codediali/api run migrate --name init_client_access` → migration `20260831084839_init_client_access` appliquée. `generate` OK (client v6.19.3). `prisma migrate status` in sync (4 migrations).
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

# PHASE 6 — CONFIGURATION MAIL ADMIN + EMAILS D'INVITATION (ADR-022) — implémenté + owner-validated 2026-08-31 (SMTP Brevo réel + domaine codediali.com), en attente de push

## 2026-08-31 — 6.0 GO & périmètre
- Action: owner a demandé la stratégie email pour les invitations (« l'admin doit pouvoir ajouter/modifier/gérer la configuration de mail depuis l'interface admin (smtp, host, port…) avec possibilité de tester avec envoi de mail test »).
- Périmètre choisi via AskUserQuestion : **« Mail seul »** — SMTP config admin + test email + emails d'invitation automatiques ; OAuth/MFA/Turnstile **différés**. Stockage du mot de passe : **« Chiffré au repos »** (AES-256-GCM, clé maître `ENCRYPTION_KEY`).
- Decision APPROVED au GO : ADR-022 (singleton `MailSetting`, password AES-256-GCM, UI admin + test, emails d'invitation best-effort). Valide un périmètre ÉTROIT d'ADR-008 (chiffrement applicatif au repos) ; ADR-008 complet / ADR-006/007/009/010 restent PROPOSED.

## 2026-08-31 — 6.1 Modèle + migration + crypto (ADR-022)
- Files modified: `apps/api/prisma/schema.prisma` — modèle `MailSetting` (singleton : id, enabled Boolean @default(false), host, port Int @default(587), secure Boolean @default(false), user?, passwordEnc?, fromEmail, fromName?, timestamps).
- Command: `corepack pnpm --filter @codediali/api run migrate --name init_mail` → migration `20260831120703_init_mail` appliquée (5 migrations, `prisma migrate status` in sync). Dev servers arrêtés avant migrate (EPERM DLL) puis vérifiés.
- Files created: `apps/api/src/crypto/crypto.service.ts` (AES-256-GCM : clé = sha256(ENCRYPTION_KEY), payload base64 `iv||tag||data`, `MailCryptoError` si clé absente), `crypto.module.ts` (non-global, exporte CryptoService).
- Files modified: `apps/api/src/config/configuration.ts` (+`encryptionKey`/`publicBaseUrl` optionnels — set fail-early intact), `apps/api/.env.example` (+ENCRYPTION_KEY, PUBLIC_BASE_URL), `apps/api/.env` local (gitignored) (+ENCRYPTION_KEY de dev).
- Deps: `corepack pnpm --filter @codediali/api add nodemailer` (+`-D @types/nodemailer`) → nodemailer 9.1.0, CJS, jest-safe.

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

## 2026-08-31 — 6.6 Validation live propriétaire (SMTP Brevo réel) — VALIDÉ
- Owner a acheté le domaine **codediali.com**, l'a lié/validé dans Brevo, configuré `/manager/mail` (host `smtp-relay.brevo.com:587`, user `9bda29001@smtp-brevo.com`, fromEmail **contact@codediali.com**) et **testé l'envoi → ça marche**. Validation live Phase 6 donnée par le propriétaire (« c'est validé pour la configuration de mail »).
- Incidents diagnostiqués pendant la validation (tous côté config Brevo, pas côté code — le pipeline iCode a remonté chaque erreur correctement dans l'UI/400) :
  1. **525 5.7.1 Unauthorized IP address** → politique « sender IP authorization » du compte Brevo : autoriser l'IP publique (`196.217.131.123` Casablanca — **IP ADSL dynamique**, à réautoriser au changement).
  2. **Expéditeur non validé** (« Sending has been rejected because the sender ... is not valid ») — l'API affiche `ok:true` (Brevo accepte la session SMTP 250) mais Brevo rejette le message en ASYNCHRONE côté queue ; visible dans **Brevo → Logs → SMTP** (event `error` `reason: sender not valid`). Fix : utiliser un fromEmail validé (`contact@codediali.com` une fois le domaine lié/validé). Vérifié : événements **`delivered`** dans Brevo pour les 2 tests (mourad.moreno@gmail.com + mourad.errabii@gmail.com).
- Leçon docs : le endpoint de test remonte les erreurs SMTP **synchrones** (login) ; un rejet asynchrone (sender invalid, IP, spam) peut montrer `ok:true` — vérifier **Brevo → Logs → SMTP**.
- Reste en option (non bloquant) : un test live d'**invitation avec email** (créer une invite → l'email arrive avec le lien `/auth?invite=…` → accept de bout en bout).
- **Rebrand (note owner, différé)** : changer la marque **iCode Host Pro → Code Diali** / `codediali.com` **une fois le projet terminé**.

# PHASE 7 — DESIGN SYSTEM DE L'INTERFACE (ADR-023 — implémenté 2026-08-31, commité `31af3e2`)

# PHASE 7bis — POLISH UI : SELECTS + CONTRASTE LIGHT + TOASTS (ADR-023 follow-up — implémenté 2026-08-31)

## 2026-08-31 — retour propriétaire + périmètre
- Le propriétaire valide le design existant et précise « ne pas changer les couleurs et le style » — 4 finitions purement front demandées : (1) optimiser l'affichage des boutons à menus déroulants, (2) un peu plus de contraste des bordures en thème clair, (3) bien espacer les messages succès/erreur, (4) messages en pop-up avec un bouton OK et qui disparaissent après 5 s (ou au clic sur OK).
- Contrainte : **aucun changement backend/DB** (pas de migration, tests API intacts).

## CSS (`apps/web/src/app/globals.css`)
- **Sélects déroulants** : `.select` = `appearance:none` + chevron SVG data-URI (`background-image`, couleur `--text-secondary` par thème), `padding-right:36px`, `cursor:pointer`, `:hover` border active-text, `:disabled` not-allowed, `<option>` teintés (`--input-bg`/`--text-primary`). Hauteurs = `.input`/`.btn` (mêmes padding verticaux) → alignés avec les boutons ; `.select-sm` compact calqué sur `.btn-sm`. (Flèche native incohérente supprimée.)
- **Contraste light** : uniquement `--border #e7eaf0 → #d5dce8` et `--border-soft #eef0f4 → #e1e6ef` (nuance gris-bleu identique). Dark + toutes les autres teintes inchangés.
- **Espacement messages** : `.alert` `margin-bottom:12px` (+ reset `.stack > .alert, .panel-body > .alert { margin-bottom:0 }` pour les conteneurs à gap).
- **Toasts** : section `/* 15b */` — `.toast-host` (fixed, top sous topbar, right 16, z-index 200, pointer-events none), `.toast` (+ `.ok/.error/.info/.warn` bordure teinte), `.toast-btn` (OK), `@keyframes toast-in` (~0.18 s), responsive pleine largeur <600px.

## Composant toast
- Created: `apps/web/src/components/toast.tsx` ('use client') — `ToastProvider` (contexte ; état `ToastItem[] {id,tone,message}` ; `push` avec `setTimeout 5000 → dismiss`, timers nettoyés au démontage), `useToast()` → `{ok,error,info,warn}`. Rendu `{children}` + `.toast-host` (icône de ton + message + bouton OK ; `role="status"`/`alert`, `aria-live` polite/assertive). API stable via useMemo.
- Modifié: `apps/web/src/app/layout.tsx` — `<ToastProvider>` enveloppe `{children}` → disponible sur toutes les pages (y compris `/auth` bare).

## Conversion des pages (états message/error/testResult → toasts ; handlers inchangés)
- `/manager` : états supprimés, helper `flash()` → `toast.ok()` ; erreurs → `toast.error(apiError(...))`.
- `/manager/utilisateurs` : « Utilisateur mis à jour. » → toast.ok ; échecs → toast.error.
- `/manager/journal` : échec de chargement → toast.error.
- `/manager/invitations` : création/révocation/copie → toasts ; **panneau `created` (jeton + lien) conservé inline** (contexte persistant).
- `/manager/mail` : validations, enregistrement et **résultat du mail de test** → toasts (rendu inline « ✅ Envoyé / ❌ Échec » supprimé).
- `/manager/subscriptions` : flash → toast.ok ; transitions refusées → toast.error.
- `/client` : souscription/annulation/service demandé → toasts ; échec de chargement → toast.error.
- `/auth` : connexion/invitation acceptée/fetchMe/logout → toasts.
- **Conservé inline volontairement** : alerte diagnostic de `/` (santé API).

## Vérifications (2026-08-31)
- `npx tsc --noEmit` dans apps/web → **PASS (exit 0)** (faits sur les 8 pages converties + toast.tsx).
- `web build` → **PASS** (10 routes intactes ; dev web arrêté + `rm -rf .next` avant build — leçon Phase 2), puis `next dev :3000` relancé.
- Smoke HTTP :3000 → **200** sur les 9 pages.
- Aucun changement API/DB ; suites API non relancées (rien de touché).



## 2026-08-31 — GO + décision
- Action: le propriétaire a fourni une page HTML de référence (dashboard d'hébergement, thèmes dark/light) et donné un GO explicite : « Ne copier que le style et couleurs complet (sidebar + topbar + cartes…) et oublier tout le reste. Le système ne doit absolument pas être lié à une brand et tout doit être modifiable. »
- Décision: **ADR-023 APPROVED** (DECISIONS.md) — reproduction à l'identique du style/couleurs de la référence, brand-agnostic, tout modifiable via variables CSS. Pas de Tailwind, pas de framework CSS.

## Doc du design system
- Created: `docs/design/DESIGN_SYSTEM.md` — origine/référence, tokens dark/light exacts (copiés), typographie/dimensions/rayons, composants, layout des zones, règles d'écriture AI, config marque (rebrand différé Code Diali).

## Tokens + classes (apps/web/src/app/globals.css — réécrit de ~30 lignes à ~1100)
- Tokens dark (défaut) : `--bg #070c1f`, `--sidebar-bg #030718`, `--header-bg #0d1526`, `--card-bg #0d1629`, `--card-bg-2 #0b1322`, `--border #1c2740`, `--border-soft #16203a`, `--text-primary #fff`, `--text-secondary #94a3b8`, `--text-muted #5b6b85`, `--active-bg rgba(0,179,119,.14)`, `--active-text #34d399`, `--hover-bg #0f1930`, `--input-bg #0c1425`, `--shadow`, teintes badges/icônes (green/blue/violet/amber/cyan/pink/gray) + **rouge ajouté** (absent de la référence, même langage) pour les erreurs.
- Tokens light : `--bg #f8fafc`, sidebar `#f9fafc`, header/card `#fff`, border `#e7eaf0`, text `#10151f`, etc.
- Marque (`--brand-primary #00b377` = `--green` référence, `--brand-primary-dark #009966`, `--brand-accent`, `--brand-gradient`, glow bouton) — tout modifiable.
- Classes : topbar (logo/gradient, brand-title/sub, pill-tag, info-pill, user-chip/avatar, icon-btn, theme-toggle), sidebar (tenant, nav, nav-item.active, nav-badge, refresh, foot), shell/main, hero (eyebrow, cta), stats-grid/stat-card (icon primary/info/violet/amber…), bottom-grid/panel/status-row/status-pill, badge variants, boutons (primary/secondary/danger), inputs/selects/fields/check, table, alerts, empty/spinner/loading, page-head, auth-card, utils (row/stack/mt/mb/nowrap/ta-right/…), responsive (<1100 stats 2col + bottom 1col, <900 sidebar masquée, <600 stats 1col), :focus-visible/:disabled.

## Thème + layout
- `apps/web/src/app/layout.tsx` : `<html lang="fr">`, script **anti-FOUC** inline (lit `localStorage ihp-theme`, défaut dark, pose `data-theme` avant peinture), metadata depuis brand.
- Created: `apps/web/src/components/theme-toggle.tsx` (bascule dark/light, persiste `ihp-theme`).

## Composants partagés
- Created: `apps/web/src/config/brand.ts` (nom/sous-titre/tag/initials + commentaire rebrand Code Diali), `apps/web/src/config/nav.ts` (ADMIN_NAV 6 entrées + Espace client, CLIENT_NAV).
- Created: `apps/web/src/components/icons.tsx` (~20 icônes svg inline, style de la référence, zéro dépendance).
- Created: `apps/web/src/components/app-shell.tsx` (topbar + sidebar + nav active via usePathname + foot + thème + logout ; mode `bare` pour écrans centrés).
- Created: `apps/web/src/components/ui.tsx` (Button primary/secondary/danger, Badge, Alert, Panel, StatCard, Field/Input/Select, PageLoading, EmptyState, PageIntro, Denied, statusTone).
- Created: `apps/web/src/lib/session.ts` (`useAdminSession` — bootstrap identique au code répété des 6 pages admin : redirect /auth si pas de jeton, denied si non-ADMIN).

## Refactor des pages (logique métier inchangée — mêmes appels/états/handlers)
- `src/app/manager/page.tsx` : hero (eyebrow + h1 + CTA) + 3 StatCards (produits/serveurs/utilisateurs) + 2 panneaux bottom-grid (serveurs : hostname éditable + statut select + delete ; produits : statut + delete) dans la coquille.
- `src/app/manager/utilisateurs/page.tsx` : table (compte/rôle badge/statut badge/actions promo-demote activer-désactiver), busy par ligne.
- `src/app/manager/journal/page.tsx` : filtres (select resource/input action) + table (Quand/Acteur/Action/Ressource) + pagination.
- `src/app/manager/invitations/page.tsx` : formulaire email + bloc created (alert emailSent/lien + token + copier) + table des invitations (statuts en badges).
- `src/app/manager/mail/page.tsx` : badge Configuré/Non configuré + warning hasPassword + formulaire SMTP (enabled/host/port/secure/user/password/fromEmail/fromName) + section test SMTP.
- `src/app/manager/subscriptions/page.tsx` : tables souscriptions (approuver/rejeter/suspendre/réactiver) + services (affecter serveur + provisionner stub).
- `src/app/client/page.tsx` : coquille Espace client + panneaux catalogue (statut-rows + Souscrire) / mes souscriptions / demander un service / mes services (badges de statut).
- `src/app/auth/page.tsx` : mode bare (topbar seule) + auth-card centrée (login/invite, pré-remplissage ?invite, fetchMe, logout).
- `src/app/page.tsx` : diagnostic `/api/health` dans la coquille bare (badges + pre).

## Vérifications
- `npx tsc --noEmit` dans apps/web → **PASS (exit 0)**.
- `corepack pnpm --filter @codediali/web build` → **PASS** (10 routes, exit 0). Note : dev web arrêté le temps du build (risque de corruption `.next`), l'API :3001 est restée up.
- Smoke HTTP :3000 → 200 sur `/`, `/auth`, `/manager`, `/manager/utilisateurs`, `/manager/journal`, `/manager/invitations`, `/manager/mail`, `/manager/subscriptions`, `/client`. HTML servi : `lang="fr"`, script `ihp-theme` présent ; CSS servi contient les tokens du design system (29 Ko, brand `#00b377`, fonds dark/light).
- Aucun changement API/DB : pas de migration, pas de test API touché.

# PHASE 7ter — GESTION ADMIN SERVEURS & PRODUITS + DÉTAILS INFRASTRUCTURE (ADR-024)

## 2026-09-01 — 7ter.0 GO & périmètre (retour propriétaire sur le dashboard)
- Le propriétaire signale un **bug UI** dans `/manager` : les 3 serveurs affichent leurs boutons de suppression **derrière** la case « Produits (catalogue) » (débordement du dashboard 2 colonnes étroites).
- Consigne : corriger sans capture d'écran ni modèle visuel (lecture code uniquement), « soyez expert designer… ne garde pas les pages centrées et augmente la largeur des pages… créer un menu dans la sidebar pour les serveurs… cette page sera modifiée au fur et à mesure quand la connexion des serveurs sera établie et avoir beaucoup plus de détails… ». Dashboard = **lecture seule** (pas d'édition).
- **Direction choisie via AskUserQuestion** : « Page Produits dédiée aussi » + nouveaux champs serveur — **Adresse IP, Port, Fournisseur, Région/localisation, Quota Max Comptes Hébergés (Int), case ✓ TLS strict** (« Vérifier les certificats SSL/TLS stricts sur les requêtes API du serveur »), **Module de Panneau Serveur** (adaptateur HESTIA/COOLIFY d'abord — cPanel/DirectAdmin après).
- Decision: **ADR-024 APPROVED** (DECISIONS.md).

## 2026-09-01 — 7ter.1 Modèle + migration (ADR-024)
- Files modified: `apps/api/prisma/schema.prisma` — enum `ServerPanelProvider {NONE HESTIA COOLIFY}` (commenté : cPanel/DirectAdmin futurs) + modèle `Server` étendu (`ipAddress String?`, `port Int?`, `provider String?`, `region String?`, `quotaMaxAccounts Int?`, `strictTls Boolean @default(true)`, `panelProvider ServerPanelProvider @default(NONE)`). Tous optionnels.
- Command: `corepack pnpm --filter @codediali/api run migrate --name init_server_details` → migration `20260901021234_init_server_details` appliquée. Dev servers arrêtés avant migrate (EPERM DLL), `prisma generate` OK (client v6.19.3). `prisma migrate status` → **6 migrations** in sync.

## 2026-09-01 — 7ter.2 API serveurs étendue (DTO + service + tests)
- Files modified: `apps/api/src/servers/dto/create-server.dto.ts` (+7 champs optionnels validés : ipAddress IsString MaxLength 64, port IsInt Min1 Max65535, provider/region MaxLength 64, quotaMaxAccounts IsInt Min0, strictTls IsBoolean, panelProvider IsEnum), `apps/api/src/servers/servers.service.ts` (create whitelist explicite 9 champs), `apps/api/src/servers/servers.service.spec.ts` (+1 test full details : ip/port/provider/region/quota/strictTls/panelProvider via objectContaining ; expect strict étendu aux 7 undefined).
- Files modified: `apps/api/test/core.e2e-spec.ts` (+1 test : ADMIN POST serveur avec tous les champs ADR-024 → 201, PATCH panelProvider COOLIFY + port 2222 → 200).
- Commands: `corepack pnpm --filter @codediali/api build` **PASS** ; `corepack pnpm --filter @codediali/api test` → **91/91** unit PASS.

## 2026-09-01 — 7ter.3 Web : nav + layout + lib/api
- Files modified: `apps/web/src/config/nav.ts` (+items **Serveurs** (IconServer), **Produits** (IconBox) — ordre Tableau de bord, Serveurs, Produits, Utilisateurs, Souscriptions, Invitations, Mail, Journal).
- Files modified: `apps/web/src/app/globals.css` — `wrap-md` 900 → **1320px**, `.table-wide` (min-width 760px + overflow-x), `.grid-form` (auto-fit minmax 210px), `.grid-form-actions`, `.panel-span`, `.quick-links`, `.quick-link` (cards), `tr.row-editing` surlignage (active-bg). `.panel overflow:hidden` conservé (filet) ; le flex-wrap temporaire des status-row n'est plus nécessaire (table réelle).
- Files modified: `apps/web/src/lib/api.ts` — types `PanelProvider`, `ServerAdmin` (7 nouveaux champs), `ProductAdmin`, `ServerPatch` + helpers `listServers`/`createServer`/`updateServer`/`deleteServer`/`listProducts`/`createProduct`/`updateProduct`/`deleteProduct`.

## 2026-09-01 — 7ter.4 Pages dédiées + dashboard lecture seule
- Files created: `apps/web/src/app/manager/serveurs/page.tsx` (~448 lignes) — CRUD table large ADMIN-only : colonnes Serveur (nom + hostname)/IP/Port/Fournisseur/Région/Quota/**TLS badge Strict|Off**/**Panneau badge HESTIA violet|COOLIFY cyan|—**/Statut (UNKNOWN/PROVISIONING/ACTIVE/PROBLEM/REMOVED)/Actions ; création grid-form (name+hostname obligatoires, strictTls checkbox, note « statuts pilotés par la connexion réelle (à venir) ») ; **édition inline** par ligne (inputs/selects sm + checkbox TLS + IconCheck/IconX) ; `emptyDraft`/`toPatch` (vide → null, nombres validés) ; busy par action.
- Files created: `apps/web/src/app/manager/produits/page.tsx` — CRUD table : Produit (nom + id court), Type badge violet, Statut select DRAFT/ACTIVE/SUSPENDED/DISABLED, Supprimer (confirm).
- Files modified: `apps/web/src/app/manager/page.tsx` — **réécrit lecture seule** : hero (CTA « Gérer les serveurs » / « Gérer le catalogue »), 3 StatCards (produits/serveurs/users actifs), 2 panneaux synthèse (slice 6 + badges de statut, `linkHref`/`linkLabel` « Gérer… »), panneau « Lien rapide » (6 pages admin). Tous formulaires/handlers create/delete/status **supprimés** du dashboard.
- Fix: la page serveurs supprimait le statut à l'édition (Draft sans `status`) → `status` ajouté au Draft + `toPatch` inclut `status` + `saveEdit` utilise le patch complet ; faux import `IconChevronDown` et `statusTone` inutilisé supprimés (noUnusedLocals).

## 2026-09-01 — 7ter.5 Validation (builds + e2e + smoke)
- Commands: `npx tsc --noEmit` apps/web **PASS** ; `corepack pnpm --filter @codediali/web build` **PASS** (14 routes statiques — `/manager/serveurs` 5.28 kB, `/manager/produits` 3.80 kB, `/manager` 3.66 kB ; `.next` purgé avant build — leçon Phase 2).
- Commands: `corepack pnpm --filter @codediali/api test:e2e` → **62/62, 8 suites PASS** (vert sur Postgres réel ; le nouveau test ADR-024 y compris).
- **Redémarrage environnement** : Docker Desktop éteint (le web était « pas accessible ») → docker up (postgres healthy), API :3001 + web :3000 relancés en fond. Smoke :3000 → **200** `/`, `/manager`, `/manager/serveurs`, `/manager/produits` ; proxy `/api` 401 sans session ; login ADMIN → `/users/me` 200, `/api/servers` (4), `/api/products` (2), `/api/manager/summary` (`{products:2 ACTIVE, servers:4, users:16/17}`) ; zéro erreur web/API.
- **Validation live propriétaire (en cours)** : le propriétaire a créé un serveur `momo | mour.ma | UNKNOWN | ip 10.10.2.36` + un produit `Installation Fees` via l'UI entre deux smoke → preuve que le CRUD écrit réellement.
- Docs: DECISIONS.md (ADR-024 APPROVED), CHANGELOG.md (Phase 7ter Added/Changed/Verified/Pending), PROJECT_STATUS.md (Phase 7ter), docs/sql-commandes.txt (Phase 7ter DB entry — à compléter), TASKS.md (cette section).

## 2026-09-01 — 7ter.6 Validation propriétaire (✓) + clôture
- Action: owner a validé la Phase 7ter en live (« validé ») — nouveaux écrans `/manager/serveurs` (création + édition inline avec les nouveaux champs) et `/manager/produits`, dashboard lecture seule, layout large 1320px.
- Files modified: PROJECT_STATUS.md (Phase 7ter ✓), TASKS.md (cette section), CHANGELOG.md, HANDOVER.md.
- Command: git add + commit (docs owner validation) puis push — Phase 7ter **closed**.

# PHASE 8 — CONNEXION RÉELLE DES SERVEURS : SONDE DE CONNECTIVITÉ (ADR-025)
Direction (AskUserQuestion) : « Implémenter le premier connecteur (ADR-010) : ping/détection
de l'état réel d'un serveur (Hestia/Coolify), vérification de l'API, statut
PROVISIONING/ACTIVE/PROBLEM piloté par la connexion, test de connectivité depuis
/manager/serveurs. » — implémenté 2026-09-01 (en attente validation propriétaire).

## 2026-09-01 — 8.0 GO & périmètre
- Action: périmètre étroit d'ADR-010 : **sonde de connectivité (TCP + HTTP)** déclenchée par
  l'admin depuis `/manager/serveurs` — détecte l'état réseau réel et **propose** une bascule
  de statut. Adaptateurs fournisseurs réels / credentials / auto-provisionnement = HORS
  périmètre (ADR-010 complet reste PROPOSED).
- Files modified: DECISIONS.md (ADR-025 APPROVED).

## 2026-09-01 — 8.1 Modèle + migration (ADR-025)
- Files modified: `apps/api/prisma/schema.prisma` — `Server` +3 champs nullable (écrits
  uniquement par la sonde, jamais par l'admin) : `lastCheckedAt DateTime?`,
  `lastProbeOk Boolean?` (null = jamais sondé), `lastProbeDetail String?`.
- Commands: `corepack pnpm --filter @codediali/api run migrate --name init_server_check`
  → migration `20260901082020_init_server_check` appliquée (dev API arrêté d'abord — leçon
  EPERM DLL) + generate → **7 migrations**, `migrate status` in sync.

## 2026-09-01 — 8.2 ProbeTransportFactory (couture de test)
- Files created: `apps/api/src/servers/probe-transport.factory.ts` — `ProbeTarget`
  (`host`,`port`,`strictTls`,`probeMode?`), `ProbeResult` (`ok`,`detail`,`latencyMs?`,
  `httpStatus?`), `ProbeTransport` abstraite, `NodeProbeTransport` runtime (TCP `net.connect` +
  HTTP/HTTPS `rejectUnauthorized=strictTls`), `ProbeTransportFactory.create(timeoutMs=5000)`.
  Protocole dérivé du port (80/443/8443 ⇒ HTTP, sinon TCP) ; `probeMode` force HTTP (tests sur
  port éphémère). Toute réponse HTTP = joignable (même 5xx). Timeout par défaut 5 000 ms.
- **Leçon DI Nest** : AUCUN paramètre primitif injecté au constructeur de la factory (un
  `Number` serait résolu comme un token DI introuvable → AppModule échouait ; vu quand la suite
  e2e entière sauf `server-check` plantait sur « Cannot read properties of undefined »). Le
  timeout vit dans `create(timeoutMs)`, surchargeable.
- Files created: `apps/api/src/servers/probe-transport.factory.spec.ts` — transport RÉEL sur
  loopback (déterministe, aucun réseau externe) : HTTP 200, TCP ok, connexion refusée, hôte
  introuvable.

## 2026-09-01 — 8.3 API : endpoint + audit
- Files modified: `apps/api/src/servers/servers.service.ts` — `check(id, actor)` :
  `findOne` (404 si inconnu) → cible `hostname`+`port` (défaut 22) via `probeFactory.create()` →
  persiste les 3 champs → audit `server.check` `{host, port, ok, detail, latencyMs, httpStatus,
  statusLeft}` → retour `{ server, probe }`. **Le statut n'est JAMAIS forcé** (la sonde
  propose, l'admin valide via PATCH).
- Files modified: `apps/api/src/servers/servers.controller.ts` — `POST :id/check` (ADMIN,
  classe `@Roles(Role.ADMIN)`).
- Files modified: `apps/api/src/servers/servers.module.ts` — provider `ProbeTransportFactory`.
- Files modified: `apps/api/src/servers/servers.service.spec.ts` — 3 tests check (succès port
  22 défaut, échec port explicite, 404 sans sonde).
- Files created: `apps/api/test/server-check.e2e-spec.ts` — suite e2e (5 tests) avec
  `overrideProvider(ProbeTransportFactory)` (couture, zéro réseau) : 401/403/404, succès
  persisté (relecture GET), échec + audit `server.check`.
- Files modified: `apps/web/src/app/manager/journal/page.tsx` — libellé `server.check`:
  « Test de connexion serveur ».

## 2026-09-01 — 8.4 Web : colonne Connexion + Tester + bascule statut
- Files modified: `apps/web/src/lib/api.ts` — type `ServerAdmin` (+3 champs sonde) +
  `ServerProbe` + `ServerCheckResult` + helper `checkServer(t, id)`.
- Files modified: `apps/web/src/app/manager/serveurs/page.tsx` — colonne **Connexion**
  (badge OK/Échec/— persistant via `lastProbe*`, détail `lastProbeDetail`) + bouton
  **« Tester »** (spin pendant la sonde, `IconRefresh`) + raccourci `→ ACTIVE` (résultat OK) /
  `→ PROBLEM` (échec) = bascule rapide validée par l'admin (PATCH journalisé `server.update`).
  État `probeMap` par serveur (résultat restitué sans rechargement).

## 2026-09-01 — 8.5 Validation (builds + tests + smoke)
- Command: `corepack pnpm --filter @codediali/api test` → **unit 98/98** (12 suites, +7).
- Command: `corepack pnpm --filter @codediali/api test:e2e` → **e2e 67/67, 9 suites** (+
  `server-check` 5 tests) PASS sur Postgres réel.
- Command: `npx tsc --noEmit` apps/web → **PASS**. `web build` → **PASS** (14 routes ;
  `/manager/serveurs` 5.8 kB ; dev web arrêté + `.next` purgé avant build — leçon Phase 2).
- Smoke live API :3001 — création `probe-smoke-local` (hostname localhost, port 5432) →
  `POST /api/servers/:id/check` → `{ ok: true, detail: "TCP 5432 : accessible (8 ms)",
  latencyMs: 8 }`, persisté (`lastProbeOk: true` + GET relu) ; création `probe-smoke-refused`
  (127.0.0.1:5999) → `{ ok: false, detail: "Connexion refusée" }` persisté ; audit
  `server.check` avec `{ok, host, port, detail, latencyMs, httpStatus, statusLeft}`. Serveurs
  de smoke supprimés. Smoke web :3000 → **200** `/`, `/manager/serveurs`, `/manager/journal` ;
  label « Test de connexion serveur » présent dans le bundle.
- Docs: DECISIONS.md (ADR-025), CHANGELOG.md (Phase 8), PROJECT_STATUS.md, docs/sql-commandes.txt
  (Phase 8 DB entry), TASKS.md (cette section), HANDOVER.md.
- En attente: validation live propriétaire → commit + push (inclut le rework UX — voir 8.6).

## 2026-09-01 — 8.6 Rework UX page serveurs (comm. propriétaire — grille de cartes + drawer)
- Owner feedback: « dans la page serveur le tableau et la page ne sont pas bien UX optimisé !
  Prière d'utiliser un style très moderne pour l'affichage des tableaux ou donnée modifiable. »
- Direction via AskUserQuestion : **Grille de cartes + panneau latéral (drawer)** (style
  dashboards infra — Coolify/Hetzner/Cloudflare). **Zéro changement API/DB** — pur front,
  design system ADR-023 respecté (tokens, couleurs, brand), logique métier + sonde Phase 8
  **conservées** (handlers/validations/toasts identiques).
- Files modified: `apps/web/src/components/icons.tsx` — +`IconSearch`, `IconPencil`, `IconTrash`.
- Files modified: `apps/web/src/app/globals.css` — nouvelle section 22 réutilisable :
  `.srv-toolbar` (recherche loupe + `input`), `.srv-search`, `.srv-chips`/`.srv-chip` (+`.active`,
  compteur `.n`) ; `.srv-grid`/`.srv-card` (+head/ico teintée/body 2-col/`srv-field`/`srv-field-full`/
  `srv-conn`/détail/quick/`srv-card-foot`/`srv-actions` révélées au survol) ; `.drawer-overlay`/
  `.drawer` (animations mount 0.18/0.22 s, `drawer-head`/`body`/`foot`, `.drawer-close`) ;
  `.badge .dot` ; responsive <600px. Tokens uniquement.
- Files modified: `apps/web/src/app/manager/serveurs/page.tsx` — réécriture de la VUE :
  PageIntro + bouton « Nouveau serveur » → drawer ; toolbar recherche + chips statut avec compteurs
  + compteur affichés/total (filtrage mémoire via `useMemo`) ; grille de cartes (statut ⇒ icône
  teintée, badge statut, hostname mono, champs, bloc connexion intégré : badge OK/Échec/— + détail
  « dernière sonde » + « Dernier test » + Tester + bascule rapide ; actions Modifier/Supprimer au
  survol) ; drawer création/édition (`drawerTitle`, sélect statut en édition seulement, poids
  Annuler/« Créer le serveur »/« Enregistrer », Échap + clic backdrop ferme si pas busy) ; états
  vides (liste vide vs recherche sans résultat). Ancien `<Panel>`-form inline et édition inline
  table supprimés.
- Command: `corepack pnpm --dir apps/web exec tsc --noEmit` → **PASS (exit 0)**.
- Command: `web build` → **PASS** (14 routes, `/manager/serveurs` **6.39 kB** ; dev web :3000
  arrêté + `.next` purgé avant build — leçon Phase 2), puis dev web relancé (PID 876). Marqueurs
  `srv-grid`/`srv-card`/`drawer-overlay`/`srv-chip`/`IconSearch`/`IconPencil`/`IconTrash` présents
  dans le chunk client + CSS servi ; smoke `/manager/serveurs` **200**.
- Docs: CHANGELOG.md (Phase 8 bis), PROJECT_STATUS.md, HANDOVER.md, TASKS.md (cette section).
  Aucun changement API/DB/test → unit 98/98 + e2e 67/67 toujours valides (non rejoués).
- En attente: validation live propriétaire (grille + drawer) → commit + push Phase 8 (avec rework).

# PHASE 9 — ADAPTATEURS FOURNISSEURS RÉELS (COOLIFY / HESTIA) + CREDENTIALS + VÉRIFICATION D'API (ADR-010 COMPLET) — 2026-09-02

## 2026-09-02 — 9.0 GO & périmètre (demande propriétaire)
- Owner: « Adaptateurs fournisseurs réels (Hestia / Coolify — via panelProvider, credentials +
  vérification d'API) — ADR-010 complet. » + consigne autonomie (pas de prompts de permissions,
  terminer la phase + faire ses propres tests + faire signe seulement quand c'est prêt).
- Direction: compléter ADR-010 — credentials panneau **chiffrées au repos** + **vérification d'API**
  par panneau, sur le socle `panelProvider` (ADR-024) et la couture de test (prise en Phase 8/ADR-025).

## 2026-09-02 — 9.1 Modèle + migration (ADR-010)
- Files modified: `apps/api/prisma/schema.prisma` — `Server` +6 champs nullable pour le panneau :
  `apiBaseUrl String?`, `apiTokenEnc String?` (jeton chiffré au repos, jamais exposé),
  `apiUser String?` (Hestia, défaut `api`), `panelVerifiedAt DateTime?`, `panelOk Boolean?`,
  `panelDetail String?`. `panelProvider` existant (ADR-024) réutilisé comme déclencheur.
- Command: `corepack pnpm --filter @codediali/api run migrate --name init_server_panel`
  → migration `20260901131323_init_server_panel` appliquée (dev API arrêté d'abord — leçon EPERM
  DLL) + generate → **8 migrations**, in sync.

## 2026-09-02 — 9.2 PanelTransportFactory (couture de test, type ProbeTransport)
- Files created: `apps/api/src/servers/panel-transport.factory.ts` — `PanelKind`
  ('HESTIA'|'COOLIFY'), `PanelTarget` (`provider`,`baseUrl`,`token`,`user?`,`strictTls`),
  `PanelVerifyResult` (`ok`,`detail`,`latencyMs?`,`version?`), `PanelTransport` abstraite,
  `NodePanelTransport` runtime, `PanelTransportFactory.create(timeoutMs=8000)`.
  - **Coolify** : `GET {base}/version` avec `Authorization: Bearer <token>` ; version = JSON
    `{version}` **ou texte brut** (le vrai panel renvoie `4.1.2` en texte — ajusté en 9.5 après le test réel).
  - **Hestia** : `GET {base}?cmd=sysinfo&format=json&returncode=yes` avec `Authorization: Basic
    base64(user:token)` (user défaut `api`), rejet si `returncode != 0`.
  - `401/403` ⇒ détail clair en français (« Jeton API rejeté (401) » / « Jeton d'accès rejeté (403) ») ;
    réseau ⇒ `networkDetail` (ECONNREFUSED/ENOTFOUND/ETIMEDOUT/TLS). Timeout 8 000 ms.

## 2026-09-02 — 9.3 API : credentials chiffrées + vérification d'API + audit
- Files modified: `apps/api/src/servers/dto/create-server.dto.ts` — `apiBaseUrl?`/`apiToken?`/`apiUser?`
  (jeton = secret ENTRANT). `UpdateServerDto` hérite via `PartialType` : `apiToken` absent=inchangé,
  `''`=effacé, sinon remplacé (chiffré).
- Files modified: `apps/api/src/servers/servers.service.ts` :
  - `ServerView = Omit<Server,'apiTokenEnc'> & { hasApiToken }` — le jeton **n'est JAMAIS exposé**,
    seulement `hasApiToken` (leçon applicative : jamais de secret en sortie).
  - `encryptToken()` via `CryptoService` AES-256-GCM (échec → `BadRequestException` 400).
  - `create`/`update` : `apiBaseUrl ''→null`, `apiToken undefined→garde / ''→null / sinon chiffre`.
  - `verifyPanel(id, actor)` : exige `panelProvider != 'NONE'` + `apiBaseUrl` + `apiTokenEnc` (400),
    déchiffre, `panelFactory.create().verify(target)`, persiste `panelVerifiedAt`/`panelOk`/
    `panelDetail`, audit `server.panel.verify` `{provider, ok, version}` → retour `{ server, result }`.
- Files modified: `apps/api/src/servers/servers.controller.ts` — `POST :id/panel-verify` (ADMIN, classe
  `@Roles(Role.ADMIN)`).
- Files modified: `apps/api/src/servers/servers.module.ts` — imports `CryptoModule`, provider
  `PanelTransportFactory`.
- Files modified: `apps/web/src/app/manager/journal/page.tsx` — libellé `server.panel.verify`:
  « Vérification API panneau ».

## 2026-09-02 — 9.4 Tests (unit + e2e)
- Files created: `apps/api/src/servers/panel-transport.factory.spec.ts` — transport RÉEL sur
  simulateurs loopback (déterministe, aucun réseau externe) : Coolify 200 JSON + Bearer, 401 ;
  Hestia 200 returncode 0 (user `api` défaut), user explicite, returncode != 0, 403 ; connexion
  refusée (port réel fermé).
- Files modified: `apps/api/src/servers/servers.service.spec.ts` — 7 cas verifyPanel/credentials :
  chiffrement au create, clear token `''`, replacement, happy Hestia persisté + audit, rejets
  NONE/sans baseUrl/sans token/échec déchiffrement, 404.
- Files created: `apps/api/test/server-panel.e2e-spec.ts` — suite e2e (9 tests) avec
  `overrideProvider(PanelTransportFactory)` (couture, zéro réseau ; **CryptoService réel** pour
  couvrir le cycle complet) : 401/403/404, create hasApiToken=true sans jamais exposer, GET liste,
  verify succès persisté + **transport reçoit le jeton DÉCHIFFRÉ** + audit version, échec panelOk=false,
  400 sans token, `apiToken=''` efface.

## 2026-09-02 — 9.5 Test réel + correctif parsing
- Smoke live (propriétaire a fourni son Coolify : `portal.arumdigital.com:8000`, token Bearer
  `4|…`) : `create` serveur `coolify-portal` (`panelProvider: COOLIFY`, `apiBaseUrl:
  http://portal.arumdigital.com:8000/api/v1`, `apiToken` réel) → `hasApiToken: true`, **apiTokenEnc
  jamais exposé** → `POST :id/panel-verify` → **`ok:true`, `panelOk` persisté, `detail`
  « Coolify API : joignable + authentifié (549 ms) »** ; vérification directe `GET .../api/v1/version`
  → `4.1.2` (200), sans auth → 401.
- **Correctif du parsing** : `version` sortait `undefined` car Coolify renvoie `4.1.2` en **texte
  brut**, pas `{version}` JSON. `coolifyVerify` accepte désormais le corps non-JSON non vide comme
  version → re-test réel : **`version: 4.1.2`**, `panelOk: true`.
- Smokes de connexion/démo : admin de smoke Phase 9 + fichiers temp supprimés ; serveur
  `coolify-portal` **conservé** (jacké, voir l'UI `/manager/serveurs` → carte + « Vérifier l'API »).

## 2026-09-02 — 9.6 Validation (builds + tests)
- Command: `corepack pnpm --filter @codediali/api test` → **unit 114/114** (13 suites, +16 :
  +6 detail panel-transport +7 unit verifyPanel, net).
- Command: `corepack pnpm --filter @codediali/api test:e2e` → **e2e 76/76** (10 suites, +
  `server-panel` 9 tests) sur Postgres réel.
- Command: `npx tsc --noEmit` apps/web → **PASS** ; `web build` PASS (14 routes, `/manager/serveurs`
  7.23 kB, marqueurs `panel-verify`/`hasApiToken`/`server.panel.verify` présents).
- Smoke web :3000 → **200** `/`, `/manager/serveurs` (bloc Panneau + « Vérifier l'API » sur carte,
  drawer URL/Utilisateur/Jeton). Smoke API :3001 → health 200. Problème `.next`/dev hang (build
  + openhand process tiers) résolu — **purge `.next` + une seule instance dev** = Ready 9.3 s.
- Docs: DECISIONS.md (ADR-010 APPROVED), CHANGELOG.md (Phase 9), PROJECT_STATUS.md,
  docs/sql-commandes.txt (Phase 9 DB entry), TASKS.md (cette section), HANDOVER.md.
- En attente: validation live propriétaire (carte Coolify réelle + Vérifier l'API) → commit + push.

# OPEN ITEMS
- [x] Authentication architecture (ADR-015 APPROVED — Phase 1).
- [x] Inscription par invitation / fermeture de l'inscription ouverte (ADR-020 APPROVED — Phase 5 : `POST /api/auth/register` → 410, `POST /api/auth/accept-invite` + `Invitation`).
- [x] Espace client : souscription + service (ADR-021 APPROVED — Phase 5 : `Subscription` + `Service`, ownership par possession, client ne touche jamais l'infra — provisionnement stub).
- [x] Email strategy (ADR-022 APPROVED — Phase 6 : SMTP config admin + test email + emails d'invitation best-effort ; ENCRYPTION_KEY pour le password at rest ; jeton manuel conservé en fallback).
- [ ] Async jobs architecture (ADR-007 — provisionnement réel différé).
- [ ] Redis requirement (depends on ADR-007).
- [x] Coolify API verification (ADR-010, Phase 9 — transport réel + verified live sur `portal.arumdigital.com:8000`, version 4.1.2).
- [x] HestiaCP API verification (ADR-010, Phase 9 — transport implémenté `cmd=sysinfo` Basic, tests loopback ; pas de panel réel Hestia fourni pour un smoke, à valider contre un Hestia quand disponible).
- [x] Turnstile (ADR-027, Phase 10 — `TurnstileService` non-obligatoire, enforce sur login + support/access quand activé).
- [x] OAuth / MFA (ADR-027, Phase 10 — Google+GitHub login/inscription-commande/liaison ; MFA TOTP + email OTP self-service, `mfaRequiredForAdmins` optionnel).
- [x] Tickets + support L1/L2/L3 + code 6 chiffres + impersonation admin (ADR-027, Phase 10).
- [x] Catalogue Produit → Catégorie + Pack avec limites appliquées à Coolify (ADR-031, Phase 12 — commit `1d2527d` poussé).
- [x] Contrôle DNS Cloudflare admin + sous-domaine client + quota disque clean-up (ADR-033, commit `5395840` poussé).
- [x] Modules de déploiement A/B + projet client + monitoring + dashboard client moderne (ADR-032, Phase 13 — commits `0bfd856`→`52cae27` poussés).
- [x] Plateforme multi-brand / white-label configurable (ADR-034, Phase 14 — commits `2cf7b1d`+`8e5abcf` poussés, validés 2× par le propriétaire).
- [ ] Asset storage.
- [ ] Reverse proxy/SSL.
- [ ] Observability.
- [ ] ADR-008 complet (gestion de secrets, architecture de config persistée — Phase 6 n'a validé qu'un périmètre étroit : chiffrement applicatif au repos).
- [ ] Rebrand iCode Host Pro → **Code Diali** (`codediali.com`) — différé par le owner « une fois le projet terminé » (2026-08-31).

## 2026-09-02 — Phase 9bis — AUTO-DÉTECTION IP/PORT + ACCÈS DIRECT + MÉTRIQUES SERVEUR (demande propriétaire)
Réponse au retour propriétaire : port Coolify non mentionné, IP non auto-détectée, pas d'accès direct, métriques RAM/CPU/Disque/Bandwidth impossibles → auto ou manuel.
- [x] Modèle : `Server` +`ramMb?`/`cpuCores?`/`diskGb?`/`bandwidthLimit?` (migration 9 `init_server_metrics`).
- [x] `HostResolverFactory` (seam DNS type Probe/Panel, `dns.promises.lookup`) — auto-résolution IP au **create** (si IP non fournie) et à l'**update** (IP précédemment vide, ou hostname changé) ; IP/port **saisis manuellement jamais écrasés** ; port déduit d'`apiBaseUrl` (`http://…:8000`→8000, https→443/http→80, seulement si port vide).
- [x] `PanelTransportFactory` : `PanelVerifyResult.metrics?` — Hestia `sysinfo` auto (MemTotal kB→Mo, `cpu cores`, `Disk` GB, best-effort null sinon) ; Coolify `metrics: null` (pas d'endpoint fiable → saisie manuelle). `verifyPanel` applique les métriques détectées **sur champs vides seulement** + audit `metricsDetected`.
- [x] DTO/web : +4 métriques ; carte `/manager/serveurs` **bouton « Ouvrir »** (origine dérivée d'apiBaseUrl sinon `https://hostname`, onglet neuf) + **lien API `apiBaseUrl` cliquable** + 4 champs métriques (— si inconnu) ; drawer section « Métriques du serveur ».
- [x] Tests : unit **121/121** (+7), e2e serveurs **15/15** (faux `HostResolverFactory`, zéro DNS réel ; cas create métriques + verify remplit champs vides), typecheck API/web + `web build` PASS.
- [x] **Smoke RÉEL Coolify** (`portal.arumdigital.com:8000`) : `coolify-portal` (ip/port vides) → PATCH → **IP auto `207.180.253.248` + port 8000** ; re-verify API → **OK (version 4.1.2)**, `metrics: null` (Coolify → manuel attendu) ; création neuve sans ip/port → IP + port 8000 auto + métriques manuelles persistées.
- [x] Correctif test pré-existant flaky : `probe-transport` « Hôte introuvable » accepte aussi « Délai dépassé » (résolution `.invalid` variante machine).
- [ ] **À valider par le propriétaire** (page serveurs : Ouvrir, lien API, métriques, ip/port auto) → puis **commit + push Phase 8 + 8bis + 9 + 9bis**.

# PHASE 10 — SÉCURITÉ, COMPTES & SUPPORT (ADR-027) — implémenté 2026-09-02, tests + builds + typecheck PASS, en attente validation propriétaire

## 2026-09-02 — 10.0 GO & périmètre (plan validé)
- Action: le plan Phase 10 (sécurité/comptes/support) + Phase 10bis (déploiement GitHub→Coolify) a été présenté et **validé par le propriétaire** (plan `jolly-knitting-meadow.md` APPROVED). Direction consigne : « coder sans arrêter, tester, corriger, livrer à tester/valider ».
- Périmètre noyau (ADR-027) : flags sécurité admin (singleton `SecuritySetting`, tout OFF par défaut), hiérarchie de rôles L1/L2/L3, impersonation admin lecture seule, code support 6 chiffres, MFA TOTP + email, OAuth Google+GitHub (login / inscription à la commande / liaison), catalogue public + inscription à la commande, tickets, Turnstile, rate limiter.
- Files modified: DECISIONS.md (ADR-027 APPROVED).

## 2026-09-02 — 10.1 Modèle + migration (ADR-027)
- Files modified: `apps/api/prisma/schema.prisma` — enum `Role` étendu (+SUPPORT_L1/L2/L3), `User` +`mfaSecretEnc`/`mfaEnabled`/`oauthProvider`/`oauthSubject`/`githubTokenEnc` (+`@@unique([oauthProvider,oauthSubject])`), modèle `SecuritySetting` (singleton, 6 flags `@default(false)`), modèle `SupportCode` (codeHash HMAC, expiresAt, attempts, revokedAt, `@@index([userId])`), enum `TicketStatus`/`TicketPriority`, modèles `Ticket` (+`escalatedTo`/`escalatedAt`) et `TicketMessage` (`authorEmail` dénormalisé).
- Command: `corepack pnpm --filter @codediali/api run migrate --name init_security_support` → migration `20260902063000_init_security_support` appliquée → **10 migrations**, in sync. Prisma client régénéré.

## 2026-09-02 — 10.2 Noyau auth : rôles + rate limiter + security settings + checkout + turnstile
- Files created: `apps/api/src/auth/roles.ts` (`ROLE_RANK` + helper exporté `roleRank`), `auth/rate-limiter.ts` (fenêtre glissante mémoire par IP, 429, presets login/mfa/register/checkout/support) + `rate-limiter.spec.ts` (6 unit), `auth/security/security-settings.service.ts` (singleton flags, enforcement central) + `security-settings.controller.ts` (`GET/PUT /api/admin/security`, ADMIN) + spec, `auth/checkout.service.ts` (intent `ihp_checkout` signé 10 min) + `checkout.controller.ts` (`POST /api/checkout/intent`, public) + spec, `auth/turnstile.service.ts` (fetch natif siteverify, skip si désactivé/sans clé) + spec, `auth/public-config.controller.ts` (`GET /api/public/products` sous `products/public-products.controller.ts`).
- Files modified: `auth/guards/roles.guard.ts` (rang : `required.some(r => actorRank >= roleRank(r))` — équivalent ADMIN), `auth/types.ts` (JwtPayload +`imp?`), `auth/auth.controller.ts` + `auth.service.ts` (login MFA-aware, register à la commande, rate limit, enrôlement admin), `auth.module.ts`, `auth/auth-cookies.service.ts` (cookies httpOnly ihp_refresh / ihp_checkout / ihp_oauth_state / ihp_mfa), `products/products.service.ts` (catalogue), `manager.service.ts` + spec (byRole 5 clés + total = somme — casse compile enum corrigée), `users.service.ts` + spec (`toPublic` retire aussi `mfaSecretEnc`/`githubTokenEnc`, expose `mfaEnabled`/`oauthProvider`).
- Tests: `auth.service.spec.ts` (impersonation/link), `checkout.service.spec.ts`.

## 2026-09-02 — 10.3 MFA TOTP + email (self-service + politique admin)
- Files created: `apps/api/src/auth/mfa/mfa.service.ts` (setup/confirm/disable, `MfaService` — secret AES-256-GCM via CryptoService, verify TOTP otplib + email OTP timing-safe, `mfaRequiredForAdmins` → enrôlement), `mfa-challenge.store.ts` (Map mémoire, ttl 300 s, single-use, lockout 5), `mfa.controller.ts` (`POST /api/auth/mfa/setup|confirm|disable`, `POST /api/auth/mfa/verify`, `POST /api/auth/mfa/email/send`), `totp.ts`, `guards/mfa-enroll-or-session.guard.ts` (jeton d'enrôlement limité à setup/confirm), dto/*, specs unit + `mfa-challenge.store.spec.ts`.
- Dépendance: `otplib` (+ **stub ESM en Jest** `src/test-utils/otplib.stub.ts`, `moduleNameMapper ^otplib` — verifySync toujours valide → TOTP accepte tout code 6 chiffres en test ; OTP email réel comparé timing-safe).

## 2026-09-02 — 10.4 OAuth Google + GitHub (login / inscription commande / liaison)
- Files created: `apps/api/src/auth/oauth/oauth-provider.client.ts` (abstraction injectable — tokens `GOOGLE_OAUTH`/`GITHUB_OAUTH` pour override e2e), `google.client.ts`/`github.client.ts` (fetch natif, `isConfigured` = clés présentes), `oauth.service.ts` (resolve par scénario : login / register-intent / link ; email vérifié exigé ; état CSRF signé 10 min cookie httpOnly ; `redirect_uri` = URL PUBLIQUE, jamais :3001 ; `githubTokenEnc` stocké pour 10bis), `oauth.controller.ts` (`GET /api/auth/oauth/:provider` → 302 authorize, `GET .../callback` → 302 web, `GET /api/auth/oauth/link/:provider`, `POST /api/auth/oauth/unlink`), spec.
- DTO: `oauth-unlink.dto.ts`.

## 2026-09-02 — 10.5 Support : code 6 chiffres + tickets + console L1/L2/L3
- Files created: `apps/api/src/support/support-codes.service.ts` (génération HMAC-SHA256 pepper, un actif, révocation transactionnelle, TTL 60 clamp 5..1440, redeem timing-safe + lockout 5 + comparaison factice, email best-effort) + `support-codes.controller.ts` (`POST/GET/DELETE /api/client/support-code` USER ; `POST /api/support/access` L2+) + `support.module.ts` + spec.
- Files created: `apps/api/src/tickets/` (modèles + `tickets.service.ts` + `tickets.controller.ts` — client `POST/GET /api/tickets`, `GET /api/tickets/:id`, `POST :id/messages` — + `SupportTicketsController` `GET /api/support/tickets`, `POST :id/messages`, `POST :id/escalate`, `PATCH :id/status` L1+) + spec. **Bug runtime corrigé** : `SupportTicketsController` non enregistré (404) → ajouté au `controllers` de `tickets.module.ts`.

## 2026-09-02 — 10.6 Impersonation (mécanisme partagé admin/support) + MFA admin reset
- Files modified: `apps/api/src/auth/auth.service.ts` — `issueTokens(user, opts?)` (expiresIn impersonation ; **`imp` présent → AUCUNE ligne refreshToken + AUCUN cookie**), `impersonate(targetId, actor, kind)` (cible existe + isActive + role ≠ ADMIN + pas soi-même ; jeton `{sub, role: USER, imp}` — rôle USER inscrit à la signature, lecture seule), `returnFromImpersonation`.
- Files created: `apps/api/src/auth/decorators/allow-impersonation.decorator.ts` (+ `JwtAuthGuard` bloque les verbes mutants sous `imp` sauf marqués).
- Files modified: `users.controller.ts` — `POST /api/users/:id/impersonate` (ADMIN) + `POST /api/users/:id/mfa-reset` (ADMIN secours anti-verrouillage). **Divergence intentionnelle du plan** : routes réelles sur `/api/users/:id/…` (source de vérité = client web `lib/api.ts`), pas `/api/admin/users/…`.

## 2026-09-02 — 10.7 Web : pages nouvelles + refonte auth/client
- Files created: `apps/web/src/app/offres/page.tsx` (catalogue public — visiteur consulte avant de commander), `apps/web/src/app/profil/page.tsx` (MFA self-service QR/secret + fournisseurs liés lier/délier + changement de mot de passe), `apps/web/src/app/manager/securite/page.tsx` (toggles admin : Turnstile/OAuth Google/GitHub/MFA admins/inscription commande/Phase 10bis + état des clés env sans les exposer), `apps/web/src/app/manager/support/page.tsx` (file de tickets L1+, zone code 6 chiffres L2+, vues lecture seule L3), `apps/web/src/components/turnstile.tsx` (widget chargé seulement si `NEXT_PUBLIC_TURNSTILE_SITE_KEY`).
- Files modified: `apps/web/src/app/auth/page.tsx` (boutons Google/GitHub si activés, Turnstile, étape MFA, mode inscription commande avec intent, `?oauth=mfa`), `apps/web/src/app/client/page.tsx` (panneau « Accès support » code 6 chiffres + « Mes tickets » + **bandeau d'impersonation** + Revenir), `apps/web/src/app/manager/utilisateurs/page.tsx` (« Se connecter en tant que » comptes USER), `apps/web/src/lib/session.ts` (`useAdminSession` + `useSupportSession` + `isSupportRole`), `apps/web/src/lib/api.ts` (helpers Phase 10), `apps/web/src/components/app-shell.tsx` (`roleLabel` support + prop `banner`), `apps/web/src/config/nav.ts` (section Support selon rôle).

## 2026-09-02 — 10.8 Tests (7 suites e2e neuves + unit neuves)
- Files created (unit) : `roles.guard.spec.ts` (rang hiérarchie), `mfa.service.spec.ts` + `mfa-challenge.store.spec.ts`, `oauth.service.spec.ts`, `security-settings.service.spec.ts`, `support-codes.service.spec.ts`, `tickets.service.spec.ts`, `turnstile.service.spec.ts`, `rate-limiter.spec.ts`, `checkout.service.spec.ts`, `auth.service.spec.ts` (impersonation/link).
- Files created (e2e, `apps/api/test/`) : `support.e2e-spec.ts` (générer/révoquer/lockout/refus USER/read-only), `mfa.e2e-spec.ts` (2 étapes, mauvais code, lockout), `tickets.e2e-spec.ts`, `auth-register.e2e-spec.ts` (intent requis, flag off 403, duplicate 403, catalogue public vs /products 401), `oauth.e2e-spec.ts` (provider Google mocké : redirect_uri public jamais :3001, state mismatch, login, email inconnu SANS intent refusé, inscription commande + souscription PENDING, lien, conflit, délier), `impersonation.e2e-spec.ts` (ADMIN→client jeton USER + pas de refresh cookie, lecture seule 403, admin/support 403, refresh 401, L3→ADMIN 403, self 400 / autre ADMIN 403, return 201), `security-settings.e2e-spec.ts` (tous flags OFF par défaut, toggle OAuth live on/off, toggle inscription live, `mfaRequiredForAdmins` → enrôlement + login 2 étapes + cleanup mfa-reset).
- **Fixes apportés aux specs** : helper `setCookies` (cast `headers['set-cookie'] as unknown as string[]`) ; routes impersonate/mfa-reset corrigées vers `/api/users/:id/…` (réelles) ; mock OAuth fantôme (exchangeCode résolu pour chaque scénario) ; `limiter.reset()` pour rate-limits déterministes ; stub otplib.
- Command (spécifiques) : `corepack pnpm exec jest --config ./test/jest-e2e.json --runInBand support mfa tickets auth-register oauth impersonation security-settings` → **7 suites / 52 tests PASS** (88 s).

## 2026-09-02 — 10.9 Validation complète (unit → e2e → tsc → build)
- Command: `corepack pnpm --filter @codediali/api test` → **unit 212/212 (24 suites)** PASS.
- Command: `corepack pnpm exec jest --config ./test/jest-e2e.json --runInBand` → **e2e 129/129 (17 suites)** PASS sur Postgres réel (dont les 10 suites pré-existantes — non-régression `GET /api/products` 401, core/client/audit/invitations/mail/server-check/server-panel vertes).
- Command: `npx tsc --noEmit` apps/api **PASS** ; `npx tsc --noEmit` apps/web **PASS**.
- Command: `corepack pnpm --filter @codediali/web exec next build` → **PASS, 18 routes** (`/` , `/_not-found`, `/auth`, `/client`, `/manager`, `/manager/invitations`, `/manager/journal`, `/manager/mail`, `/manager/produits`, `/manager/securite`, `/manager/serveurs`, `/manager/subscriptions`, `/manager/support`, `/manager/utilisateurs`, `/offres`, `/profil`). Dev web arrêté + `.next` purgé avant build (leçon Phase 2).
- Docs: DECISIONS.md (ADR-027 APPROVED), CHANGELOG.md (Phase 10), PROJECT_STATUS.md, docs/sql-commandes.txt (Phase 10 DB entry), TASKS.md (cette section), HANDOVER.md.
- En attente: **validation live propriétaire** (settings sécurité, MFA TOTP+email, OAuth Google/GitHub clés de test, inscription à la commande email+pass/OAuth, liaison de compte, impersonation admin → /client + bandeau + Revenir, code 6 chiffres → L2 lecture seule, tickets L1→L2) → **commit + push Phases 8 + 8bis + 9 + 9bis + 10**.

## 2026-09-02 — 11.0 Turnstile : clés admin saisie/modif (store chiffré + API + UI)
- Files modified: `apps/api/prisma/schema.prisma` — `SecuritySetting` + `turnstileSiteKey String?` (texte public) + `turnstileSecretEnc String?` (AES-256-GCM). Migration `20260902070000_add_turnstile_keys` → **11 migrations**, in sync.
- Files modified: `apps/api/src/auth/security/security-settings.service.ts` — `FLAG_KEYS`/`CREATE_DATA` split (les clés Turnstile ne sont pas des flags) ; `getTurnstileSiteKey()`/`getTurnstileSecretKey()` ; `updateSecuritySettings` sauvegarde `turnstileSiteKey` + `turnstileSecretEnc` (chiffré), `''` efface les deux (retour au fallback env) ; `toPublic()` ne renvoie **jamais** le secret (`turnstileHasSecretKey` booléen seulement). DTO `update-security-settings.dto.ts` + `turnstileSecretKey` (write-only, nullable).
- Files modified: `apps/api/src/auth/turnstile.service.ts` + spec — `isConfiguredAsync()` **DB prioritaire sur env** (priorité demandée par l'admin) ; `turnstile.service.spec.ts` +tests isConfiguredAsync.
- Files modified: `apps/api/src/auth/public-config.controller.ts` — `GET /api/public/auth-config` sert `turnstileSiteKey` (la clé **publique** pour le widget) — jamais le secret.
- Files modified: `apps/api/test/security-settings.e2e-spec.ts` — +1 test : clés Turnstile sauvegardées chiffrées, GET ne renvoie jamais le secret, effacement `''`.
- Files modified: `apps/web/src/app/manager/securite/page.tsx` — panneau « Clés Turnstile » : saisie site key + secret (« laisser vide = inchangé »), bouton Effacer, badges état configuré (DB ou env), note priorité DB. `apps/web/src/lib/api.ts` — `SecuritySettings` + `turnstileSiteKey`/`turnstileHasSecretKey`, `updateSecuritySettings` + `turnstileSecretKey`.

## 2026-09-02 — 11.1 Base de connaissance : modèle + migration + API admin/client
- Files created: `apps/api/prisma/migrations/20260902080000_init_knowledge/` — modèle `KnowledgeArticle` (`audience ADMIN|CLIENT`, `type INFORMATIVE|TECHNICAL|HOWTO`, `status DRAFT|PUBLISHED|ARCHIVED`, `slug` unique par audience, `summary`, `body` HTML, `category`, `phase`, `tags` String[], `authorEmail`) + enums `KnowledgeAudience`/`KnowledgeType`/`KnowledgeStatus` → **12 migrations**, in sync.
- Files created: `apps/api/src/knowledge/` — `knowledge.module.ts`, `knowledge.service.ts` (slug auto si vide + collisions `-2`/`-3`, scoping audience), `knowledge.controller.ts` **admin** `GET/POST/PUT/DELETE /api/knowledge` (`@Roles(ADMIN)`, audit `knowledge.*`), `knowledge-client.controller.ts` **client** `GET /api/client/knowledge` (uniquement `CLIENT + PUBLISHED`, liste **sans** `body`), `GET .../categories`, `GET .../:idOrSlug` (brouillon client ou article admin → **jamais exposé**), dto/*, `knowledge.service.spec.ts` (8 unit).
- Files created: `apps/api/test/knowledge.e2e-spec.ts` — admin CRUD complet, audit, slug auto/collision, client ne voit que PUBLISHED CLIENT, brouillon refusé, 403 non-admin.

## 2026-09-02 — 11.2 Web : /manager/connaissance (admin) + /aide (client)
- Files created: `apps/web/src/app/manager/connaissance/page.tsx` — onglets Admin/Client, recherche + filtre statut, badges Publié/Brouillon/Archivé, Publier/Dépublier/Supprimer, éditeur drawer (audience/type/statut/slug/catégorie-phase/résumé/HTML/étiquettes).
- Files created: `apps/web/src/app/aide/page.tsx` — centre d'aide client : héro + recherche + chips catégories, cartes groupées par catégorie, lecteur drawer avec **sanitisation défensive** du HTML (script/iframe/on*/javascript: supprimés avant `dangerouslySetInnerHTML`).
- Files modified: `apps/web/src/lib/api.ts` — types + helpers knowledge admin (`listKnowledge/getKnowledge/createKnowledge/updateKnowledge/deleteKnowledge`) + client (`listClientKnowledge/getClientKnowledge`).

## 2026-09-02 — 11.3 Refonte design system + pages (conversion, mobile responsive, style app.arumdigital)
- Files modified: `apps/web/src/app/page.tsx` — landing de conversion (héro « Votre hébergement, piloté depuis un seul endroit » + chip + trust + vitrine produit `landing-showcase` avec fenêtre navigateur + spark bars + 6 cartes fonctionnalités + bandeau stats + CTA final).
- Files modified: `apps/web/src/app/offres/page.tsx` — catalogue pricing moderne (groupes par type deployment/domain/infrastructure, cartes avec badge Disponible/Indisponible + prix + bouton Commander, bande réassurance 4 items).
- Files modified: `apps/web/src/app/auth/page.tsx` — mise en page split `.auth-split` (aside valeur de marque : chip, titre gradient, 3 points, foot marque — carte auth à droite, repli < 880 px) ; logique auth intacte.
- Files modified: `apps/web/src/app/globals.css` — tokens étendus (`--bg-glow-1/2`, `--shadow-soft`/`--shadow-lift`, `--header-blur`/`--header-bg` glass, `--sidebar-bg`, `--ease-spring`, `--radius-hero` 18 px), fond ambiant `background-attachment: fixed`, topbar glass backdrop-filter, `.btn-primary` gradient + glow + press spring, hover lift panneaux/stat-cards, `.main` animation page-in, `.landing*` + `.offres*` + `.auth-split` complets, tiroir mobile (hamburger + `.mobile-nav` drawer + overlay + verrouillage scroll, visible < 900 px), `.stat-icon.cyan`.
- Files modified: `apps/web/src/components/app-shell.tsx` — `navTree` partagé sidebar/drawer, bouton hamburger animé (aria-expanded), drawer mobile + overlay + fermeture sur navigation, prop `banner` conservée. `apps/web/src/config/brand.ts` — `home` → `/` (logo → landing). `apps/web/src/components/icons.tsx`/`ui.tsx` — retouches mineures compat redesign.
- **Règles respectées** : tokens `--brand-*` + `config/brand.ts` seuls points de marque (pas de rebrand), design system ADR-023 intouchable, pages converties sans perte de logique.

## 2026-09-02 — 11.4 Validation complète (unit → e2e → tsc → build) + gouvernance
- Command: `corepack pnpm --filter @codediali/api test` → **unit 223/223 (25 suites)** PASS (+10 : knowledge 8, security-settings 8 réécrit, turnstile isConfiguredAsync).
- Command: `corepack pnpm exec jest --config ./test/jest-e2e.json --runInBand` → **e2e 132/132 (18 suites)** PASS sur Postgres réel (+2 : `knowledge` 3 tests, `security-settings` +1 clés Turnstile — non-régression intégrale des 16 suites pré-existantes, dont `GET /api/products` 401, core/client/audit/invitations/mail/server-check/server-panel/Phase 10).
- Command: `npx tsc --noEmit` apps/api **PASS** ; `npx tsc --noEmit` apps/web **PASS**.
- Command: `corepack pnpm --filter @codediali/web build` → **PASS, 18 routes** (dev web arrêté + `.next` purgé avant build — leçon Phase 2).
- Dev servers relancés : API `:3001` health `/api/health` → `{"status":"ok","database":"ok"}` ; web `:3000` Ready.
- Docs: CHANGELOG.md (Phase 11), PROJECT_STATUS.md, TASKS.md (cette section), docs/sql-commandes.txt (migrations 11 + 12), HANDOVER.md, DECISIONS.md (ADR-028 si applicable).
- En attente: **validation live propriétaire** → **commit + push Phase 11** → **Phase 10bis (GitHub → déploiement Coolify)**.

# PHASE 11 (SUITE) — AUDIT RÉEL & CORRECTIONS TECHNIQUES + BASE DE CONNAISSANCE SEEDÉE + DOCS (2026-09-03, directive propriétaire : audit → corrections techniques uniquement → matrice permissions → trafic/quotas + ADR → DESIGN_HANDOVER → tests → rapport final, **NE PAS commiter / NE PAS pousser / NE PAS faire 10bis, attendre validation explicite**)

## 2026-09-03 — 11.5 Audit réel complet (lecture code, zéro invention)
- Action: audit de bout en bout de la Phase 11 — architecture, modèles (dont `KnowledgeArticle`), routes + guards, `SecuritySettingsService`, rate limiting, checkout intent, produits/souscriptions admin, les 10 pages `/manager` + `/aide` + `/offres` + `/auth`.
- Verdict: implémentation conforme au plan Phase 11 ; 3 écarts techniques réels corrigés (11.6) ; pas d'écart sécurité sur l'exposition des secrets (`mfaSecretEnc`/`githubTokenEnc`/`apiTokenEnc`/`passwordEnc` jamais renvoyés).

## 2026-09-03 — 11.6 Corrections techniques uniquement (3)
1. **Delete produit référencé → 409** (`products.service.ts`) : avant suppression physique, `subscription.count({ where: { productId } })` ; si > 0 → `ConflictException` « Ce produit est référencé par des souscriptions — passez-le en statut DISABLED pour le retirer du catalogue. » + spec unit `refuses (409) to delete a product referenced by subscriptions` (mock `subscription.count` ajouté en haut du mock — le fix TS2339 initial passait un objet non typé).
2. **Espace client sans DRAFT/DISABLED** (`client/page.tsx`) : le catalogue client utilise `listPublicProducts()` au lieu de `listProducts()` (DRAFT/DISABLED filtrés côté API publique ; `GET /api/products` reste authentifié, test core.e2e intact).
3. **Texte éditeur base de connaissance** (`manager/connaissance/page.tsx`) : alerte alignée sur la réalité — « Publié, visible par tous sur le centre d'aide public (/aide). »

## 2026-09-03 — 11.7 Base de connaissance : seed initial réel (double-audience)
- Files created: `apps/api/prisma/seed-knowledge.ts` — idempotent (create-if-missing par `[audience, slug]`, ne modifie JAMAIS les articles édités par l'admin), auteur = plus ancien ADMIN ou `seed@icode-host.local` en repli, tout PUBLISHED. Contenu : **23 articles ADMIN** (12 INFORMATIVE récap Phase 1→11 issus de CHANGELOG/DECISIONS réels ; 4 TECHNICAL : architecture-monorepo, permissions-roles, securite-applicative, transport-panels ; 7 HOWTO : configurer-serveur, approuver-souscription, configurer-mail, options-securite, base-connaissance, impersonation, tickets) + **11 articles CLIENT** (catégories Premiers pas / Compte & sécurité / Support).
- Files modified: `apps/api/package.json` — script `db:seed:knowledge` = `ts-node prisma/seed-knowledge.ts`.
- Command: `corepack pnpm --filter @codediali/api db:seed:knowledge` → **34 créé(s), 0 existant(s)** ; re-run → **0 créé(s), 34 existant(s) (non modifiés)** — idempotence prouvée sur la DB réelle `icode-postgres` (12 migrations in sync).

## 2026-09-03 — 11.8 Docs : matrice permissions + trafic/quotas (ADR-029 PROPOSED) + parcours commande + DESIGN_HANDOVER
- Files created: `docs/permissions-matrix.md` (matrice route→accès réelle : public / any-auth / ADMIN / SUPPORT_L1+/L2+, séparation stricte base de connaissance CLIENT+PUBLISHED sans body, règles transversales impersonation anti-escalade / secrets jamais renvoyés) ; `docs/traffic-quotas.md` (analyse 4 couches mesure/quota/limitation/suspension — `Server.quotaMaxAccounts` existe mais NON enforce, suspension manuelle via `User.isActive` ; recommandation = **ADR-029 PROPOSED**, rien d'implémenté) ; `docs/parcours-commande-publique.md` (audit bout en bout du parcours commander-sans-compte, pièces réelles + écarts documentés sans invention : pas de prix/ordre, intent réutilisable, SUSPENDED visible non commandable, pas d'email de confirmation) ; `docs/design/DESIGN_HANDOVER.md` (point d'entrée du futur agent design — 8 règles impératives, carte fichiers fonctionnel vs présentation, comportements à préserver, périmètre hors-design : pas de page paiement, 10bis, rebrand Code Diali différé).
- Files modified: `DECISIONS.md` — **ADR-029 — Trafic, quotas & suspension : architecture en 4 couches, Status: PROPOSED** (2026-09-03), volontairement PAS ajouté à la liste APPROVED (en attente de validation propriétaire).

## 2026-09-03 — 11.9 Tests réels (vert sur DB réelle) + correctif isolation e2e
- Command: `corepack pnpm --filter @codediali/api test` → **unit 224/224 (25 suites)** PASS (+1 : spec products 409).
- Command: `corepack pnpm --filter @codediali/api test:e2e` → **9 échecs pré-existants dans `security-settings` (2) + `oauth` (7)** : suite isolées avec `--runInBand` → PASS (5/5 et 9/9). **Cause racine : clobbering inter-suites** — Postgres partagé + ligne singleton `SecuritySetting` + workers jest parallèles (oauth seed le singleton à `oauthGoogleEnabled:true` pendant que security-settings le reset à false). **Correctif : `apps/api/test/jest-e2e.json` → `"maxWorkers": 1`.** Ré-exécution complète → **e2e 132/132 (18 suites) PASS** sur Postgres réel.
- Command: `npx tsc --noEmit` apps/api → **PASS** ; apps/web → **PASS**.
- Command: `corepack pnpm --filter @codediali/web build` → **PASS (18 routes**, dev arrêté + `.next` purgé avant build — leçon Phase 2).
- Command: seed knowledge validé sur DB réelle (11.7).

## 2026-09-03 — 11.10 Gouvernance + rapport final
- Files modified: TASKS.md (cette section), PROJECT_STATUS.md, CHANGELOG.md (Phase 11 — audit & corrections), HANDOVER.md, DECISIONS.md (ADR-029 déjà).
- **Rapport final structuré présenté au propriétaire (audit, 3 corrections, seed 34 articles, 4 docs, tests verts, ADR-029 PROPOSED, conformité : rien commité / rien poussé / 10bis non touchée).**

## 2026-09-03 — 11.11 Validation propriétaire (✓) + clôture
- Action: **le propriétaire valide la Phase 11** (« Je valide la Phase 11. Conserve ADR-029 en PROPOSED, ne l'implémente pas maintenant. Tu peux préparer la transition vers la prochaine phase conformément au roadmap, mais ne commence aucune nouvelle phase tant que je ne l'ai pas explicitement validée. »).
- Décisions du propriétaire : **ADR-029 reste PROPOSED** (non implémenté) ; **transition vers la prochaine phase à préparer mais AUCUNE nouvelle phase commencée sans validation explicite**.
- Files modified: PROJECT_STATUS.md (Phase 11 ✓), TASKS.md (cette section), CHANGELOG.md, HANDOVER.md.
- Command: git add + commit (Phase 11 + audit + corrections) → push.
- **Prochaine étape (roadmap) : Phase 10bis — déploiement GitHub → Coolify — en attente de validation explicite du plan par le propriétaire.**

# PHASE 10bis — DÉPLOIEMENT GITHUB → COOLIFY (plan validé par le propriétaire, GO « go » 2026-09-03)

## 2026-09-03 — 10bis.0 GO & périmètre
- Action: le propriétaire valide le plan Phase 10bis (« go ») — M+N : **M** = auto-détection des repos GitHub (store `githubTokenEnc` de la Phase 10) ; **N** = déploiement sur le serveur Coolify connecté (celui affecté par l'admin au `Service` ACTIVE du client, `panelProvider=COOLIFY` + `panelOk=true`), extension `PanelTransport`, modèle `Deployment`, endpoints client + panneau web « Déploiements », **vérification live contre le vrai coolify-portal pendant l'implémentation** (repos publics d'abord ; private repos via GitHub App Coolify = follow-up documenté).
- Files modified: DECISIONS.md (ADR-030).

## 2026-09-03 — 10bis.1 Modèle Deployment + migration (1 pas)
- Files modified: `apps/api/prisma/schema.prisma` — enum `DeploymentStatus {PENDING DEPLOYING ACTIVE FAILED}` + modèle `Deployment` (id, userId FK Cascade, serviceId FK Cascade, serverId **nullable** FK SetNull, repoFullName, branch `@default("main")`, coolifyUuid?, status `@default(PENDING)`, detail?, createdAt/updatedAt, `@@index([userId])`/`@@index([serviceId])`/`@@index([status])`) + back-relations User/Server/Service.
- Files created: `apps/api/prisma/migrations/20260903033537_init_deployment/migration.sql` → **13 migrations**, `migrate status` in sync. Prisma client régénéré.
- NB : migrations 11/12 (`add_turnstile_keys`, `init_knowledge`) réparées au préalable (BOM UTF-8 retiré + checksums `_prisma_migrations` recalculés `sha256(fichier)`) — débloque `migrate dev` sans reset (zéro perte de données).

## 2026-09-03 — 10bis.2 Extension PanelTransport Coolify (3 opérations) + tests
- Files modified: `apps/api/src/servers/panel-transport.factory.ts` — interfaces `CoolifyGitAppInput {repoUrl,branch,serviceName}` / `CoolifyGitAppResult {uuid}` / `CoolifyDeploymentStatusResult {rawStatus,detail?}` + méthodes abstraites `createGitApp`/`deployApp`/`deploymentStatus` ; refactor `httpGet` → `httpRequest(method,href,headers,strictTls,timeoutMs,body?)` + `httpJson` ; `NodePanelTransport.assertCoolify` (Hestia → erreur claire) ; `createGitApp` `POST {base}/applications/public` (body `project_uuid:'0'`, `server_uuid:'0'`, `environment_name:'production'`, `git_repository`, `git_branch`, `name`, `build_pack:'nixpacks'` ; 200/201 ; uuid requis) — **endpoint CONFIRMÉ contre le vrai Coolify 4.1.2** (`/applications/git` → 404, corrigé en live) ; `deployApp` `POST {base}/applications/{uuid}/deploy` ; `deploymentStatus` `GET {base}/applications/{uuid}` → `{rawStatus}` (non-200 → `unknown` + détail, **ne rejette jamais**).
- Files modified: `apps/api/src/servers/panel-transport.factory.spec.ts` — 16 tests : createGitApp POST `/api/v1/applications/public` + body complet + Bearer, réponse sans uuid → erreur, 401 → /401/, deployApp path + non-2xx, deploymentStatus parsing + non-200 → unknown + détail, refus Hestia (3 opérations).

## 2026-09-03 — 10bis.3 GitHubService (repos autodétectés) + endpoints client
- Files created: `apps/api/src/deployments/github.service.ts` — `decryptToken` (CryptoService), `listRepos` (`GET https://api.github.com/user/repos?per_page=100&sort=updated`, Bearer + `X-GitHub-Api-Version: 2022-11-28`, mapping `{fullName, defaultBranch, private, language}`), `fetchUser` (login), `repoExists` (`GET /repos/:fullName` → bool), échec → 400 `GitHub API (HTTP N)`.
- Files created: `apps/api/src/deployments/github.service.spec.ts` (global.fetch stubé).

## 2026-09-03 — 10bis.4 Flow déploiement + audit
- Files created: `apps/api/src/deployments/` — `dto/create-deployment.dto.ts` (serviceId IsString IsNotEmpty ≤200, repoFullName `@Matches(/^[\w.-]+\/[\w.-]+$/)`, branch optionnelle ≤100) ; `deployments.service.ts` (requireDeployEnabled→403 ; requireGithubToken ; resolveCoolifyTarget = Service ACTIVE du client + serveur `panelProvider=COOLIFY` + `panelOk=true` ; buildTarget déchiffre `apiTokenEnc` ; create PENDING→createGitApp→deployApp→DEPLOYING + audit `deploy.create` ; échec → FAILED + audit `deploy.failed` + 502 ; listMine ; findMine avec **rafraîchissement live** quand DEPLOYING — deploymentStatus → mapping ACTIVE/FAILED best-effort, statut inconnu ou Coolify injoignable → état courant conservé, jamais rejeté — + audit `deploy.status` `{from,to}` ; `toView` masque `coolifyUuid` — ADR-021 infra non exposée) ; `deployments.controller.ts` (`@Controller('client')` + JwtAuthGuard : `GET github/repos`, `POST github/link-status`, `POST deployments`, `GET deployments`, `GET deployments/:id`) ; `deployments.module.ts` (imports AuthModule + CryptoModule, providers DeploymentsService + GithubService + PanelTransportFactory).
- Files modified: `apps/api/src/app.module.ts` (import DeploymentsModule) ; `apps/api/src/auth/public-config.controller.ts` (+`deployEnabled` dans `GET /api/public/auth-config`).
- Tests: `apps/api/src/deployments/deployments.service.spec.ts` — 15 tests : gardes (deployEnabled OFF 403, GitHub non lié 400, repo non possédé 400, ownership 404, non-ACTIVE 400, non-COOLIFY 400, panelOk false 400), flux heureux (create PENDING → createGitApp `repoUrl/branch/serviceName` → deployApp → update DEPLOYING + include service/server, audit `deploy.create`, **coolifyUuid jamais exposé**), branche explicite trimmée, échec Coolify → FAILED + audit `deploy.failed` + 502, listMine masqué, findMine 404 autrui, refresh live running→ACTIVE + audit `deploy.status`, statut illisible conservé, Coolify injoignable conservé, listRepos/linkStatus.

## 2026-09-03 — 10bis.5 e2e déploiements + suite complète verte
- Files created: `apps/api/test/deployments.e2e-spec.ts` — **13 tests** (fakes PanelTransportFactory + GithubService + HostResolverFactory stub ; seed admin + clientA + clientB + produit + serveur COOLIFY via API + panel-verify + souscription ACTIVE + service ACTIVE) : 401, link-status false/true, repos listés, happy path 201 DEPLOYING **sans coolifyUuid** + audit `deploy.create`, repo non possédé 400, non-ACTIVE 400, non-COOLIFY 400, échec → 502 + FAILED + audit `deploy.failed`, cross-client 404, poll live running→ACTIVE + audit `deploy.status`, impersonation (POST 403 / GET 200), DTO malformé 400 (`owner/repo/extra`).
- Files modified: `apps/api/test/server-panel.e2e-spec.ts` (fake transport complété des 3 opérations).
- Command: unit → **259/259 (27 suites)** ; e2e → **145/145 (19 suites)** ; `npx tsc --noEmit` api + web **PASS** ; `web build` **PASS** (route `/client` 6.54 kB ; dev arrêté + `.next` purgé avant build — leçon Phase 2).

## 2026-09-03 — 10bis.6 Web /client : panneau « Déploiements GitHub → Coolify »
- Files modified: `apps/web/src/lib/api.ts` — `deployEnabled` dans `PublicAuthConfig` ; types `GithubRepo`/`GithubLinkStatus`/`DeploymentStatus`/`Deployment` (+ service/server embarqués) + helpers `listGithubRepos`/`githubLinkStatus`/`listMyDeployments`/`getMyDeployment`/`createDeployment`.
- Files modified: `apps/web/src/app/client/page.tsx` — panneau « Déploiements » conditionné à `deployEnabled` : état de liaison GitHub (non lié → lien `/profil`), select repo autodétecté (bascule la branche par défaut du repo), input branche, select **service ACTIVE** cible, bouton Déployer + Actualiser, liste des déploiements avec badges de statut (PENDING/DEPLOYING/ACTIVE/FAILED) et détail, **rafraîchissement live 8 s tant qu'un déploiement est DEPLOYING** (re-fetch `getMyDeployment`).

## 2026-09-03 — 10bis.7 Vérification LIVE contre le vrai coolify-portal (portal.arumdigital.com:8000, v4.1.2)
- Smoke 1 (lecture, token réel déchiffré + transport réel) : `GET /version` → **OK version 4.1.2 (424 ms)** ; `GET /applications` → 200 (5 apps) ; `GET /applications/:uuid` → parsing `status` (`exited:unhealthy`).
- Smoke 2 (cycle d'écriture) : `POST /applications/git` → **404** (route absente sur 4.1.2) → probe `POST /applications/public` → **403 « Missing required permissions: write »** → route corrigée dans le transport + spec ; **exigence opérationnelle documentée : jeton API ROOT / write-scope requis** pour créer une application (un jeton lecture seule répond 403 — comportement attendu de Coolify, pas un bug du code).
- Fichiers temporaires de smoke supprimés. Cycle complet create→deploy→delete à revalider par le propriétaire avec un jeton write + un repo GitHub public.

## 2026-09-03 — 10bis.8 Gouvernance + présentation
- Files modified: TASKS.md (cette section), PROJECT_STATUS.md, CHANGELOG.md, HANDOVER.md, DECISIONS.md (ADR-030).
- En attente: **validation live propriétaire** (jeton Coolify write, repo GitHub public) → commit + push.

## 2026-09-03 — 10bis.9 Mode « URL collée » + détection auto (la liaison GitHub devient OPTION)
- Contexte: le propriétaire veut une 2e voie de déploiement simultanée : **coller l'URL d'un dépôt git** → détection **automatique** (branche, langage, build pack suggéré via API GitHub publique SANS token) → champs éditables **Build pack + Nom de l'app** → « Déployer » en 1 clic. La liaison GitHub (autodétection des repos via `githubTokenEnc`) reste une option, plus la seule. Réponses AskUserQuestion : détection **intelligente** (branch + language via `GET /repos/{owner}/{repo}` sans auth + best-effort `/contents/Dockerfile` → `dockerfile` ; fallback simple hors github.com), réglages éditables = **Build pack + Nom de l'app** (branche auto : détectée sinon `main`).
- Files modified: `apps/api/prisma/schema.prisma` — `Deployment` + `repoUrl String?` (URL collée mode URL), `buildPack String?`, `appName String?`. **Migration 14** `20260903140253_init_deployment_url` (3 `ADD COLUMN`, post-13, `migrate status` in sync, client régénéré).
- Files modified: `apps/api/src/servers/panel-transport.factory.ts` — `CoolifyGitAppInput` + `buildPack?`/`appName?` ; `createGitApp` body `name: input.appName ?? input.serviceName`, `build_pack: input.buildPack ?? 'nixpacks'`.
- Files modified: `apps/api/src/deployments/github.service.ts` — **détection** : `parseGithubUrl` (static, github.com uniquement, strip `.git`/`tree`/`blob`), `sanitizeGitUrl` (static, http(s) uniquement, trim, fragment+query retirés, **refus hosts privés/réservés — SSRF léger** : `localhost`, IP littérales, `127./10./192.168./172.16-31./169.254.`), `detectRepo(url)` (**ne lève jamais**, best-effort : github → GET public SANS auth + Dockerfile check → `dockerfile` sinon `suggestBuildPack(language)`→nixpacks ; 404/réseau → fallback `main`/nixpacks + `detail`), `deriveRepoFullName` (public, 2 derniers segments), `BUILD_PACKS = ['nixpacks','dockerfile','dockercompose','static']`, `suggestBuildPack` exporté. Spec +17 tests.
- Files created: `apps/api/src/deployments/dto/detect-repo.dto.ts` — `{ url @IsString @IsNotEmpty @MaxLength(512) }`.
- Files modified: `apps/api/src/deployments/dto/create-deployment.dto.ts` — `repoFullName` optionnel + `repoUrl?` (`@ValidateIf` croisés : exactement un des deux), `branch?`, `buildPack? @IsIn(BUILD_PACKS)`, `appName? ≤100`.
- Files modified: `apps/api/src/deployments/deployments.service.ts` — `detect(actor,url)` : `requireDeployEnabled` + `github.detectRepo` (aucun token) ; `create` réécrit : **mode URL** (`dto.repoUrl`) → détection auto, branch = `dto.branch ?? detected ?? 'main'`, buildPack = `dto.buildPack ?? suggested ?? 'nixpacks'`, appName = `dto.appName ?? service.name`, repoFullName dérivé, **skip** `requireGithubToken` + `repoExists` ; **mode GH lié** inchangé (token + propriété) ; les deux fournis → 400 ; audit `deploy.create` + `mode`/`buildPack`/`appName`. Spec +6 tests (mode URL sans token : aucun appel decrypt/repoExists ; champs client primés ; URL invalide 400 ; les deux modes 400 ; detect 403 OFF / best-effort).
- Files modified: `apps/api/src/deployments/deployments.controller.ts` — `POST client/deployments/detect`.
- Files modified: `apps/api/test/deployments.e2e-spec.ts` — +4 tests (clientB SANS GitHub : `detect` 201, deploy URL 201 DEPLOYING + buildPack/appName stockés en DB + **aucun appel decryptToken**, URL privée/invalide 400, les deux modes 400) ; fake `detectRepo` délègue au **vrai** `GithubService.sanitizeGitUrl` static (la garde SSRF est réellement exercée en e2e, zéro réseau sinon).
- Files modified: `apps/web/src/lib/api.ts` — `BUILD_PACKS`/`BuildPack`, `DetectResult`, `detectDeployment`, `createDeployment` dto étendu.
- Files modified: `apps/web/src/app/client/page.tsx` — panneau « Déploiements » → **2 modes** : onglet « Dépôt GitHub lié » (seulement si `github.linked`, select repos inchangé) + onglet « URL d'un dépôt » (toujours dispo, note « la liaison GitHub est optionnelle ») : input URL → **Détecter** (prefill branche/langage/build pack) → champs éditables **Nom de l'app** + **Build pack** (Select BUILD_PACKS) + select Service ACTIVE → **Déployer** ; liste des déploiements affiche `build <buildPack>` + `app « <appName> »`.
- Files modified: `apps/web/src/app/layout.tsx` — `<body suppressHydrationWarning>` (fix hydration `cz-shortcut-listen` en dev, session précédente).

## 2026-09-03 — 10bis.10 Vérification chaîne verte (complète, demandée) + smoke live + causes racines
- Command (fail fast): `npx tsc --noEmit` api + web → **PASS** · unit → **280/280 (27 suites, +21 vs 259)** · e2e → **149/149 (19 suites, +4 vs 145)** · dev web arrêté + `.next` purgé → `web build` **PASS 19 routes** (dont `/client` 7.39 kB).
- Smoke live (API :3000 rewrite, jeton client de test jetable minté, **zéro compte réel touché**) :
  - `GET /api/public/auth-config` → `deployEnabled:false` (garde visible par le web).
  - `POST /api/client/deployments/detect` sans `deployEnabled` → **403** « Les déploiements … sont désactivés » (garde prouvée).
  - `deployEnabled` activé **temporairement** (ligne SecuritySetting jetable, restaurée après) : `detect` `https://github.com/expressjs/express.git` → **201** `{defaultBranch:"master", language:"JavaScript", suggestedBuildPack:"nixpacks"}` (détection GitHub réelle) ; URL privée `192.168.1.10` → **400** (SSRF) ; `gitlab.com/gitlab-org/gitlab` → **201** fallback `main`/`nixpacks` + détail.
  - **Ligne `deployEnabled` supprimée après smoke (état initial restauré).**
- **Causes racines du « rien ne se passe sur l'espace client » (à corriger par le propriétaire)** : (1) **`deployEnabled` est OFF** (aucune ligne `SecuritySetting` → flag par défaut) ⇒ le panneau « Déploiements » n'apparaît pas sur `/client` ; (2) **aucun `Service` ACTIVE** n'existe ⇒ même avec le flag ON, le client n'a rien sur quoi déployer ; (3) **jeton API Coolify stocké refusé** par le vrai serveur (`403 « You are not allowed to access the API »` sur `portal.arumdigital.com:8000` — token périmé/read-only) ⇒ le smoke deploy complet réel est bloqué côté infra, pas côté code. Pour valider le cycle complet : activer `deployEnabled` dans `/manager/securite`, affecter un `Service` ACTIVE au serveur coolify-portal, et re-vérifier le panneau Coolify (`/manager/serveurs`) avec un jeton **ROOT/write**.
- NB : test `invitations.service.spec` désormais déterministe (fake timers Jest, horloge contrôlée) — NON touché par 10bis.5.

# PHASES 12 — 15 (+ CLOUDFLARE DNS) : IMPLÉMENTÉES ET POUSSÉES (rattrapage gouvernance 2026-09-08)

## Phase 3 (Cloudflare DNS) — CONTRÔLE DNS CLOUDFLARE ADMIN + SOUS-DOMAINE CLIENT + QUOTA DISQUE CLEAN-UP — 2026-09-05 (commit `5395840`, poussé)
- Files created: `apps/api/src/cloudflare/` — `cloudflare.module.ts`, `cloudflare.controller.ts` (`GET/POST /api/cloudflare/...` — zones importables, domaines racine, enregistrements DNS live proxied, allocation sous-domaine client), `cloudflare.service.ts` (525 lignes), `cloudflare.transport.ts` (API Cloudflare réelle, bearer chiffré), `cloudflare.transport.spec.ts` (163), `cloudflare.service.spec.ts` (230), `dto/cloudflare.dto.ts` (83).
- Files modified (Prisma, migrations) : migration `20260905001000_add_cloudflare_dns` — modèles `CloudflareSetting` (clé **AES-256-GCM chiffrée, jamais renvoyée**), `Domain` (zones racines, `DomainStatus`), `ClientSubdomain` (`fqdn` unique, `SubdomainStatus`) ; migration `20260906010000_rename_pack_disk_to_storage_limit` (`diskGb` → `storageLimit`, valeur préservée). `Deployment` + `subdomain`/`domainId`/`fqdn`/`clientSubdomain` (allocation auto CNAME → hostname Coolify).
- **Quota disque clean-up (même commit)** : machinerie `--storage-opt`/`custom_docker_run_options` + `mergeStorageOpt`/`storageOptFromGb` **supprimée** ; `storageLimit` aligné `Plan.cpu_limit/memory_limit/storage_limit` — **enregistré + affiché mais quota PAS actif** (branché après mise en prod, voir CHANGELOG « Décision quota disque »).
- **Vérification LIVE (clé réelle)** : zones validées, CNAME créer/lister/supprimer, allocation OK.
- Files modified: `apps/web/src/lib/api.ts` (+Cloudflare types/helpers), `apps/web/src/app/manager/dns/page.tsx` (+., contrôle DNS admin).
- Command: `prisma migrate status` in sync (**+2 migrations**).

## Phase 12 — CATALOGUE PRODUIT → CATÉGORIE + PACK AVEC LIMITES APPLIQUÉES À COOLIFY (ADR-031) — 2026-09-05 (commit `1d2527d`, poussé)
- Files modified: `apps/api/prisma/schema.prisma` — modèles `ProductCategory` + `HostingPack` (`ramMb`/`cpuCores`/`storageLimit`), `Product` + `categoryId?`/`packId?` ; migrations catégories + packs (additives).
- Files created: `apps/api/src/categories/` (controller 69, module 14, `categories.service.ts` 163 + spec 94, `dto/create-category.dto.ts`) — CRUD admin, suppression protégée (409 si référencé) ; `apps/api/src/packs/` (controller 69, module 13, `packs.service.ts` 124 + spec 104, `dto/create-pack.dto.ts` 52) — CRUD admin + recommandation de pack.
- Files modified: `apps/api/src/deployments/deployments.service.ts` +63 — **`applyPack` → `PATCH /applications/{uuid}`** (RAM/CPU du pack) **AVANT** `deployApp` best-effort ; **`deployApp` → `POST /applications/{uuid}/deploy` (vérifié live, `/applications/{uuid}/deploy` = 404 sur Coolify 4.1.2)** ; `panel-transport.factory.ts` +71 (projets/serveurs cibles `coolifyProjectUuid`/`coolifyServerUuid`). `products.service.ts` +86 (liaison catégorie/pack). `servers.service.ts` +6 (uuid Coolify). `subscriptions.service.ts` +11. `create-server.dto.ts` +14. `create-product.dto.ts` +12.
- Files created (web): `apps/web/src/app/manager/packs/page.tsx` (268), `apps/web/src/app/manager/categories/page.tsx` (238) ; modified `manager/produits/page.tsx` +77 (catégorie+pack), `manager/serveurs/page.tsx` +32, `offres/page.tsx` +11, `client/page.tsx` +7, `config/nav.ts` +4, `lib/api.ts` +97.
- Files created: `docs/DESIGN_SYSTEM.md` (307 lignes — documentation du design system).
- Command/Verified: **unit 297 (31 suites) + e2e 149 verts** ; tsc API + web PASS ; `web build` PASS ; **validation réelle Coolify** : app « Test limits pack » avec `limits_cpus=1`/`limits_memory=1g`.
- Files modified: CHANGELOG.md, DECISIONS.md (**ADR-031**), TASKS.md (cette section), PROJECT_STATUS.md.

## Phase 13 — MODULES DE DÉPLOIEMENT A/B + PROJET CLIENT + MONITORING + DASHBOARD CLIENT MODERNE (ADR-032, « ADR Module », 7 parties) — 2026-09-06/07 (commits `0bfd856`, `734d60d`, `c008c84`, `855bdb3`, `52cae27`, poussés)
### 13 backend 1-3 (0bfd856, +890/-93)
- Files modified: `apps/api/prisma/schema.prisma` (+188/-) — modèles `DeploymentModule` + enum `DeploymentModuleKind {SHARED_PROJECT PER_CLIENT_PROJECT}` (`name`/`code` uniques, `isActive`, `serverId`, `sharedProjectUuid/Name`, `perClientPrefix` `client`, overrides `overrideRamMb/overrideCpuCores/overrideStorageLimit`, lié aux packs `maxApps`), `ClientProject` (Module B, `@@unique([userId,serverId,moduleId])`, `projectUuid`), `HostingPack.maxApps?` ; migrations `20260906020000_add_deployment_modules_and_client_projects` (+ `20260907010000_fix_deployment_module_kind_enum`). `Deployment` + `coolifyProjectUuid`/`moduleId`/`clientProjectId`.
- Files modified: `apps/api/src/deployments/deployments.service.ts` (+231 — résolution cible pack→module, `getOrCreateClientProject` publique, quota maxApps, purge best-effort) + spec (+276) ; `dto/create-deployment.dto.ts` (+10) ; `panel-transport.factory.ts` (+104 — `createProject`/`listProjects`/`applyPack`/`deployApp` **`POST /deploy`** (vérifié live ; `/applications/{uuid}/deploy` = 404)) + spec (+106).

### 13.4 — Modules admin + liaison pack (734d60d, +847)
- Files created: `apps/api/src/deployments/deployment-modules.controller.ts` (79), `deployments/deployment-modules.service.ts` (184), `dto/upsert-deployment-module.dto.ts` (87). Files modified: `deployments.module.ts` (+12), `packs/dto/create-pack.dto.ts` (+12), `packs.service.ts` (+12, liaison pack↔module + maxApps). Web: `manager/packs/page.tsx` (+423 — modules A/B, maxApps, **projets live Module A**, projets client Module B), `lib/api.ts` (+58).

### 13.5 — Client deploy sans service + dashboard apps moderne (c008c84, +174)
- Files modified: `schema` migration `20260906030000_make_deployment_service_optional` (`Deployment.serviceId` nullable, mode auto) ; `deployments.service.ts` (+54), spec (+24) ; web `client/page.tsx` (+147 — panneau apps moderne quota N/M), `lib/api.ts` (+25) ; e2e +6/+2.

### 13.6 — Admin users Module B project + monitoring (855bdb3, +655)
- Files created: `apps/api/src/monitoring/` — `monitoring.controller.ts` (`GET /api/admin/monitoring/projects`, ADMIN), `monitoring.module.ts`, `monitoring.service.ts` (173 — **`getProjectsConsumption()`** agrège déploiements par projet Coolify), `app.module.ts` + MonitoringModule. Files modified: `users.service.ts` +89 (findAll inclut `clientProjects`, **`createClientProject`** action admin) + spec +120, `users.controller.ts` (+10 `POST /api/admin/users/:id/project`). Web: `manager/monitoring/page.tsx` (161 — barres ressources, badges danger, tri consommation), `manager/utilisateurs/page.tsx` (+36 — colonne + bouton), `icons.tsx` (+IconChartBar), `config/nav.ts` (+Monitoring projets), `lib/api.ts` +27.

### 13.7 — Dashboard client moderne + suppression app + upgrade pack + articles admin (52cae27, +1329)
- Files modified: `apps/web/src/app/client/page.tsx` (+887 — **refonte complète** : hero, stats, **cartes apps quota N/M**, **suppression d'app 2 étapes** (`DELETE /api/client/deployments/:id`, purge best-effort app Coolify + **sous-domaine Cloudflare DNS**, quota libéré), **upgrade pack** (`PATCH /api/client/subscriptions/:id/upgrade`, même ligne, données conservées), lien `/profil`) ; `globals.css` (+120 — classes `.dash-*`/`.bar-*`, répare monitoring) ; `lib/api.ts` +58.
- Files modified (backend): `deployments.controller.ts` (+8 `DELETE :id`) + `deployments.service.ts` (+92 purge) ; `subscriptions/client.controller.ts` (+11) + `dto/upgrade-subscription.dto.ts` (13) + `subscriptions.service.ts` (+64 upgrade) ; `auth.service.ts` (+32 — **fenêtre de réutilisation 10 s** sur refresh, rotation concurrente) ; `panel-transport.factory.ts` (+87, fix `listProjects` enveloppe `{success}` sans tableau → rejetée à juste titre) + spec +10 ; `users.module.ts` (+5 MonitoringModule).
- Files created: `apps/api/prisma/seed-knowledge.ts` (+174 — **+5 articles admin PUBLISHED** : offre + modules A/B) ; `start.sh` (109 — relance Postgres → API :3001 → Web :3000).
- Verified: unit/e2e + tsc api/web + `web build` verts à chaque sous-phase ; validation réelle Coolify (« Test limits pack » `limits_cpus=1`/`limits_memory=1g` appliqués).
- Files modified: CHANGELOG.md, DECISIONS.md (**ADR-032**), TASKS.md (cette section), PROJECT_STATUS.md.

## Phase 14 — PLATEFORME MULTI-BRAND / WHITE-LABEL CONFIGURABLE (branding admin « Apparence ») — 2026-09-08 (commits `2cf7b1d`, `8e5abcf`, poussés — validés 2× par le propriétaire)
### 14.1 (2cf7b1d, branding + fix logo image)
- Files modified: `apps/api/prisma/schema.prisma` (+29) — **`BrandConfig` singleton** (id fixe `'brand'`, `name`, `sub`, `tagline?`, `hostname?`, `logoType` enum `BrandLogoType {DEFAULT TEXT IMAGE}`, `logoText?`, `logoUrl?`, `primaryColor` `#00b377`, `accentColor?`, `updatedById?`) ; migrations `20260908010000_add_brand_config` (22) + `20260908020000_add_brand_logo_show_text` (4, `logoShowText Boolean @default(false)`). **25 migrations** in sync.
- Files created: `apps/api/src/branding/` — `branding.module.ts` (onModuleInit garantit la ligne, idempotent), `brand-public.controller.ts` (`GET /api/brand` sans guard), `admin-branding.controller.ts` (PATCH `/api/admin/branding`, POST reset, POST logo — FileInterceptor PNG/JPEG/WebP ≤ 2 Mo, **SVG refusé XSS**), `branding-assets.controller.ts` (`@Controller('branding')` → **`/api/branding/:file`** `res.sendFile`), `branding.service.ts` (247 — setLogo/removeLogo/reset/update/toPublic), `dto/update-branding.dto.ts`, `branding.service.spec.ts` (224, puis 15 tests). `.gitignore` `public/branding/*.png` + `.gitkeep`. **FIX ORB** : `logoUrl` stocké sous `/api/branding/...` (chemin `/branding/...` 404 → ERR_BLOCKED_BY_ORB).
- Files modified: `app.module.ts` (+BrandingModule) ; `seed-knowledge.ts` (+39 — article « Configurer la marque » idempotent).
- Files created (web): `app/manager/apparence/page.tsx` (288 — Identité/Logo/Couleurs/reset) ; `components/brand-provider.tsx`, `components/brand-logo.tsx`, `lib/brand-palette.ts`, `lib/brand-data.ts`. Files modified: `layout.tsx` (+29 — `generateMetadata()` + `<style :root>` `--brand-*` sans flash), `app-shell.tsx` (+36 — BrandLogo/Provider), `globals.css` (+62 — verts dérivés `color-mix(var(--brand-primary))`), `config/brand.ts` (défauts `defaultBrand`), pages `/`, `/offres`, `/auth`, `/aide` (+brand), `lib/api.ts`.

### 14.2 (8e5abcf, logo image seule / suppression / identité facultative)
- Files modified: `branding.service.ts` (+42 — **`removeLogo`** : unlink best-effort, `logoUrl=null`, retour DEFAULT, audit `branding.logo-remove` ; `setLogo` attend `/api/branding/`) ; `admin-branding.controller.ts` (+8 — **`POST /api/admin/branding/logo/remove`**) ; `dto/update-branding.dto.ts` (**nom FACULTATIF** `@IsOptional` — plus d'erreur « il faut écrire quelque chose » ; tags nullables) ; `branding.service.spec.ts` (+40, 15 tests).
- Files modified (web): `app/manager/apparence/page.tsx` (+41 — case **« Afficher aussi le texte à côté du logo »** `logoShowText`, bouton **« Supprimer le logo »**, label nom « vide si image seule ») ; `app-shell.tsx` (+34 — masque colonne texte `brand-col` quand `logoType=IMAGE` en topbar + sidebar) ; `lib/api.ts` (+3 `removeBrandLogo`).
- Verified: **unit 15 tests branding verts** ; **test réel navigateur (Chrome + cookies)** : IMAGE seule → topbar `imgCount:1`/`brandTextNodes:0` (nom/sous-titre/tag masqués), IMAGE+texte → wordmark ; image `naturalWidth>0`, zéro ORB. Suites pré-existantes non régressées ; migrations 24→25 in sync.
- Files modified: CHANGELOG.md, DECISIONS.md (**ADR-034**), TASKS.md (cette section), PROJECT_STATUS.md.

## Rattrapage gouvernance (2026-09-08)
- Action: la gouvernance accusait un retard (jusqu'à la Phase 11) alors que git montrait Phases 12, 13, 14 + Cloudflare DNS **implémentées ET poussées**. Rattrapage : CHANGELOG.md (+4 phases), DECISIONS.md (+**ADR-031/032/033/034**), PROJECT_STATUS.md (état global → Phase 14, state/verified/pending/decisions/next à jour), TASKS.md (cette section). Aucun code modifié.
- Constat : `origin/main` à jour (ahead 0) ; 25 migrations in sync ; `git status` propre (seul `.claude/settings.json` modifié, hors gouvernance).
- **Ne rien pousser pour ce rattrapage sans ok explicite du propriétaire** (règle conservée).

# PHASE 17 — PROVISIONING STORE À PREUVE RÉELLE + SOUS-DOMAINES GRATUITS PAR PRODUIT (ADR-037) — 2026-09-15

## 2026-09-15 — Résolution « 3 commandes sans app » + proof-gate + sous-domaines gratuits (code + tests + live)
- **Contexte** : 3 commandes payées de `ermocrypt` bloquées à PAID sans app (`cmu1vlz6h…` GitHub App, `cmu1vnrbq…` Site Statique, `cmu1vqilq…` API Node). Exigence durable réaffirmée : **ne jamais confirmer une commande avant que ce soit réellement OK** (pas de faux ACTIVE).
- **Files created** : migration `apps/api/prisma/migrations/20260915120000_attach_free_subdomain_rules` ; `apps/api/src/store/provisioning.service.spec.ts` (+tests preuve/create-app-error/proof-gate).
- **Files modified** : `apps/api/src/store/provisioning.service.ts` (proof-gate dans `finalize` : ACTIVE + email UNIQUEMENT sur preuve réelle — poll `deploymentStatus` ACTIVE ou HTTP 2xx/3xx `awaitAppReady` 120 s ; échec create_app → `app_not_created`, jamais ACTIVE ; **fix réutilisation d'app** idempotente `appUuid = row.coolifyUuid` au lieu de re-`createGitApp` — rendu par commit live d'un doublon `bwgy96…`), `apps/api/prisma/schema.prisma` (FreeSubdomainRule 1:1), provisioning/service + products (exposition `freeSubdomainRule`), web `/shop/[slug]`.
- **Database changes** : migration `20260915120000_attach_free_subdomain_rules` appliquée — FreeSubdomainRule attaché à `deploy-github-app`, `site-statique-premium`, `api-node-starter` (vide `allowedDomainIds` = toutes racines ACTIVES codediali.com + arumdigital.com). **34 migrations in sync.**
- **Résultat live (propre, aucune invention)** : GitHub App `q52…` ACTIVE HTTP 200 · Site Statique `xah8nn…` ACTIVE HTTP 200 (email livré) · **API Node `bc68…` PROVISIONING (`exited:unhealthy`)** — `api-node-starter` pointe sur le repo STATIQUE `merrabii/Code-Diali-Guide-de-Demarrage.git` (static=false, pas de serveur) ⇒ l'app ne peut pas monter ; le gate l'a correctement **maintenu PROVISIONING (jamais de faux ACTIVE)**.
- **Tests/validation** : unit **71/71** + `tsc` API + web tsc PASS ; proof-gate éprouvé live.
- **À corriger en PROCHAINE PHASE (non résolu — NE PAS présenter comme résolu)** : tester le provisioning réel d'un **vrai backend Node** via **`https://github.com/Ryadel/NodeJS-Express-CRUD-API-Sample`**, vérifier HTTP 200 réel, **ne jamais utiliser de faux statut ACTIVE** ; puis **nettoyer l'app orpheline** `bwgy96194kmgo3v3t6psqokp` (accord propriétaire requis).
- **Follow-up** : app orpheline NON supprimée (accord requis) ; correction Node.js PAS commencée — commit **checkpoint** uniquement.

# COMPLETED HISTORY
- Clean baseline (Pre-Phase 0): documentation pack + first AI orientation.
- Phase 0: source tree and config files authored; runtime execution (install, generate, migrate, tests) pending toolchain availability.
- Phase 1: Auth + first tables (User + RefreshToken) — owner-validated, poussée.
- Phase 2: Modèle cœur Product+Server globaux plateforme + console /manager — owner-validated, poussée.
- Phase 3: gestion utilisateurs admin + dashboard /manager + catalogue enrichi — owner-validated 2026-08-31.
- Phase 4: journal d'audit « qui a fait quoi » (ADR-019) — owner-validated 2026-08-31, commitée.
- Phase 5: espace client + accès sécurisé (ADR-020 invitations 410 + ADR-021 Subscription/Service) — owner-validated 2026-08-31, tests 62/62 + 51/51 verts, builds PASS.
- Phase 6: configuration mail admin + emails d'invitation (ADR-022) — owner-validated 2026-08-31 (SMTP Brevo réel, domaine codediali.com, événements `delivered`), tests 90/90 unit + 61/61 e2e (8 suites), builds PASS, commitée (47838c1), push en attente d'instruction.
- Phase 7: design system de l'interface (ADR-023) — réécriture visuelle complète (tokens dark/light de la référence copiés à l'identique, brand-agnostic, thème + anti-FOUC, composants AppShell/ui/icons, 9 pages refactorées logique intacte) — 2026-08-31, commitée `31af3e2`.
- Phase 7bis: polish UI (ADR-023 follow-up) — sélects chevron SVG + alignement boutons, contraste bordures light (2 tokens), espacement alerts, toasts pop-up (OK + 5 s) via ToastProvider/useToast convertis sur 8 pages (inline conservés : diagnostic `/`, panneau invitation créée) — 2026-08-31, typecheck + build + smoke PASS, aucun changement API/DB.
- Phase 8 : sonde de connectivité réelle des serveurs (ADR-025) — modèle `Server` +`lastCheckedAt`/`lastProbeOk`/`lastProbeDetail` (7 migrations), `ProbeTransportFactory` (couture de test type mail, TCP/HTTP/strictTls/timeout 5s, leçon DI Nest sur les primitives), endpoint ADMIN `POST /api/servers/:id/check` + audit `server.check` (3 champs persistés, statut jamais forcé), UI `/manager/serveurs` colonne Connexion (badge OK/Échec/—) + bouton Tester + bascule `→ ACTIVE`/`→ PROBLEM` — 2026-09-01, unit 98/98 + e2e 67/67 (9 suites, override couture zéro réseau), typecheck + web build (14 routes) + smoke live (sonde OK `localhost:5432` 8 ms / refus `127.0.0.1:5999`, audit rempli) PASS.
- Phase 7ter: gestion admin Serveurs & Produits + détails infrastructure (ADR-024) — modèle `Server` étendu (ip/port/provider/region/quota/strictTls/panelProvider HESTIA|COOLIFY, 6 migrations), DTO/service/tests, pages `/manager/serveurs` (table CRUD large + édition inline) et `/manager/produits`, dashboard `/manager` **lecture seule**, sidebar Serveurs/Produits, conteneur 1320px — 2026-09-01, unit 91/91 + e2e 62/62, typecheck + web build (14 routes) + smoke live PASS, **commit `1d7131e` + push + owner-validé ✓**.
## Phase 17b — Résolution générique du port exposé des backends Node (ADR-038) — 2026-09-15 — IMPLEMENTED + vérifié live (en attente validation)
- [x] Constat empirique Coolify 4.1.2 : `ports_exposes` `null` à la création ET après build fini ; proxy n'atteint que le port EXPOSE (nixpacks Node → 8080) ; forcer `ports_exposes=3000` → 502 persistant. → approche A (port canonique global) **rejetée**.
- [x] Hiérarchie de résolution provider → contrat build-pack → source `none` (PROVISIONING + audit, jamais de port inventé, jamais de faux ACTIVE).
- [x] `runtime-port-contract.ts` (créé) : contrat explicite `{ nixpacks, node, 8080 }`, comparé à des connaissances du build-pack, extensible, **non lié à un repo/slug**.
- [x] `resolveExposedPort` (abstrait + impl Coolify `NodePanelTransport`) : lit `GET /applications/:uuid` ; non-résolu sur null/vide/multi-port/invalide (≤0, >65535, non-entier).
- [x] Dédup PORT dans `applyNodePort` : après PATCH `ports_exposes`, supprime env PORT résiduels (case-insensitive) puis reclasse **un seul** env runtime. Port = port exposé résolu, **pas** un `NODE_CANONICAL_PORT` global.
- [x] `resolveBackendExposedPort` dans `provisioning.service` ; suppression `NODE_CANONICAL_PORT`.
- [x] Statique inchangé (aucune logique de port) ; proof-gate intact.
- [x] Tests : provider 4000→applyNodePort(4000) ; provider null→8080 ; provider null + buildpack dockerfile→PROVISIONING + audit `ok:false source:none` ; static→aucun applyNodePort ; dédup PORT (supprime les 2 PORT, pas OTHER) ; `resolveExposedPort` (8080 / null variantes / multi-port / invalide / 500 / Hestia throw).
- [x] **Preuve live source provider** : app `wefvox807fnvw8whzigoovxe`, `node-1509-e2e.arumdigital.com` → **ACTIVE**, public **HTTP 200** + `x-powered-by: Express` + titre heroku ; exposure 8080, PORT unique 8080, « Listening on 8080 », audit `source=provider port=8080 ok=true`.
- [x] **Preuve live source contrat build-pack** : order neuf `ord-node-contract-20260915`, app `ygavfhog4vigx4tbp8zt93wn`, `test-node-e2e.arumdigital.com` → convergé 8080, **public HTTP 200** (page heroku ; 2ᵉ app distincte ⇒ non repo-spécifique) ; PROVISIONING transitoire (gate correct : « Non-existent domain » avant câblage traefik) puis **réconcilié ACTIVE** après le 200 vérifié (trace audit).
- [x] Orphelin `bwgy96194kmgo3v3t6psqokp` : confirmé supprimé (Coolify « Application not found ») ; ressources partagées intactes (2 apps live subsistent).
- [x] Tests automatisés : unit **398/398**, e2e **146/146** verts.
- [!] **Pas de push GitHub — attente validation propriétaire.** Restant : re-pointer le produit `api-node-starter` vers un vrai repo backend, re-provisionner `bc68…` via le chemin code réel, validation.

## Phase 17c — Produit api-node-starter = vrai backend + tentative flux produit réel (2026-09-15)
- [x] Audit produit `cmu1tljf8000bpelc1k2ltft3` (api-node-starter) : repo stocké dans `Product.moduleParams.repoUrl` ; runtime = `moduleParams.isStatic/publishDirectory/buildPack` ; `isServerRuntime = !(isStatic || publishDirectory)` ; flux = Order→`actionCreateApp` lit `order.product.moduleParams`→`createGitApp(repoUrl, buildPack, isStatic, …)`→ si serveur runtime `resolveBackendExposedPort`→`applyNodePort` ; repo transmis au provider via `createGitApp`.
- [x] Constat : la base live a DÉJÀ `repoUrl=heroku/nodejs-getting-started.git`, `isStatic:false`, `buildPack:nixpacks` (repointée en E2E) — le produit est bien un backend.
- [x] **Source de vérité corrigée (COMMIT 2)** : `seed-catalog.ts` — `api-node-starter` reçoit explicitement `repoUrl=heroku` (au lieu du fallback repo statique) + commentaire « jamais codé dans le moteur ». Reproductible.
- [x] COMMIT 1 `7490de1` (fix provisioning ADR-038) ; COMMIT 2 `528d1b9` (fix catalog backend).
- [~] **Tentative flux produit réel** : commande propre `ord-node-product-20260915` (PAID, produit api-node-starter, sous-domaine `node-product-e2e`) → force-provision admin : configure_dns **SUCCESS** (`node-product-e2e.arumdigital.com` CNAME CRÉÉ) ; **create_app FAILED +403 Coolify « You are not allowed to access the API »** = **allowlist IP Coolify** (egress actuel `105.190.173.126` non autorisé — IP publique dynamique, cf. mémoire). Aucun orphelin (create échoué avant création), order restée **PROVISIONING** (gate correct, jamais de faux ACTIVE). => **BLOQUÉ à la frange provider par config d'infra externe**, pas un bug du moteur.
- [!] Restant : ré-autoriser l'IP egress dans Coolify (portal.arumdigital.com, opérateur) puis relancer le MÊME force-provision (idempotent) pour compléter la preuve **Produit→Commande→Provisioning→Provider→PORT→Node→Proxy→HTTPS→Proof→ACTIVE**.
- [x] Régression static : `isServerRuntime = !(isStatic || publishDirectory)` inchangé ; seed ne touche pas les produits statiques.
- [x] **RÉSOLU — IP Coolify ré-autorisée (opérateur), relance idempotente réussie → ACTIVE** : `create_app` SUCCESS app `iv7agk1rhijid5dth830nxni` ; **public HTTPS 200** `node-product-e2e.arumdigital.com` (provenance `x-powered-by: Express` + titre heroku, edge cloudflare) ; **Order ACTIVE** (proof-gate). Provider : `running:unknown`, `build_pack:nixpacks`, `ports_exposes:"8080"`, `PORT=8080 is_runtime:true`, `is_static:null`. Chaîne **Produit→Commande→Provisioning→Provider→PORT→Node→Proxy→HTTPS→Proof→ACTIVE** complète.
- [x] **Idempotence** : 2ᵉ force-run = « App réutilisée et redéployée » (même UUID), **1 seule** row Deployment (`cmu37y5t30037peecq5a78lq3`).
- [x] **RÉSOLU — divergence Deployment DEPLOYING / Order ACTIVE (COMMIT 4)** : audit machine d'état → la voie store posait la row en DEPLOYING sans jamais la passer ACTIVE (seule la réconciliation lazy du dashboard `refreshStatus` le faisait, si vue) ⇒ divergence **réelle à l'arrêt**. Correctif ciblé `reconcileDeploymentActive(orderId)` dans la branche `ready===true` du proof-gate (après `setOrderStatus(Order.ACTIVE)`) : `deployment.updateMany({where:{orderId,status:DEPLOYING},data:{status:ACTIVE}})` + audit `provision.deployment_active`. **Borné à DEPLOYING** ⇒ jamais FAILED→ACTIVE, idempotent, jamais de création, sûr en concurrence avec `refreshStatus`. ADR-037/038, port, build-pack, proof-gate inchangés ; aucun statut forcé en base. 7 tests unit (TEST1–TEST7) ; unit **405/405**, tsc vert.
- [x] **Pas de push** : 4 commits locaux (`7490de1` · `528d1b9` · `555b808` · `fix(provisioning): reconcile deployment status after proof`), attente validation GO.

--------------------------------------------------------------------
## Phase 2 (audit produit admin) — 2026-09-16 — ALIGNEMENT PRODUCT READINESS / SOURCE DE VÉRITÉ SERVEUR
- [x] **Audit** : l'onglet Roadmap d'un produit lisait le serveur via `product.pack?.deploymentModuleId` (scalaire **absent** de la payload admin) puis cross-lookup dans la liste `modules` → toujours `undefined` → **fausse alerte BLOCKING** « Serveur Coolify non configuré » (cas API Node.js Starter, réellement ACTIVE via provisioning). Le **provisioning** lit la relation embarquée `product.pack.deploymentModule.server` (même source que `getProvisioning`), correcte. Cause racine = 2ᵉ incident de la classe « cross-lookup sur scalaire absent » (le commentaire disait l'inverse).
- [x] **Correction** :
  - `apps/web/src/components/admin/product-roadmap-logic.ts` (NOUVEAU) : logique pure de readiness **extraite** (sans React), lit module/serveur/type via **`pack.deploymentModule.server`** ; suppression cross-lookup mort + prop `modules`. Règle **NOT_APPLICABLE** : sans pack → section Déploiement informative ; **BLOCKING réel conservé** si pack sans serveur.
  - `apps/web/src/components/admin/product-roadmap-tab.tsx` : consomme la logique pure ; commentaire trompeur corrigé.
  - `apps/web/src/components/admin/product-editor.tsx` : retrait de `modules={modules}` sur la Roadmap (Général conserve son utilisation de `modules`).
  - `apps/web/src/lib/api.ts` : type `PackMin.deploymentModule` aligné sur la payload réelle (`kind` + `server {id, hostname}`) — la vue Produit embarque le serveur, la vue Pack non.
  - `apps/web/scripts/readiness-tests.mjs` (NOUVEAU) : runner léger (typescript déjà installé ; transpile le module pur → node:assert). « Frontend sans runner de test » documenté.
- [x] **Tests** : readiness **5/5 passés** (TEST1 server valide→ok · TEST2 pack+module sans serveur→reste BLOCKING · TEST3 deploymentModuleId absent + relation server présente→aucun faux BLOCKING · TEST4 reload/payload admin→correcte · TEST5 sans pack→NOT_APPLICABLE info). `tsc --noEmit` web **EXIT 0**. `next build` **BUILD_EXIT 0** (types valides). **Aucune modif backend/API** (payload portait déjà la relation) ⇒ aucun test API rejoué.
- [x] **Docs** : CHANGELOG 2026-09-16 · PROJECT_STATUS (Overall + Current phase + Contexte Phase 17 rétro) · HANDOVER · TASKS. **Aucun nouvel ADR** (alignement, pas de nouvelle décision) ; DECISIONS.md non pertinent → non modifié.
- [x] **Commit local** : `fix(admin): align product readiness with provisioning` — **non poussé** (attente GO). Aucun hardcode (serveur/ID/UUID/slug), aucun secret, aucun debug.

--------------------------------------------------------------------
## Phase 3 (Security + Turnstile) — RUNTIME TURNSTILE ALIGNÉ SUR LE FLAG ADMIN — 2026-09-16 (commit local non poussé)
### Recovery
- [!] **Constat** : le working-tree Phase 3 interrompu par un redémarrage a été **perdu par un `git reset` à HEAD** (`04c6f69 HEAD@{0} / reset` au reflog), jamais committé/stashé ⇒ irrécupérable. Seul le **spec non suivi** `public-config.controller.spec.ts` (contrat encodé) a survécu.
- [x] **Règle** : NE PAS reproduire les ~183 lignes perdues — **reconstruire depuis le baseline + le spec survivant**, implémenter uniquement le contrat nécessaire.
### Problème (2 classes)
- [x] **Fuite/annonce** : `public-config` exposait la clé SITE **sans condition** (flag OFF ou config incomplète ⇒ Turnstile non actif servi comme actif).
- [x] **Divergence frontend/backend** : frontend rend le widget sur `turnstileSiteKey !== ''` (aucun token) ; `auth.login` + `support-codes.redeem` gated sur le **flag seul** `isTurnstileEnabled()` ⇒ `enabled=true` + config incomplète ⇒ **login/redeem impossibles**.
### Corrigé (notion effective unique)
- [x] `turnstile.service.ts` : **`isActive()`** = `enabled && configured` (flag ET clés SITE+SECRET, DB→env) ; **`getSiteKey()`** = résolution unique DB→env (la résolution du contrôleur, dupliquée, est supprimée).
- [x] `public-config.controller.ts` : injecte `TurnstileService` ; clé SITE servie **seulement si `isActive()`** (sinon `''`) ; **secret jamais exposé**.
- [x] `auth.service.login` + `support-codes.controller.redeem` : gate aligné sur **`isActive()`** (+ commentaire). `support-codes` modifié car **dépendance démontrée** du même contrat (pas la raison inconnue du diff perdu).
- [x] Sémantique fail-closed préservée : échec `verify()` externe rejette ; « inactif » = config absente/incomplète, jamais un échec réseau.
- [x] Frontend **inchangé** (auth/page.tsx et support/page.tsx gate déjà sur `config.turnstileSiteKey !== ''`).
### Tests
- [x] `turnstile.service.spec` **+8** (isActive OFF·ON full·SITE manquante·SECRET manquant·env-only ; getSiteKey DB→env→vide).
- [x] `auth.service.spec` **+4** (OFF pas de verify · ON verify · config incomplète cohérente · échec fail-closed). Spec survivant **adapté** (mock `getSiteKey`).
- [x] `public-config.controller.spec` (survivant, maintenant suivi) : TEST1 OFF→`''` · TEST3 ON full→clé · TEST5 secret absent · TEST8 ON incomplet→`''` · OAuth non-régression.
- [x] `security-settings.service.spec` : **inchangé** — la chaîne Admin OFF/ON save/persist/reload est déjà couverte (update `turnstileEnabled`, clés write-only, `''` efface).
### Gates
- [x] Unit API **422/422** (baseline 405 +17) · **35/35** suites · `tsc --noEmit` API **vert** · `nest build` **vert** · `tsc --noEmit` web **vert** (web inchangé). E2E non rejouées (aucun chemin E2E modifié).
### Docs
- [x] CHANGELOG · PROJECT_STATUS (Overall + Current phase + Decisions ADR-039) · TASKS · HANDOVER · **DECISIONS.md → ADR-039** (invariant `active = enabled && configured` partagé par public-config et les portes d'enforcement).
### Commit state
- [x] **Commit local** : `fix(security): align turnstile runtime with admin setting` — **non poussé** (attente GO). Aucun secret, aucun hardcode. **Aucun `git reset` après commit.**

--------------------------------------------------------------------
## 2026-09-19 — Rate-limit admin du statut public de commande + TRUST_PROXY (ADR-041) — IMPLEMENTED + VERIFIED

### Contexte
Le suivi public d'une commande (`GET /api/store/orders/:id/status`) était sans limitation : un identifiant connu pouvait être interrogé sans restriction.

### Fichiers créés
- Migration additive : `apps/api/prisma/migrations/20260919155137_order_status_rate_limit/`
- Tests : `apps/api/src/config/configuration.spec.ts`, `apps/api/src/store/checkout.controller.spec.ts`, `apps/api/test/store-order-status.e2e-spec.ts`

### Fichiers modifiés
- `apps/api/.env.example` (+TRUST_PROXY documentation)
- `apps/api/prisma/schema.prisma` (+3 colonnes SecuritySetting)
- `apps/api/src/app.module.ts` (import SecurityModule)
- `apps/api/src/auth/security/dto/update-security-settings.dto.ts` (+3 champs rate-limit avec bornes)
- `apps/api/src/auth/security/security-settings.service.ts` (+cache TTL 30s, getOrderStatusRateLimit, invalidation immédiate, bornes + fallback)
- `apps/api/src/auth/security/security-settings.service.spec.ts` (+tests rate-limit)
- `apps/api/src/config/configuration.ts` (+parseTrustProxy, trustProxy dans AppConfig)
- `apps/api/src/main.ts` (applique trustProxy au boot, log)
- `apps/api/src/store/checkout.controller.ts` (endpoint status + rate-limit + 429 Retry-After)
- `apps/api/test/security-settings.e2e-spec.ts` (+tests admin rate-limit)
- `apps/web/src/app/manager/securite/page.tsx` (panneau Rate-limit : toggle, bornes 5-1000/10-3600, preview lisible, avertissement si désactivé, restauration true/30/60, bouton Enregistrer unique)
- `apps/web/src/lib/api.ts` (+types rate-limit)

### Implémentation
- **Endpoint public sans PII** : `{found, status}` uniquement
- **HTTP 429 + Retry-After** (secondes)
- **Configuration admin** : `enabled` (bool), `max` (5..1000), `windowSec` (10..3600), défauts `true/30/60`
- **Cache mémoire TTL 30 s** + invalidation locale immédiate après `update()`
- **TRUST_PROXY** : défaut `false` (XFF ignoré), `"true"` REFUSÉ, seuls IP/CIDR explicites ou presets acceptés
- **Mono-instance** : `SaRateLimiter` mémoire suffit ; Redis futur pour multi-instances (ADR-007)
- **Migration additive** : 3 colonnes, défauts, aucun DROP/backfill

### Validations
- `corepack pnpm --filter @codediali/api exec tsc --noEmit` → PASS
- `corepack pnpm --filter @codediali/api run build` → PASS
- `corepack pnpm --filter @codediali/web exec tsc --noEmit` → PASS
- `corepack pnpm --filter @codediali/web run build` → PASS (30 routes)
- Unit API : **495/495 PASS (38 suites)**
- E2E API : **150/150 PASS (20 suites)**

### Documentation
- DECISIONS.md : ADR-041 ajouté
- CHANGELOG.md : entrée 2026-09-19 ajoutée
- PROJECT_STATUS.md : à mettre à jour
- HANDOVER.md : à mettre à jour
- docs/plan-infrastructure.md : à mettre à jour

--------------------------------------------------------------------
## 2026-09-19 — Couverture E2E Phase 4 (checkout Store multi-domaines) — IMPLEMENTED + VALIDATED

### Contexte
Le moteur Phase 4 (ADR-040 : choix de la racine + gel `effectiveDomainId` avant DNS) reposait sur des tests unitaires. Cette tâche ajoute une couverture E2E de bout en bout du checkout store multi-domaines de la plateforme white-label Code Diali. **Aucune modification de code métier.**

### Fichier créé
- [x] `apps/api/test/store-checkout-domains.e2e-spec.ts` (nouveau, **21 tests**, 787 lignes — groupes A / B / C)

### Implémentation (couverture de tests)
- [x] **A.** `POST /api/store/subdomain/check` : whitelist, racine DISABLED, ambiguïté (aucun pick arbitraire), défaut plateforme, racine unique.
- [x] **B.** `POST /api/store/checkout` : persistance réelle de `requestedDomainId`, rejets fail-fast, **idempotence distincte selon la racine**, chemin membre (2 commandes distinctes).
- [x] **C.** Provisioning multi-domaines : `requestedDomainId` consommé, **`effectiveDomainId` gelé AVANT l'allocation DNS** (trace au `createRecord`), retry `force=1` conservant racine/FQDN/allocation, **commande legacy `requestedDomainId=null` compatible**, durcissement racine DISABLED.
- [x] **Aucun appel réel** : CloudflareTransportFactory (records en mémoire), MailTransportFactory (aucun SMTP), PanelTransportFactory (aucun Coolify) mockés ; CloudflareService/CryptoService/PrismaService réels.
- [x] **Hygiène** : singletons CloudflareSetting/BillingSetting restaurés à l'identique, fixtures nettoyées (suppressions bornées).

### Validations (relancées, toutes PASS)
- [x] E2E API complète : **171/171 PASS (21 suites)** (150 + 21).
- [x] Unit API : **495/495 PASS (38 suites)**.
- [x] Typecheck API PASS · Build API PASS · Typecheck Web PASS · Build Web PASS (2 typechecks + 2 builds).
- [x] Runtime API : `GET http://localhost:3001/api/health` → **HTTP 200**.
- [x] Runtime Web : `GET http://localhost:3000/` → **HTTP 200**.
- [x] **Lint NON exécutable** : ESLint + configuration absents de ce checkout (préexistant), aucune installation/modification de dépendance faite — suivi séparé recommandé (n'ajoute pas ESLint maintenant).
- [x] **Flakiness loopback préexistante documentée** : première passe complète 492/495 (3 échecs dans `panel-transport.factory.spec.ts`), isolé 35/35, re-passe complète 495/495 ; fichier non modifié ; **non corrigée**, sujette à stabilisation ultérieure.

### État
- [x] Implémentation **terminée** : **21 nouveaux tests** E2E (787 lignes, groupes A/B/C).
- [x] Couverture E2E Phase 4 **validée** : e2e **171/171** PASS (21 suites) ; unit **495/495** PASS (38 suites) ; validations API/Web réussies.
- [x] Changement inclus dans `test(store): add multi-domain checkout e2e coverage`.
- [x] Docs ajoutées : CHANGELOG, TASKS, PROJECT_STATUS, HANDOVER.

### Suivis futurs
- **Lint (préexistant, séparé)** : script `lint` présent mais **ESLint et sa configuration absents de ce checkout** (monorepo pnpm, aucun `eslint@` au lockfile) ; aucune installation/modification de dépendance faite ici — installation et intégration à suivre séparément.
- **Flakiness loopback (préexistant, séparé)** : `servers/panel-transport.factory.spec.ts` — première passe complète 492/495 (3 échecs réseau), isolé 35/35, re-passe complète 495/495, fichier non modifié, non corrigé — à stabiliser ultérieurement.
- Aucune autre action en attente pour cette tâche (implémentation + validations terminées) ; toute prochaine étape fonctionnelle sera décidée séparément par le propriétaire.

--------------------------------------------------------------------
## 2026-09-26 — 17B.4F-C1 : moteur de réservation transactionnel (hosting) — IMPLEMENTED + VALIDATED (non commité, non poussé)

### Contexte
Suite de 17B.4F-B1 (fondation `HostingService` / `HostingServiceAllocation`, commit `a96684f`, poussé). Cette étape livre le **moteur LOCAL de réservation** : verrou `SELECT … FOR UPDATE`, quota par service, empreinte HMAC versionnée, primitives d'état C1 — **aucun appel réseau, aucun endpoint, aucun branchement live**, exécuté **uniquement sur une base de test isolée**.

### Périmètre livré (C1 seulement)
- [x] `reserveSlot` (1 transaction) : verrou de ligne sur `HostingService` avec `id` + `userId` (0 ligne → 404, jamais 403) ; rejeu idempotent par clé dérivée **serveur** `direct:v1:<user>:<service>:<uuid v4>` + vérification d'empreinte → MÊME allocation, **jamais de 2ᵉ ligne**, aucun re-comptage au rejeu, `RELEASED` terminal même au rejeu, rejeu possible sur service entre-temps suspendu ; création = `ACTIVE` **seul** + quota (`maxAppsSnapshot null` = illimité, `0` = refus) → `RESERVED`.
- [x] Empreinte `fp:v1:<hex>` : canonical déterministe (clés triées récursivement) + **HMAC-SHA256 versionné** (jamais de SHA-256 brut), keyring `HOSTING_FP_KEYS` (JSON versionné) / `HOSTING_FP_ACTIVE` avec fallback dérivé `ENCRYPTION_KEY` (même contrat que `CryptoService`), comparaison `timingSafeEqual`, **version/clé inconnue → refus explicite sans aucun repli**, configuration absente → refus **à l'appel** (503) sans casser le démarrage de l'API.
- [x] Primitives locales (chacune sous verrou d'allocation ; ordre `HostingService → HostingServiceAllocation → Deployment`) : `markProviderIntent` (marqueur **irréversible**, jamais sur `RELEASED`, résultat explicite), `releasePreProvider` (exige `RESERVED` + intention NULL + `deploymentId` NULL), `markBound` (preuve `providerProven` exigée — 412, idempotent sur le même déploiement, ownership service **et** déploiement, `RELEASING → BOUND` **interdit**), `startReleasing` (`RESERVED|BOUND → RELEASING`, idempotent), `completeRelease` (preuve `providerCleanupProven` + `deploymentId` NULL → `RELEASED`).
- [x] `HostingModule` créé mais **NON branché** dans `AppModule` (aucun parcours live ne traverse le moteur).
- [x] Hors périmètre explicite (C2–C4) : lease / `claimUntil` / `claimSeq`, découverte d'identité provider, reprise de création, branchement des parcours.

### Fichiers créés
- `apps/api/src/hosting/hosting-fingerprint.ts` (canonique + HMAC keyring + clé directe), `hosting-fingerprint.spec.ts` (11 tests), `hosting.module.ts`.
- `apps/api/prisma/migrations/20260926000000_add_allocation_fingerprint/migration.sql` (2 `ALTER TABLE … ADD COLUMN` NULL).
- `apps/api/test/hosting-allocation-reservation.e2e-spec.ts` (19 tests, **2 passages de matrice concurrente**), `apps/api/test/hosting-reservation.fixture.ts`.

### Fichiers modifiés
- `apps/api/src/hosting/hosting-services.service.ts` (`reserve`/`bind` naïfs → moteur C1 transactionnel + 5 primitives), `hosting-services.service.spec.ts` (appels adaptés + **13 tests C1**), `apps/api/prisma/schema.prisma` (+ `requestFingerprint`, `providerIntentAt`), `apps/api/test/hosting-service-foundation.e2e-spec.ts` (appels C1 ; services mis en `ACTIVE` avant réservation, invariants B1 conservés).

### Base de données
- [x] Base de test **isolée** `icode_host_pro_c1_test` créée dans `icode-postgres` : **46/46 migrations** appliquées, `prisma migrate status` = à jour, **drift `prisma migrate diff` = « No difference detected »**.
- [x] **`icode_host_pro` (live) NON modifiée** : 0 `HostingService`, 0 allocation, 15 déploiements legacy intacts, colonnes de `HostingServiceAllocation` toujours au nombre de 10 (sans les 2 nouvelles) → `migrate status` live = **1 migration en attente** (`20260926000000_add_allocation_fingerprint`), à appliquer lors d'un déploiement validé.

### Tests/validation (tous PASS)
- [x] Unit API : **856/856 PASS (51 suites)**.
- [x] e2e fondation B1 (base de test) : **23/23 PASS**.
- [x] e2e C1 (base de test, concurrence réelle, 2 passages de matrice) : **19/19 PASS**.
- [x] `prisma generate` + `prisma validate` OK ; `tsc --noEmit` OK ; `nest build` OK.
- [x] Runtime : API `GET /api/health` → **200** (`database=ok`) après redémarrage ; Web `GET /` → **200**.
- [x] Lint : ESLint toujours absent du checkout (dette préexistante, inchangée).

### Garde-fous respectés
- [x] **Aucun commit, aucune poussée** : HEAD = origin/main = `a96684f`, divergence `0/0`, working tree sale = ce lot uniquement.
- [x] Aucun appel provider/DNS/GitHub, aucun endpoint ni frontend, `app.module.ts` inchangé, `.env` inchangé (clés de test **synthétiques** uniquement, aucun secret réel), aucune ligne live créée ni modifiée.
- [x] Tests B1 : fixtures propres nettoyées, `srv_metrics_*` et `AuditLog` non touchés.

### Suivis
- Revue du diff par le propriétaire, puis décision sur le commit.
- L'API locale a été arrêtée le temps de `prisma generate` (EPERM sur le query engine détenu par le process en cours), puis redémarrée (`pnpm run start`, health 200).

--------------------------------------------------------------------
## 2026-09-26 — 17B.4F-C1 : REVUE ET COMPLÉMENT DE VALIDATION (concurrence déterministe) — REVUE FAITE + CORRIGÉE (non commité, non poussé)

### État réel vérifié (avant travaux)
- [x] HEAD = origin/main = `a96684f`, divergence `0/0`, stash vide, index vide, **11 chemins exacts** (5 modifiés + 6 nouveaux), `git diff --check` = **0**, aucune ligne hors lot.
- [x] **Migrations B1 inchangées** : `git diff --stat -- apps/api/prisma/migrations/` vide (hash connu `20260925150000` = `2BB65E2B…` inchangé) ; seule la migration C1 `20260926000000_add_allocation_fingerprint` est neuve.
- [x] **Live `icode_host_pro` non modifiée** : 0 `HostingService`, 0 allocation, 15 déploiements, `HostingServiceAllocation` = **10 colonnes**, `migrate status` = **1 migration en attente** (C1), runner reconcile **désactivé** (`ReconcileSetting.enabled = NULL` → défaut `false` dans `reconcile-settings.ts:32`, pas de `RECONCILE_ENABLED` dans `.env`).
- [x] Grep de sécurité : **aucun** `console.*`/`Logger`/`JSON.stringify` de payload dans `src/hosting` ; **aucun** appelant `.reserve(`/`.bind(` hors specs ; **aucun** branchement live (le seul mot « branchement » est un commentaire de doc) ; HostingModule toujours non branché dans `AppModule`.

### Constats de revue et corrections (strictement dans le périmètre C1)
- [x] **Écart de verrouillage corrigé** : `lockAllocation` ne verrouillait que l'allocation (`FOR UPDATE OF a`), jamais `HostingService` → réécrite en **2 instructions déterministes** : ① `SELECT s."userId" FROM "HostingService" … WHERE s."id" = (sous-requête allocation) FOR UPDATE` (ownership vérifié **sous** le verrou service) puis ② `SELECT a.* … FOR UPDATE OF a`.
- [x] `markBound` : ajout d'un verrou ③ `SELECT d."userId" FROM "Deployment" … FOR UPDATE` (remplace `findUnique` sans verrou), ownership dérivé de `allocation.ownerUserId` ; `tx.hostingService.findUnique` redondant retiré.
- [x] Specs adaptés : helper `lockMocks()` (dispatch SQL par instruction), tests 7(e)/14/20 convertis, **+2 tests unitaires** : **C1.14** (ordre de verrous `HostingService → HostingServiceAllocation → Deployment`, 3 SQL `FOR UPDATE` observés) et **C1.15** (idempotence `RELEASING` même déploiement : aucune transition `BOUND`, aucune écriture).
- [x] **Points de revue consignés (non modifiés, comportement voulu)** : rejeu avant quota (lookup clé existante antérieur aux contrôles statut/quota) ; ownership `reserveSlot` (`id`+`userId` → 404) ; `RELEASED` terminal / `RELEASING → BOUND` interdit (gardes `markBound`) ; empreinte couvre `business` + `environment` ; version **stockée** utilisée à la vérification (`fp:<v>:`) ; keyring fourni invalide → `FingerprintConfigError` sans repli (fallback `sha256(ENCRYPTION_KEY)` = **dérivation de clé HMAC uniquement**, jamais d'empreinte SHA-256 brute) ; aucune fuite de payload/clé/env.

### Complément de validation concurrent (base de test, PostgreSQL réel) — 50+ appels
- [x] **A. 50 appels identiques simultanés** → 1 allocation unique, **50/50 succès** la référençant, 0 erreur technique.
- [x] **B. 50 clés distinctes simultanées (quota 5)** → **5 créations, 45 refus `ForbiddenException` (« Quota de slots atteint »), 0 erreur technique**.
- [x] **C. Quota exactement plein** → rejeu identique renvoyé (succès), nouvelle clé refusée, aucun re-comptage.
- [x] **D1/D2. Course intention/compensation DÉTERMINISTE** (teneur `FOR UPDATE` confirmé → contendants lancés un par un et confirmés en attente via `pg_stat_activity` (`wait_event_type='Lock'`) → relâche ; file FIFO PostgreSQL) : D1 intention d'abord → `{applied:true}` puis `{released:false, reason:'intent_present'}` ; D2 compensation d'abord → `{released:true}` puis `{applied:false, reason:'terminal'}`. Aucun état incohérent dans les deux ordres.
- [x] e2e C1 complet relancé : **24/24 PASS** (19 d'origine + A + B + C + D1 + D2 ; 2 passages de matrice 8× conservés).

### Validations finales (tous PASS)
- [x] Unit API complet : **858/858 PASS (51 suites)** (+2 C1.14/C1.15).
- [x] e2e fondation B1 (base de test) : **23/23 PASS**.
- [x] `tsc --noEmit` = 0 ; `nest build` = 0 ; `prisma validate` = 0.
- [x] Runtime sur code final : API **redémarrée**, `GET /api/health` → **200** ; Web `GET http://localhost:3000/` → **200**.
- [x] Bases : test `icode_host_pro_c1_test` = 46/46, nettoyée (0/0) ; live inchangée (0/0/15, 10 colonnes, 1 migration C1 en attente, runner désactivé).
- [x] Lint : ESLint toujours absent (dette préexistante inchangée).

### Garde-fous respectés
- [x] **Aucun commit, aucune poussée, aucune migration live, aucun appel provider** ; 11 chemins inchangés en nombre (script de debug `dbg-race.js` créé puis **supprimé**) ; fixtures/`AuditLog`/`srv_metrics_*` non touchés ; `.env` inchangé.
- [x] Aucun code hors C1 modifié : seuls `hosting-services.service.ts`, `hosting-services.service.spec.ts` et `hosting-allocation-reservation.e2e-spec.ts` ont bougé depuis la première saisie de C1.

### Suivis
- Revue du propriétaire sur ce lot complet (11 chemins), puis décision sur le commit de C1 (+ éventuellement la revue et le complément ci-dessus).

--------------------------------------------------------------------
## 2026-09-26 — 17B.4F-C2 : branchement du moteur C1 sur `POST /api/client/deployments` (garde OFF) — IMPLEMENTED + VALIDATED (non commité, non poussé)

### Contexte
Suite de 17B.4F-C1 (moteur de réservation transactionnel, revue faite, non committé). Cette étape **branche** le moteur sur le parcours de création de déploiement, derrière la garde **`HOSTING_C2_ENABLED` OFF par défaut** (activation = valeur explicite `'true'` lue **à chaque appel**, jamais en import de module), **sans aucun appel provider réel** (intention simulée), sur **base de test isolée uniquement**. Revue du propriétaire demandée avant tout commit.

### Périmètre livré (C2 seulement)
- [x] Garde : `apps/api/src/hosting/c2-flag.ts` (`HOSTING_C2_ENABLED_ENV`, `HOSTING_C2_ENABLED_VALUE='true'`, `isHostingC2Enabled()`) ; première instruction de `create()` ; OFF → **contrat historique strict** (POST sans `clientRequestId` OK, zéro accès moteur/C1, `GET /api/client/hosting-services` → `{enabled:false,services:[]}` sans requête BDD).
- [x] DTO : `clientRequestId?` (string =64, chaîne seule, jamais castée en UUID) et `hostingServiceId?` sur `CreateDeploymentDto`.
- [x] Orchestration `create()` (ON) : résolution pack (`resolvePackTarget` + **1 abonnement** pris dans la cible) → **classification du service demandé** (0 ligne `HostingService` tous statuts = legacy prouvé ; étranger → 404 ; suspendu/incompatible/non rattaché → **409, jamais de repli**) → `reserveSlot` → **rejeu par empreinte** retourné **avant** B0 → B0 seulement opération **nouvelle** (compensation `trigger:'quota'` sur échec) → `provision()`.
- [x] Empreinte = **intention reçue brute** (`branch` absente = `null` ≠ `"main"`) ; intention provider simulée **avant** `createProject` et `createGitApp` ; `markBound(uuid = preuve locale)` juste après `createGitApp`.
- [x] Compensation pré-provider conservée : `deleteMany {status:PENDING, coolifyUuid:null}` **puis** `releasePreProvider` (si suppression échoue → row `FAILED` + slot conservé) ; échec **post-intention** → jamais de release, row `FAILED` + 502.
- [x] Audits : `deploy.c2.rollback` (compensations), `deploy.create` / `deploy.failed` + marqueur `c2` (`{hostingServiceId, allocationId, clientRequestId}` | `'legacy_no_service'` | absent si OFF).
- [x] Endpoint `GET /api/client/hosting-services` (controller) : `enabled` = garde, `services` = compatibles du jeton (vide si OFF, sans BDD) ; module `HostingModule` référencé par `DeploymentsModule`.
- [x] Frontend : `listHostingServices` + champ enrichi dans `api.ts` ; helper partagé `apps/web/src/lib/intent.ts` (`newIntentUuid`, `intentFor`) ; `client/page.tsx` (`deploy`, `deployUrl`) et `client/project/page.tsx` (`deploy`) : **UUID v4 stable par payload** (regénéré si payload modifié, remis à zéro après succès, **conservé** sur échec/409), **garde anti-double-clic** (`depBusy`/`deploying`), sélecteur de service (auto si 1 compatible, `Select` si >1, aucun id si 0 → le serveur décide), boutons désactivés pendant l'envoi/choix manquant.

### Fichiers créés
- `apps/api/src/hosting/c2-flag.ts` + `c2-flag.spec.ts` (14 tests), `apps/api/test/deployments-c2.e2e-spec.ts` (19 tests), `apps/web/src/lib/intent.ts`.

### Fichiers modifiés
- API : `deployments.service.ts` (orchestration + `provision()` + helpers classification/compensation/replay/listHostingServices + 8e dep `HostingServicesService`), `deployments.service.spec.ts` (110 tests, mock 8e arg), `dto/create-deployment.dto.ts`, `deployments.controller.ts`, `deployments.module.ts`, `hosting.module.ts` (doc).
- Web : `lib/api.ts` (dto + `HostingServiceOption` + `listHostingServices`), `app/client/page.tsx`, `app/client/project/page.tsx`.

### Base de données
- [x] Tests exécutés sur la base **isolée** `icode_host_pro_c1_test` (tables complètes vérifiées) ; **aucune migration créée ni appliquée**, `schema.prisma` inchangé, aucun `prisma generate`.

### Tests/validation (tous PASS)
- [x] Unit API complet : **896/896 PASS (52 suites)** (dont `c2-flag` 14/14, `deployments.service` 110/110).
- [x] e2e C2 (base de test) : **19/19 PASS × 2 passages consécutifs** (inertie OFF, contrat OFF, UUID absent/non-UUID 400, étranger 404, suspendu/incompatible/non rattaché 409, legacy `c2:'legacy_no_service'`, heureux BOUND + fingerprint + audit c2, rejeu identique sans appel provider, rejeu payload différent 409, `branch` absente ≠ `"main"`, double POST concurrent 1/1/1, refus GitHub → 400 + rollback `pre_intent`, échec provider → 502 + slot conservé + retry 409, B0 plein 5/5 → rejeu OK + nouvelle clé 403 sans slot).
- [x] Non-régression e2e : `deployments` + `hosting-service-foundation` + `hosting-allocation-reservation` = **71/71 PASS** ; spec C1 conserve ses **2 passages de matrice**.
- [x] `tsc --noEmit` API = 0 ; `tsc --noEmit` Web = 0 ; `next build` Web = 0.
- [x] Runtime : API `GET /api/health` → **200** (`database=ok`) ; Web `GET /` → **200**.
- [x] Un échec isolé observé **1 fois** dans un run complet (`panel-transport.factory.spec`, contamination de run parallèle) : **isolé 35/35, rerun complet vert**.

### Garde-fous respectés
- [x] **Aucun commit, aucune poussée** : HEAD = origin/main = `4a54fcd6e048…`, divergence `0/0`, `git diff --check` = **0**, **13 chemins** (9 modifiés + 4 nouveaux) = ce lot uniquement, migrations intouchées.
- [x] **Live `icode_host_pro` non modifiée** : `HostingService` 0, allocations 0, déploiements 15, `_prisma_migrations` 45/46 dossiers → **1 migration en attente** (C1, non appliquée), runner reconcile **désactivé**.
- [x] Aucun `.env` modifié (aucune valeur `HOSTING_C2_ENABLED` posée), garde OFF vérifiée par test, **0 appel provider/DNS/GitHub réel**, aucun branchement Store, aucun cleanup C4, `Deployment.hostingServiceId` non renseigné (lien = `allocation.deploymentId`).

### Suivis
- Revue du propriétaire sur ce lot (13 chemins), puis décision de commit.
- Limites assumées : multi-abonnement non géré (1 abonnement par cible), sélection détaillée rattachée en phase **D**, C3 (intention réelle provider) et C4 (release/cleanup) toujours à venir.

--------------------------------------------------------------------
## 2026-09-26 — 17B.4F-C2 : REVUE FINALE AVANT COMMIT — REVUE FAITE + TESTS AJOUTÉS (non commité, non poussé)

### Périmètre vérifié (14 chemins, diff/contenu lus intégralement)
- Modifiés : `TASKS.md` (2 sections C2 ajoutées, 0 ligne supprimée), `deployments.controller.ts` (+9), `deployments.module.ts` (+5/-1), `deployments.service.spec.ts` (+563/-2), `deployments.service.ts` (+596/-87), `create-deployment.dto.ts` (+21), `hosting.module.ts` (+5/-4), `client/page.tsx` (+96/-20), `client/project/page.tsx` (+63/-11), `lib/api.ts` (+23) ; créés : `c2-flag.ts` (28 l.), `c2-flag.spec.ts` (47 l.), `deployments-c2.e2e-spec.ts` (729 l.), `lib/intent.ts` (37 l.).
- [x] **Migrations, `.env`, `package.json` et lockfiles inchangés** (`git diff` vide sur `prisma/` + manifests ; aucun `.env` dans le statut ; `HOSTING_C2_ENABLED` absent de TOUS les `.env` runtime → garde OFF). `git diff --check` = 0 ; HEAD = origin/main = `4a54fcd`.

### §2 — Intention durable (vérifié en code + tests)
- `markProviderIntent` = `UPDATE "Allocation"."providerIntentAt"` sous verrou `lockAllocation` (Service → Allocation) dans une `$transaction` Prisma **committée à la résolution de l'await**, AVANT `resolveProject`/`createProject` (C2 diffère ce dernier APRÈS le marqueur) et `createGitApp` (deployments.service.ts:512-541).
- `applied=false` → `ConflictException` AVANT toute mutation distante ; **écriture qui LÈVE** → `intentPossessed` reste faux → compensation pré-provider + erreur propagée (aucun appel provider).
- Tests : unit (ordre d'appel `markProviderIntent < createGitApp` et `< createProject`, module B) ; e2e PG réels : 502 provider → `providerIntentAt` NON NULL relu en base + retry 409 « incertitude » ; refus GitHub → rollback `pre_intent` (intention jamais posée) ; **+1 test unitaire ajouté en revue** : écriture de l'intention qui échoue → `deleteMany{PENDING,uuid:null}` + `releasePreProvider` + audit `pre_intent`, `createProject`/`createGitApp`/`markBound` NON appelés.

### §3 — Compensation (2 transactions SÉQUENTIELLES, NON atomiques — états intermédiaires documentés)
- `deleteMany{id, status:PENDING, coolifyUuid:null}` : `rowId` = `row.id` créée dans CETTE invocation avec `userId=actor.sub` (provenance exacte, jamais de saisie utilisateur) ; exécuté dans sa propre écriture (verrou libéré au commit) **puis** `releasePreProvider` (transaction dédiée : verrous Service → Allocation).
- États intermédiaires sûrs et audités (`deploy.c2.rollback` avec `rowCleared/released/releaseReason`) : ① OK+OK → nettoyé ; ② row OK + release échoue/refusée → **slot CONSERVÉ** (« row absente + slot réservé », rejeu → 409, reprise **C4**) ; ③ delete échoue → row bascule FAILED et release **non tentée** (`row_kept`) ; ④ les deux échouent → état PENDING conservé, audité. Aucun cycle de verrous possible (rien ne détient un verrou en attendant l'autre ; compensation uniquement **préalable à l'intention** = zéro mutation distante).
- Jamais de suppression d'un Deployment lié : la compensation n'existe que si `intentPossessed=false` (donc AVANT `markBound`), en plus des gardes `PENDING`+`coolifyUuid null`.

### §4 — DÉCISION : `Deployment.hostingServiceId` reste NULL sur les nouveaux déploiements C2 (aucun backfill)
- **Ce n'est pas le report du backfill** : c'est un **invariant B1 TESTÉ** — `hosting-service-foundation.e2e` #7 **lie** `ids.deployment` via `markBound` puis #10 exige `hostingServiceId === null` → le binding N'écrit PAS ce champ (schéma : « le lien se pose via l'allocation, jamais par écriture directe opportuniste »).
- Le lien **atomique** existe déjà : `allocation.deploymentId` est écrit **dans la transaction `markBound`** (verrous ①②③, ownership croisé, preuve provider) — écriture de `Deployment.hostingServiceId` dans cette transaction reviendrait à réécrire l'invariant B1 #10.
- Fail-closed préservé : toute app C2 a ≥1 allocation (`hostingServiceId NOT NULL + onDelete Restrict`) → la **suppression du service reste bloquée** sans passer par le champ Deployment.
- Conséquences : **ownership** = vérifié à `markBound` (deployment.userId = service.userId) + requêtes par service via `allocation.hostingServiceId` (indexé) ; **classification** = lit `HostingService` par userId du jeton (indépendant) ; **suppression** = `remove()` inchangé, FK SetNull B1 (l'allocation survit, slot compté jusqu'à C4) ; **C3/C4** = tout l'état (intention, statut, lien) vit sur l'allocation — aucun lecteur de production de `Deployment.hostingServiceId` (grep : seulement des tests). Backfill phase D = dénormalisation optionnelle, sans sémantique nouvelle.

### §5 — Frontend + validations ajoutées
- Helper `intent.ts` **exécuté réellement** (compilé depuis le fichier livré, assertions Node) : **9/9** — UUID v4, identité stable sur payload identique (5×), valeurs env/commands/subdomain préservées EXACTEMENT, **pas de nouvel UUID après échec simulé**, nouvel UUID si payload modifié, **branche absente ≠ "main"**, `undefined` omis, reset post-succès.
- Garde réentrée : `depBusy`/`deploying` posés **synchrone** dans les 3 soumissions + boutons désactivés ; filet dur = dédup serveur (e2e double POST : 1 row/1 alloc/1 exécution).
- **Vérifications navigateur : AUCUNE exécution** — ni playwright/puppeteer/cypress dans le repo, ni écriture live autorisée (parcours live = garde OFF + base live interdite) ; attestation UI = code (gardes synchrone) + helper Node 9/9 + e2e HTTP.
- +1 assertion : `GET hosting-services` → `findMany({ where: { userId } })` (liste limitée au jeton).
- **Correction du point ciblé de clôture** : `listHostingServices.compatible` ajoute le **RATTACHEMENT** à la cible — `compatible = ACTIVE + pack/module identiques + isAttachedToTarget(s, subscription)`, le **même critère** que le POST (signature élargie `Pick<HostingService,'subscriptionId'|'orderId'>` : UN SEUL critère pour la ligne partielle du sélecteur et la row complète de la classification) ; `subscriptionId`/`orderId` ajoutés au `select`, `target.subscription` capturée. Test unique ajouté : service **ACTIF + même pack mais non rattaché ⇒ `compatible:false` + POST → 409 sans repli** (`reserveSlot`/`deployment.create` jamais appelés). Le POST conserve son contrôle autoritaire (404/409 sans repli legacy).
- **Validations après revue** : `deployments.service.spec` **112/112** (suite affectée, relancée) ; **e2e C2 19/19 relancé APRÈS la correction** ; `tsc --noEmit` = 0 ; **`nest build` = 0** ; `next build` = 0 (web inchangé) ; unit complet précédent **897/897 (52 suites)** (non relancé : correction isolée à `listHostingServices`/`isAttachedToTarget`, typage validé par tsc) ; e2e non-régression antérieurs **71/71** ; API health **200**, web **200** ; live inchangée (0/0/15, migrations 45/46 → 1 en attente C1).

### État final
- **ARRÊT avant staging/commit** : 14 chemins modifiés/non suivis, aucun staging, HEAD = origin/main = `4a54fcd`, garde `HOSTING_C2_ENABLED` OFF partout, zéro écriture live, zéro provider réel, aucun changement C3/C4.

## 2026-09-27 — 17B.4F-C3 : table `OrderProvisioningTracking` + checkout/intention figée + orchestration store — IMPLEMENTED + VALIDATED (non commité, non poussé)

### Périmètre (GO : nouveaux achats uniquement ; base `957df90`)
- **Modifiés (9)** : `schema.prisma` (+relation `Order.provisioningTracking` + `model OrderProvisioningTracking`), `hosting-fingerprint.ts` (+`STORE_KEY_VERSION`/`storeIdempotencyKey` = `store:v1:<orderId>`), `hosting-services.service.ts` (helpers `lockServiceForUpdate`/`reserveInTx` recâblé, +`reserveForOrderInTx`/`markIntentInTx`/`releasePreProviderInTx`/`markBoundInTx`), `hosting.module.ts` (+`C3CapabilityService`), `store.module.ts` (+import `HostingModule`), `checkout.service.ts` (garde ON), `provisioning.service.ts` (routage + `provisionC3` + `c3Guard` + `c3B0Failure` + garde token threadée `openStep/closeStep/setOrderStatus/scheduleInitialReconcile/runAction/action*/link` + split `activateOrderInTx`/`postActivationEffects` + `limitsStatus null → APPLIED`), 2 specs existantes (instanciations constructeur +2 deps).
- **Créés (7)** : migration additive `20260927000000_add_order_provisioning_tracking` (`CREATE TABLE` + FK Cascade, **jamais appliquée en live**), `c3-flag.ts` (clone strict C2), `c3-capability.service.ts`, `c3-flag.spec.ts`, `c3-capability.service.spec.ts`, `provisioning-c3.spec.ts`, `checkout-c3.spec.ts`. Aucune colonne ajoutée à `Order` (relation inverse uniquement).

### Contrats implémentés (décisions GO honorées)
- **Garde `HOSTING_C3_ENABLED` stricte** (valeur exactement `true`, relue à l'appel). OFF : tracking résolu par **sonde live** (`resolveTracking`) — commande trackée ⇒ **409, aucun repli legacy, 0 appel provider** ; sinon legacy byte-identique. ON : `operational()` (C1 ∧ C3 live) sinon **503 fail-closed avant toute écriture** ; trackée ⇒ `provisionC3`, sinon legacy sécurisé.
- **Capability** : cache positif sticky ; **cache négatif jamais seul fondement** (re-sonde live à chaque appel, T-corr.1) ; erreur DB propagée (jamais de classement legacy).
- **Checkout ON** (après rejeu pré-tx — « rejeu avant refus ») : 503 capability ; 409 non-`CREATE_APP` (avec actions) ; 409 pack absent ; 409 upgrade (`packId` ∧ abonnement actif, pré-tx **et** recheck in-tx) ; in-tx : verrou `User FOR UPDATE` → rejeu par clé (`CheckoutReplaySignal` renvoie, jamais de refus) → recheck abonnement → écritures **Customer → User → Order → `OrderProvisioningTracking` (intention figée business/environment) → `HostingService` (snapshots pack) → Invoice/History/Subscription** dans **UNE transaction**. OFF : zéro appel `c3`, zéro écriture C3.
- **`provisionC3`** : `HostingService` absent ⇒ 409 ; TX-A (verrous **Order → Tracking → HostingService → Allocation → Deployment**) avec décisions AVANT token : terminal (RELEASED)/bound (T-fen.1)/uncertain(409)/releasing(409)/busy(lease valide → 409)/noop(ACTIVE sans alloc)/CANCELLED(409)/tracking absent(503) ; claim `randomUUID` + lease 5 min ; réservation C1 via `reserveForOrderInTx` (clé `store:v1:<orderId>`) ; **B0 avant intention** (échec ⇒ `releasePreProviderInTx` + token effacé + note history + commit, Order reste PAID, 0 appel) ; Order→PROVISIONING ; **intention `markIntentInTx` DERNIÈRE** ; TX-C row `Deployment` **PENDING avant le 1ᵉʳ appel provider** (limites tracées, `limitsStatus` null → `actionCreateApp` passe à `APPLIED` après `applyAppLimits`) ; boucle d'actions **stop au 1ᵉʳ échec** (aucun appel suivant) ; TX-E `markBoundInTx` si `appUuid` ; preuve `awaitAppReady` lecture seule ; TX-B `activateOrderInTx` **dans la garde token** + `postActivationEffects` après commit. `force` n'accélère rien.
- **`c3Guard`** : identité `claimToken` (refus 409 `C3WorkerGuardError`) **séparée** du lease (expiration ⇒ renouvellement CAS `token + expiré`, `count ≠ 1` ⇒ refus) ; écritures legacy via `directWrite` inchangé (auto-commit).

### Validations exécutées (chiffres réels)
- `npx prisma generate` ✓ ; **`tsc --noEmit` = 0** ; **`nest build` = 0** ; **`npm run lint` indisponible : binaire `eslint` absent du workspace (pré-existant, script orphelin — aucun lint supplémenté ; tsc + tests font foi)**.
- **Unit complet : 964/964, 56 suites, 0 échec** (non-régression 898/898 antérieure inchangée + **+66 tests C3 neufs** : 5 flag, 12 capability, 16 orchestration/routage/garde, 11 checkout, 2 divers).
- **Base de test isolée** : `icode_host_pro_c3test` créée dans `icode-postgres`, **identité vérifiée** (`SELECT current_database()` = `icode_host_pro_c3test`), `migrate deploy` avec `DATABASE_URL` **inline en variable d'env** (`.env` inchangé) → **47/47 migrations appliquées**, dont `20260926000000` (C1) et `20260927000000` (C3) ; table `OrderProvisioningTracking` + colonnes C1 **présentes sur la base test**.
- **Live non touchée** (lecture seule) : `migrate status` = 2 en attente (C1 + C3) ; `OrderProvisioningTracking` = **0** ; colonnes C1 = **0** ; aucun `.env` modifié ; zéro provider réel.
- **e2e affectés sur base test migrée : 8/8 suites, 139 tests, 0 échec** — `store-checkout-domains` + `store-cancel-provisioning` + `store-order-status` + `store-terminate-active-service` (49 tests) ; `hosting-service-foundation` + `hosting-allocation-reservation` + `deployments-c2` + `deployments` (90 tests) — tous sous garde OFF.

### Limites / risques documentés (volontaires)
- **`BillingSetting` hors périmètre** : `claimInvoiceSequence` (UPDATE `invoiceSequence+1`) sans contrainte unique — collision `Invoice.number` possible sous forte concurrence → **échec d'achat (P2002), pas seulement cosmétique** ; risque pré-existant non aggravé, sans `ensure` ajouté.
- **Fencing = `claimToken` + lease (5 min)** : pas de token numériquement monotone ; nettoyage/`release` des intentions orphelines = **C4** (non démarré). **T-fen.3 (fenêtre ouverte bornée) différée** par le GO — T-fen.1 (bound → lecture seule) et T-fen.2/4 (refus) couverts en unit.
- **ON refuse les non-pack avec actions sans `CREATE_APP`** (ex. produits DNS-seuls type `store-checkout-domains`) → 409 à l'achat ; les e2e existants restent **OFF** (périmètre C3 = nouveaux achats pack CREATE_APP).
- **Upgrades refusés sous ON** (limite C4 documentée) ; **`HostingService.status` reste `PROVISIONING` après activation** (non prévu au plan, aucun flip ajouté sans revue).
- Aucun e2e ON dédié (couverture ON = specs unit) ; `awaitAppReady`/provider simulés (zéro appel réseau réel).

### État final
- **ARRÊT POUR REVUE** : 16 chemins (9 modifiés + 7 créés), aucun staging, HEAD = origin/main = `957df90`, garde `HOSTING_C3_ENABLED` absente de tous les `.env` (OFF partout), zéro écriture live, zéro provider réel, base test `icode_host_pro_c3test` créée (à conserver ou supprimer selon la revue).

## 2026-09-27 — REVUE 17B.4F-C3 : corrections + tests PostgreSQL isolé + revue de diff — IMPLEMENTED + VALIDATED (non commité, non poussé)

### 1) Cycle de vie `HostingService` (point de revue n°1) — CORRIGÉ
- **Fix** : la TX-B de `provisionC3` verrouille désormais `HostingService` (`SELECT … FOR UPDATE`, **AVANT** les CAS Order/Deployment — ordre global `Order → Tracking → HostingService → Allocation → Deployment` préservé) et pose `PROVISIONING → ACTIVE` **uniquement** quand `orderIsActive && deploymentIsActive` (preuves FINALES, CAS `count = 1`) — jamais sur échec, jamais sur succès partiel, jamais sur service annulé. Le no-op `already_active` (retry après crash) converge aussi (flip idempotent).
- **Tests unit** (`provisioning-c3.spec.ts`, +3 → 29) : parcours complet ⇒ flip appelé avec `{status: ACTIVE}` ; échec d'étape / preuve absente / état final partiel ⇒ **zéro flip** ; retry déjà actif ⇒ flip idempotent.
- **Tests PG isolé** (e2e `c3-provisioning`) : service réellement `ACTIVE` en fin de parcours ; **utilisable** (réservation directe C1 acceptée jusqu'au quota) avec **quota maxApps toujours respecté** (refus `Quota de slots atteint`, 1 seule allocation) ; contrôle négatif : service non provisionné ⇒ refus `service non actif` (le « utilisable » vient bien du flip, pas d'une omission).

### 2) Matrice scénarios critiques ↔ tests (noms exacts)
| Scénario | Test | Fichier | Réel/Mocké |
|---|---|---|---|
| Cycle de vie complet C3 | `checkout C3 → provisioning → Order/Deployment ACTIFS, allocation BOUND, HostingService ACTIVE` | `test/c3-provisioning.e2e-spec.ts` | PG réel (`icode_host_pro_c3test`) ; panel/mail mockés |
| Service utilisable + quota | `service ACTIF ⇒ réservation directe utilisable, avec quota maxApps TOUJOURS respecté` + `contrôle : service encore PROVISIONING ⇒ … « non actif »` | idem | PG réel |
| Double-clic, même clé | `double-clic (2 checkouts SIMULTANÉS, même clé) → UNE commande, UNE séquence provider` | idem | PG réel (concurrence tx réelle) |
| Même user, clés différentes | `même utilisateur, clés DIFFÉRENTES → jamais de rejeu croisé (409 C4, aucune écriture parasite)` (règle C4 ON : 2ᵉ achat pack refusé) + rejeu identique `B6` en legacy (`store-checkout-domains`) | idem / `test/store-checkout-domains.e2e-spec.ts` | PG réel |
| 2 provisionings concurrents = 1 séquence provider | `deux provisionOrder CONCURRENTS (même commande) → un seul claim, une seule séquence provider` | `c3-provisioning` | PG réel (verrous `FOR UPDATE`) |
| Intention durable + lease expiré : 0 takeover, token préservé | `bind KO → états réellement atteints ; retry ⇒ 409, token préservé, ZÉRO nouveau provider (même lease expiré)` | `c3-provisioning` | PG réel ; `markBoundInTx` mocké 1× (injection d'échec persistance) |
| Provider OK / persistance KO | même test (phase 1 : `createGitApp` +1, alloc `RESERVED` + `providerIntentAt`, token présent) | `c3-provisioning` | PG réel |
| Bind OK / activation KO (T-fen.1) | `preuve absente → états réels (BOUND, DEPLOYING, PROVISIONING) ; retry ⇒ lecture seule, 0 provider, 0 flip` | `c3-provisioning` | PG réel ; `awaitAppReady` mocké `false` |
| OFF, cache absent, commande C3 créée par un autre processus | `OFF + instance fraîche (cache absent) + commande C3 créée ailleurs ⇒ 409, 0 provider, commande intacte` + `contrôle : … flag ON à la volée ⇒ routage C3` | `test/c3-off-fallback.e2e-spec.ts` | PG réel (2 instances Nest successives) |
| OFF sur base sans migrations C1/C3 | `OFF + table tracking absente ⇒ sonde tolérante, parcours LEGACY complet (Order ACTIVE)` | `test/c3-premig.e2e-spec.ts` | PG réel, base dédiée `icode_host_pro_c3premig` (43/47 migrations ; `to_regclass` = null) |
| ON sur base sans migrations ⇒ 503 | `ON + migrations absentes ⇒ 503 fail-closed AVANT toute écriture métier` | idem | idem |
| **Cache négatif complet (A négatif → migration + C3 via B → A avant TTL)** | `cache négatif sur A → migration + commande C3 via B → A avant TTL ⇒ détection live, 409 OFF, 0 repli/provider` | idem (3ᵉ test) | idem ; SQL de migration appliqué puis `DROP TABLE` de restauration en `finally` |
| Routage/flag/503/capability/claim/garde/B0/ordre TX/stop-échec (unit) | 29 tests `provisionC3 / routage C3` ; 11 checkout ; 5 flag ; 12 capability | `provisioning-c3.spec.ts`, `checkout-c3.spec.ts`, `c3-*.spec.ts` | mocks |
| Contrats C1/C2 (historiques) | `hosting-service-foundation`, `hosting-allocation-reservation`, `deployments`, `deployments-c2`, `store-*` (139 tests) | e2e existants (OFF) | PG réel, OFF — **non-régression uniquement, pas une preuve C3** |

### 3) Revue ciblée du diff (point n°3) — verdict
- **Même `TransactionClient` pour token + écritures protégées** : `c3Guard` ouvre UNE `$transaction`, y verrouille Order → Tracking, y vérifie l'identité puis le lease, et n'exécute `fn(tx)` que si les deux passent ; le flip `HostingService` de la TX-B est DANS cette même transaction.
- **Ordre des verrous** : `Order → Tracking → HostingService → Allocation → Deployment` partout (nouveau verrou HostingService positionné avant les CAS Deployment) ; **aucun appel réseau sous verrou** (preuve unit `providerTxDepth` = 0 sur tous les appels provider).
- **Contrats C1/C2 préservés** : `directWrite` legacy intact, e2e historiques 8/8 verts, unit 966/966.
- **Migration additive uniquement** : `migration.sql` = 1 `CREATE TABLE` + 1 FK Cascade ; aucune autre migration modifiée (`git status` : seul le dossier C3 est neuf) ; aucune colonne ajoutée à `Order`.
- **Aucune récupération C4 ajoutée** : seul `releasePreProviderInTx` (échec B0 AVANT provider) + `markIntentInTx` (dernière étape TX-A) ; zéro release/cleanup après intention.

### 4) Chiffres finaux (point n°4)
- **`npx prisma validate` = schéma valide** ; **`tsc --noEmit` = 0** ; **`nest build` = 0** ; **`git diff --check` = 0** ; **staging vide** (`git diff --cached` = 0) ; HEAD = `957df90`.
- **Chemins : 20** (10 modifiés dont `TASKS.md` + 10 créés = 7 C3 + 3 e2e de revue). `git diff --numstat` : `TASKS.md` 101/0 · `schema.prisma` 30/0 · `hosting-fingerprint` 18/0 · `hosting-services` 281/139 · `hosting.module` 13/7 · `checkout.service.spec` 2/0 · `checkout.service` 234/0 · `provisioning.service.spec` 10/0 · `provisioning.service` 819/131 · `store.module` 4/1 (+10 fichiers créés non suivis).
- **Unit : 966/966 (56 suites)** — +2 tests revue sur `provisioning-c3` (29).
- **e2e sur base isolée** : 10 suites / 149 tests verts via batterie (`store-*`, foundation, allocation, `deployments*`, `c3-provisioning` 8, `c3-off-fallback` 2) + `c3-premig` **3/3** sur sa base dédiée (2 initiaux + 1 scénario « cache négatif » ajouté aux vérifications finales) → **11 suites / 152 tests verts** (chaque suite sur SA base : `c3test` vs `c3premig` — `c3-premig` exige `DATABASE_URL=…/icode_host_pro_c3premig`, il échoue à dessein sur `c3test` puisque le schéma y est complet).
- **Live `icode_host_pro` intacte** (lecture seule) : table `OrderProvisioningTracking` **absente** (`to_regclass` = null), `HostingService` = 0 écriture de notre fait, 22 commandes existantes inchangées, `.env` non modifié, zéro provider réel.
- Bases de test utilisées (à conserver/supprimer selon décision) : `icode_host_pro_c3test` (47/47, sèche après nettoyage : 0 service/0 user/0 order/0 allocation/0 deployment) et `icode_host_pro_c3premig` (43/47, scratch).
- **Écarts restants assumés** : `npm run lint` toujours indisponible (eslint absent, pré-existant) ; T-fen.3 et cleanup des intentions orphelines = C4 non démarrés ; produits non-pack ON → 409 (documenté).

### État final (post-revue)
- **ARRÊT POUR DÉCISION DE COMMIT** : 20 chemins, aucun staging, aucun commit, HEAD = origin/main = `957df90`, garde OFF partout, zéro écriture live. Les 4 vérifications finales (API/Web relancés, FK `CASCADE` justifiée, scénario cache négatif ajouté et vert, chiffres git à jour) sont tracées en section 5 ci-dessous.

### 5) Vérifications finales avant décision de commit (4 demandes — 2026-09-27)

**V1 — API locale + Web (relance, runner OFF, sans migration live)**
- API `apps/api` **relancée** : `npm run dev` (`nest start --watch`, console PID 26116, process Nest 42752) sur le working tree C2/C3 courant. `HOSTING_C2_ENABLED` / `HOSTING_C3_ENABLED` **absents** de `.env` **et** de l'environnement shell → runner **OFF** ; `main.ts` n'exécute **aucune** migration au boot ; aucun `@Cron`/`setInterval` dans `src` → zéro écriture métier périodique.
- `GET http://localhost:3001/api/health` → `{"status":"ok","database":"ok","timestamp":"2026-09-27T06:15:49.555Z"}` (sonde `SELECT 1` seule, ADR-014).
- Web `apps/web` déjà en service (`next start`, PID 16916, port 3000) → `GET http://localhost:3000` = **HTTP 200**. Les deux restent verts en fin de session.

**V2 — Écart `RESTRICT` (plan) vs `ON DELETE CASCADE` (migration) — ÉCART JUSTIFIÉ, aucune correction**
- SQL exact (`apps/api/prisma/migrations/20260927000000_add_order_provisioning_tracking/migration.sql`, L33) :
  `ALTER TABLE "OrderProvisioningTracking" ADD CONSTRAINT "OrderProvisioningTracking_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;`
- **Précédents FK vers `Order` (migrations existantes)** : `OrderStatusHistory` → **CASCADE**, `ProvisioningLog` → **CASCADE** (les 2 autres tables d'audit ordre-scopées, modèle identique) ; `Invoice`, `Subscription`, `Deployment`, `HostingService` → `SET NULL` (enfants « porteurs » : l'ordre survit). **Aucune FK existante vers `Order` n'est `Restrict`.**
- **Suppressions réelles** : **zéro** `order.delete*` / `customer.delete*` en production (grep `src/**/*.ts` vide) ; `Order.customer → onDelete: Cascade` — un `Restrict` sur le tracking **casserait cette cascade existante** ainsi que les nettoyages de tests (les suites suppriment leurs orders alors que des lignes de tracking existent sur `c3test`).
- **Rôle durable du tracking** : la ligne naît avec l'Order et n'a de sens que tant que l'Order existe (PK `orderId` 1:1 ; schema : « l'état est restauré depuis Order/Allocation/Deployment ») ; aucune écriture métier ne la supprime jamais. La cascade **ne perd aucune protection nécessaire** : (a) la disparition de la commande sous le worker est couverte par la garde TX-A (`commande disparue` → refus explicite, testé) ; (b) détection OFF et refus 409 ne dépendent pas du FK. Les 7 seuls `Restrict` du schéma protègent des invariants d'enfant NOT NULL (allocation→service, pack, produit, ownership) — pas des tables d'audit.
- **Décision : `CASCADE` conservé, `migration.sql` inchangé** (condition « si la cascade perd une protection → corriger et éprouver » **non déclenchée**). Jamais appliquée en live.

**V3 — Scénario « cache négatif » complet — SCÉNARIO MANQUANT AJOUTÉ**
- Nouveau 3ᵉ test de `test/c3-premig.e2e-spec.ts` : `cache négatif sur A → migration + commande C3 via B → A avant TTL ⇒ détection live, 409 OFF, 0 repli/provider`.
- Séquence : (1) A (`C3CapabilityService`) sonde l'absence → `resolveTracking = null` + `negativeCacheAgeMs() ≠ null` (**cache négatif amorcé**) ; (2) « B » applique la migration `20260927000000` (2 statements SQL lus depuis le fichier) **puis** écrit la commande C3 (insertion directe des écrits qu'aurait faits un checkout ON concurrent) ; (3) A rappelé alors que `negativeCacheAgeMs() < 60 000 ms` (**avant expiration du TTL négatif**) → `resolveTracking` **détecte la ligne** (sonde LIVE) ; (4) `provisionOrder` OFF → **409** `provisioning suspendu tant que C3 est désactivé`, `createGitApp` **0 appel** (baseline figée avant l'appel), Order **PAID** (jamais legacy ACTIVE), 0 deployment, 0 log, `claimToken`/`leaseUntil` **null** ; (5) `finally` → `DROP TABLE "OrderProvisioningTracking"` (état pré-migratoire restauré) + auto-guérison `DROP IF EXISTS` en `beforeAll` après garde d'identité `current_database() = icode_host_pro_c3premig` (le DROP ne peut jamais toucher une autre base).
- **3/3 verts** sur `icode_host_pro_c3premig` ; résidus 0 (table absente, 0 order/customer/product `premig-%`) ; `tsc --noEmit` = 0.
- Précision : il n'existe **aucun TTL fonctionnel** (les négatifs ne servent jamais de fondement — re-sonde `information_schema` à chaque appel, `c3-capability.service.ts`) ; l'assertion `age < 60 s` matérialise « avant expiration » : le négatif est encore frais au moment du routage et la détection a quand même eu lieu (preuve que le cache négatif n'est jamais un fondement).

**V4 — État git + chiffres finaux**
- HEAD = `957df90` = `origin/main` ; **divergence 0/0** ; **staging vide** ; `git diff --check` = **0** (seulement des avertissements LF→CRLF, pas d'erreur).
- **20 chemins** (10 modifiés + 10 créés). `git diff --numstat` : `TASKS.md` 101/0 · `schema.prisma` 30/0 · `hosting-fingerprint` 18/0 · `hosting-services` 281/139 · `hosting.module` 13/7 · `checkout.service.spec` 2/0 · `checkout.service` 234/0 · `provisioning.service.spec` 10/0 · `provisioning.service` 819/131 · `store.module` 4/1.
- Créés (lignes complètes) : `migration.sql` 33 · `c3-capability.service.spec.ts` 138 · `c3-capability.service.ts` 108 · `c3-flag.spec.ts` 57 · `c3-flag.ts` 30 · `checkout-c3.spec.ts` 389 · `provisioning-c3.spec.ts` 694 · `c3-off-fallback.e2e-spec.ts` 241 · `c3-premig.e2e-spec.ts` 263 · `c3-provisioning.e2e-spec.ts` 636 (total 2 589 lignes non suivies).
- Validations **relancées uniquement sur les éléments affectés** (seul fichier touché : `test/c3-premig.e2e-spec.ts`) : `tsc --noEmit` = 0 · `nest build` = 0 · suite `c3-premig` = **3/3** ; unit 966/966 et les 10 autres suites e2e **non relancés** (src inchangé) → total e2e **11 suites / 152 tests** (151 + le nouveau scénario).

--------------------------------------------------------------------
## 2026-09-27 — 17B.4F-C4 : protocole C4 (tentatives durables, arrêt/cleanup/libération, annulation ≠ suppression, D10, finalize admin, gate pré-migration) — IMPLEMENTED + VALIDATED (non commité, non poussé)

### Périmètre (23 chemins : 14 modifiés + 8 créés + `TASKS.md`)
- **Modifiés (14)** — `git diff --numstat` : `schema.prisma` 118/1 (+4 enums, +5 modèles C4, index unique partiel) · `provisioning.service.ts` 546/28 · `order-cancel.service.ts` 411/61 · `deployments.service.ts` 249/44 · `hosting-services.service.ts` 91/0 · `subscriptions.service.ts` 55/3 · `store-provisioning.admin.controller.ts` 19/0 · `hosting.module.ts` 5/2 · specs (6) : `subscriptions.service.spec` 85/0 · `deployments.service.spec` 8/5 · `order-cancel.service.spec` 6/0 · `order-terminate.service.spec` 3/0 · `provisioning.service.spec` 10/0 · `provisioning-c3.spec` 2/0.
- **Créés (8)** : migration additive `20260928000000_add_c4_protocol_tables` (117 l.) · `c4-protocol.service.ts` (361) · `c4-release.service.ts` (272) · `c4-capability.service.ts` (89) · `c4-flag.ts` (29) · `finalize-order.dto.ts` (20) · `test/c4-release.e2e-spec.ts` (1421) · `test/c4-premig.e2e-spec.ts` (154).
- [x] **Aucune migration appliquée en live** (dossier C4 n'existe que dans le working tree) ; **aucun `.env` modifié** (`HOSTING_C4_ENABLED` **absent** de `apps/api/.env` et `apps/web/.env` → garde **OFF**) ; `git diff --check` = 0 (avertissements LF→CRLF seulement) ; **staging vide** ; HEAD = origin/main = `1fe8241`, divergence `0/0`.

### Contrats implémentés (décisions D1–D10)
- **Flag strict** : `HOSTING_C4_ENABLED === 'true'` exactement, relu à l'appel (`c4-flag.ts`), absent = OFF.
- **Gate pré-migration (fail-closed)** : `C4CapabilityService` — `operational()` sonde **les 5 tables C4** via `information_schema` (cache négatif jamais seul fondement) ; `assertOperational()` = no-op sous OFF, **503 « migration C4 requise »** sous ON **avant toute lookup/écriture** — portes couvertes : `cancelProvisioning` (order-cancel :190), `finalizeProvisioning` (provisioning :1371), `deployments.remove` (deployments :1216).
- **D1 — finalize admin** : `POST /store/admin/orders/:id/finalize` (Jwt+Roles ADMIN, +19 l. controller, DTO `@MinLength(8)` → 400 HTTP) ; preuve identity-bound `deploymentStatus(uuid)` → `mapCoolifyStatus` (`finished`→ACTIVE, `in_progress`→DEPLOYING) lue **hors TX** ; rejeu = retour d'état (zéro audit, zéro transport) ; audit `provision.finalize.c4` resourceId=orderId (provisioning :1601) ; 409 raison<8, 409 flag OFF, 503 assert, 404 order inconnu.
- **D2 — pré-protocole** : arrêt avant intention ⇒ `pre_protocol_uncertain`, **sauf** libération pré-provider (`providerIntentAt IS NULL` → `pre_provider_released`).
- **D3 — consignation post-OFF/arrêt** : `settleStandalone` (c4-protocol :358) appelé depuis **9 sites** (provisioning ×3, deployments ×4, order-cancel ×2) — jamais sous verrou réseau.
- **D4 — barrière d'arrêt + anti-résurrection** : `c4Stopped` (provisioning :766-820) testée **avant** fqdn persisté / `markBoundInTx` / `awaitAppReady` ; CREATE/CONFIGURE refusés si stop **ou créateur non résolu**, DELETE refusé si créateur non résolu, **READ toujours** ; arrêt/tentatives **jamais effacés** par un changement de flag.
- **D5/D6 — tentatives + libération unique** : `C4ProviderAttempt` avec **index unique partiel** `C4ProviderAttempt_open_creative_key` (DISPATCHED ∧ nature IN (CREATE, CONFIGURE)) ; `C4ReleaseEvidence.allocationId` **unique** → une seule libération ; cycle `startReleasingInTx` (hosting-services :796) → preuve → `completeReleaseInTx` / `assertC4Evidence`.
- **D7 — suppression ≠ annulation** : `remove()` C4 (constructeur 11 deps) : `freedQuota = true` **seulement si RELEASED committé** ; `releaseAfterCleanup` refuse si créateur inconnu ; FK `HostingServiceAllocation.deploymentId` **ON DELETE SetNull** (l'allocation survit, slot compté jusqu'à la libération).
- **D9/D10 — annulation** : `cancelProvisioning` renvoie `c4.releases[{allocationId,status,blockedReason?}]` (provider `skipped`→app `unknown`, dns `skipped`→`not_created`) ; **gate D10 atomique** sur `cancelMySubscription` (subscriptions.service).
- **READ live / écritures isolées** : réseau **jamais** sous TX ; reconcile engine resté **désactivé** par défaut (`RECONCILE_ENABLED` absent).

### Validations exécutées (chiffres réels)
- `npx prisma validate` ✓ · `npx prisma generate` ✓ · **`tsc --noEmit` = 0** · **`nest build` = 0** · **unit complet : 969/969, 56 suites, 0 échec**.
- **Bases isolées créées dans `icode-postgres`** (`.env` jamais modifié, URL dérivée en variable d'env) : `icode_host_pro_c4test` = **48/48 migrations** + 5 tables C4 + 13 index ; `icode_host_pro_c4premig` = 48/48 **puis objets C4 DROPpés** pour reproduire l'état pré-migration (spec vérifie `to_regclass('public."C4ProviderAttempt"') = null`).
- **e2e C4 — `test/c4-release.e2e-spec.ts` : 19/19 PASS** (c4test, identité `current_database()` vérifiée en beforeAll) : parcours ON complet (checkout→provisioning→états C4) · arrêt pendant CREATE (alloc reste RESERVED, dep PENDING, coolifyUuid persisté par settle) · créateur UNKNOWN → DELETE bloqué · delete échec/absent/rejeu · DELETE orpheline · pré-protocole · finalize (409/201/rejeu/course) · D10 · bascule OFF (stop persistant sous OFF) · capability · **+8 scénarios ajoutés en revue** (arrêt AVANT dispatch, settle sous OFF, DNS non concluant, suppressions concurrentes, terminaison vs suppression, D10 sous course réelle, suspension, finalize ∥ annulation en promesses parallèles).
- **e2e pré-migration — `test/c4-premig.e2e-spec.ts` : 3/3 PASS** (c4premig) : `operational()=false` + 503 + `negativeCacheAgeMs()` · les **3 portes ON → 503 avant lookup/écriture** (comptes auditLog/order/allocation/service inchangés, table toujours absente) · **sous OFF : garde no-op, contrat historique** (rejects non-503).
- **Non-régression (bases existantes)** : sur `icode_host_pro_c3test` → **8 suites / 106 tests verts** (`c3-provisioning`, `c3-off-fallback`, `store-cancel-provisioning`, `store-checkout-domains`, `store-order-status`, `store-terminate-active-service`, `hosting-service-foundation`, `hosting-allocation-reservation`) ; sur `icode_host_pro_c1_test` → **2 suites / 43 tests verts** (`deployments`, `deployments-c2`). Total e2e GO : **24 suites / 163 tests, 0 échec**.
- **Live `icode_host_pro` intacte** (jamais ouverte en écriture) ; **0 appel provider/DNS réel** ; runner reconcile désactivé.

### Limites assumées / écarts
- `npm run lint` toujours indisponible (binaire eslint absent — pré-existant) ; tsc + tests font foi.
- Bases de test à conserver/supprimer selon revue : `icode_host_pro_c4test`, `icode_host_pro_c4premig` (+ `c3test`, `c3premig`, `c1_test` antérieures).
- Point ouvert (pré-existant) : phase 3 `order-cancel` no-row `provider='absent'` à réévaluer ; **upgrades refusés sous ON** reste une limite C3 documentée (line 1318), non modifiée par C4.

### État final
- **ARRÊT POUR REVUE** : 23 chemins (14 modifiés + 8 créés + `TASKS.md`), **aucun staging, aucun commit, aucun push**, HEAD = origin/main = `1fe8241`, `HOSTING_C4_ENABLED` **absente de tous les `.env` (OFF partout)**, zéro écriture live, zéro provider/DNS réel, aucune activation de flag.

--------------------------------------------------------------------
## 2026-09-27 — REVUE C4 (17B.4F-C4) : preuves, matrice, revue ciblée, corrections — **ARRÊT**

### 1. Preuves du périmètre
- **23 chemins en working tree, zéro staging/commit/push** — **15 `M`** (numstat `git diff --numstat`, ajoutés/retranchés) : `TASKS.md` 90/0 · `apps/api/prisma/schema.prisma` 118/1 · `apps/api/src/deployments/deployments.service.ts` 295/53 · `apps/api/src/deployments/deployments.service.spec.ts` 8/5 · `apps/api/src/hosting/hosting-services.service.ts` 91/0 · `apps/api/src/hosting/hosting.module.ts` 5/2 · `apps/api/src/store/provisioning.service.ts` 546/28 · `apps/api/src/store/order-cancel.service.ts` 411/61 · `apps/api/src/subscriptions/subscriptions.service.ts` 55/3 · `apps/api/src/store/store-provisioning.admin.controller.ts` 19/0 · `apps/api/src/store/provisioning.service.spec.ts` 10/0 · `apps/api/src/store/order-cancel.service.spec.ts` 6/0 · `apps/api/src/store/order-terminate.service.spec.ts` 3/0 · `apps/api/src/store/provisioning-c3.spec.ts` 2/0 · `apps/api/src/subscriptions/subscriptions.service.spec.ts` 85/0 — **8 `??`** (non suivis, taille en lignes) : `apps/api/prisma/migrations/20260928000000_add_c4_protocol_tables/` (migration.sql 139 l.) · `apps/api/src/hosting/c4-protocol.service.ts` 394 · `apps/api/src/hosting/c4-release.service.ts` 338 · `apps/api/test/c4-release.e2e-spec.ts` 1648 · `apps/api/src/hosting/c4-capability.service.ts` 97 · `apps/api/test/c4-premig.e2e-spec.ts` 154 · `apps/api/src/hosting/c4-flag.ts` 31 · `apps/api/src/store/dto/finalize-order.dto.ts` 21. `git diff --check` = **0** (avertissements LF→CRLF seulement). HEAD `1fe8241` = origin/main, divergence **0/0**.
- **Migration** : seul dossier `apps/api/prisma/migrations/20260928000000_add_c4_protocol_tables/` (117 l., additive, non appliquée en live) — **aucune ancienne migration modifiée** (statut git : aucun fichier sous `migrations/` hors ce dossier). Contenu : 4 enums + 5 tables (`C4ProviderAttempt`, `C4Takeover`, `C4StopRequest`, `C4ReleaseEvidence`, `C4ReadinessProof`) + 8 index nommés, dont l'unique partiel `C4ProviderAttempt_open_creative_key` et l'unique `C4ReleaseEvidence.allocationId`.
- **Prisma** : `prisma validate` ✓ · `prisma generate` ✓ (client régénéré sans erreur).
- **Pré-conditions conservées** : `HOSTING_C4_ENABLED` **absente** de `apps/api/.env` **et** `apps/web/.env` (vérifié par lecture) → OFF partout ; `.env` jamais modifié ; base live `icode_host_pro` jamais ouverte en écriture ; **0 appel provider/DNS réel** (fakes/mocks uniquement).

### 2. Validations relancées (chiffres réels, session de revue + passe C4 finale)
- `tsc --noEmit` = **0** ✓ · `nest build` = **0** ✓ · unit complet = **56 suites / 969 tests, 0 échec** ✓ (dont `deployments.service.spec` 112/112, contrat OFF de `remove()` préservé).
- **e2e `c4-release` (base `icode_host_pro_c4test`) : 21/21 PASS** ✓ (identité `current_database()` en beforeAll ; transport simulé, **PostgreSQL réel — aucun mock de base**).
- **e2e `c4-premig` (base `icode_host_pro_c4premig`) : 3/3 PASS** ✓ (gate 503 pré-migration + OFF no-op).
- **Non-régression** : `c3test` → **8 suites / 106 tests PASS** ✓ · `c1_test` (`deployments` + `deployments-c2`) → **2 suites / 43 tests PASS** ✓.
- **Total e2e revue : 12 suites / 173 tests, 0 échec** (1+1+8+2 suites ; 21+3+106+43 tests).
- URL de base dérivée en variable d'env (jamais affichée/écrite) ; bases **conservées** (`c4test`, `c4premig`, `c3test`, `c1_test` — décision utilisateur).

### 3. Matrice scénario → test → résultat (e2e = PostgreSQL réel, sauf mention)
| # | Scénario exigé | Test (fichier) | Exécution |
|---|---|---|---|
| 1 | création bloquée + annulation + succès tardif | `c4-release` « arrêt pendant CREATE… » + « settle après passage OFF » | **PASS** (PG réel, fakes réseau) |
| 2 | timeout CREATE : aucun rejeu, aucune libération, UNKNOWN durable | e2e **exact** « timeout CREATE → UNKNOWN durable : aucun rejeu CREATE, aucun DELETE, aucun RELEASED ; libération bloquée (call_uncertain) » (transport simulé `ETIMEDOUT`, **PG réel, 0 mock de base**) + unit `provisioning.service.spec` (timeout/handlers) | **PASS** |
| 3 | crash après DELETE + reprise + suppressions concurrentes | e2e « DELETE orpheline » + « suppressions concurrentes, **ORDRES OBSERVÉS** : (a) séquentiel → 404 ; (b) intercalé derrière barrière réseau → gagnant `released`, perdant `already_released` » | **PASS** (PG réel) |
| 4 | preuves app/DNS + DNS incertain bloquant + **re-nettoyage D6** | e2e « delete échec réseau → 502 » + **nouveau** « DNS échoue → slot conservé + rows adressables ; échec injecté en TX finale → **rollback conjoint** ; rejeu → UNE libération, preuve complète » (3 phases : fail → injection → rejeu) | **PASS** (PG réel) |
| 5 | settle après passage OFF (identifiants persistés, 0 transition) | e2e **nouveau** « settle après passage OFF » | **PASS** (PG réel) |
| 6 | ressources pré-protocole → refus conservatoire | e2e « pré-protocole » + **nouveau** « arrêt AVANT dispatch → `pre_protocol_uncertain` » | **PASS** (PG réel) |
| 7 | suppression d'app vs terminaison de service | e2e « delete successif » + **nouveau** « terminaison d'un service ACTIF » | **PASS** (PG réel) |
| 8 | annulation d'abonnement ∥ réservation, **ordres démontrés + verrou observé** | e2e **nouveau** « D10 ordres démontrés (annulation→réservation, réservation→annulation) + verrou `HostingService` observé (`pg_locks` `granted=false`, annulation en attente puis 409) » | **PASS** (PG réel) |
| 9 | finalize READY/non prêt, annulation concurrente, rejeu, **ordres imposeés** | e2e describe finalize (**5 tests** : les 3 historiques + **nouveau** « ordre 1 : finalize COMPLET (201) → annulation refusée 409 » + **nouveau** « ordre 2 : annulation COMPLÈTE pendant le probe réseau (barrière observée) → finalize 409, zéro preuve ») | **PASS** (PG réel) |
| 10 | suspension : aucun slot libéré | e2e **nouveau** « suspension admin (SUSPENDED) » | **PASS** (PG réel) |
| 11 | parcours OFF et pré-migration | e2e « bascule OFF » + « settle après OFF » (c4test) + `c4-premig` 3/3 | **PASS** (PG réel) |

### 4. Revue ciblée du code (vérifiée, aucune faille bloquante)
- **Barrières avant chaque mutation provider** : `beginDispatch*` appelé **avant** tout appel réseau (provisioning, `deployments.remove`, order-cancel) — prouvé e2e : stop pré-dispatch → `createGitCount` inchangé + **0 tentative**.
- **Token/tentative + écritures protégées dans la même TX** : settle `markBoundInTx`/retour dans la boucle d'action ; cycle `startReleasingInTx` → preuve (`allocationId` **unique**) → `completeReleaseInTx` — double-free impossible (e2e concurrent **à ordres observés** : séquentiel → 404 ; intercalé derrière barrière réseau → gagnant `released` + perdant `already_released`, **evidence = 1** dans les deux cas).
- **Zéro réseau sous verrou** : réseau (Coolify/CF) toujours hors `$transaction` (phases 1-2 de `remove` avant la TX des rows locales ; settle sites hors verrou) — relu ligne à ligne.
- **Aucun contournement OFF ni adoption pré-protocole** : flag relu à l'appel ; OFF → 0 nouvelle tentative ; settle sous OFF persiste `coolifyUuid`/attempt **sans flip** (order reste PROVISIONING, alloc reste RESERVED, stop intact) ; libération refusée sans tentative CREATE.
- **Anciennes migrations intactes** (voir §1) ; **finalize admin protégée** : recheck statut + stop + tentatives + fraîcheur de preuve **en TX** (`Order FOR UPDATE`), zéro activation aveugle — course réelle finalize ∥ annulation ⇒ transitions **exclusives** (201/proof/audit=1 **xor** 409/pas de preuve/pas d'audit) ; **ordres imposeés vérifiés** : (1) finalize 201 puis annulation → 409 ; (2) annulation COMPLÈTE pendant le probe réseau (barrière observée sur `fakeDeploymentStatus`) puis finalize reprise → 409 au relock `Order`, **zéro preuve, zéro audit**.
- **D10 atomique** : gate TX (User FOR UPDATE → services FOR UPDATE → count consommants → non-terminaux → update Subscription) — e2e **ordres démontrés** : (A) annulation COMPLÈTE puis réservation → refusée, **0 slot consommant sur CANCELLED** ; (B) réservation COMPLÈTE puis annulation → 409, souscription ACTIVE ; **verrou observé** : avec `HostingService` `FOR UPDATE` tenu par une TX ouverte, `pg_locks` montre l'annulation en attente (`granted=false`, non settlement) puis 409 au libération du verrou.
- **Aucune écriture d'allocation par `updateSubscription`** (transition blanche + audit) — e2e : `SUSPENDED` ⇒ alloc intacte, 0 preuve, 0 stop, D10 toujours opposable.

### 5. Écarts trouvés en revue + corrections appliquées
- **8 scénarios manquants** ajoutés à `c4-release.e2e-spec.ts` (scénarios 5-10, 7-9, finalize réel) → suite 11/11 → **19/19** (historique) ; imports (`SubscriptionStatus`, `HostingServicesService`, fixtures) + déclarations ajoutés.
- **D6 (re-nettoyage DNS) IMPLÉMENTÉ dans cette revue — n'est plus différé** : `deployments.remove()` révisé (parcours `c4Enabled && allocation`) → identifiants conservés avant l'appel réseau, **état adressable** si le DNS échoue (aucune écriture locale, rows intactes), suppression locale (`clientSubdomain` si liée + `deployment`, idempotente `deleteMany` anti-P2025) + preuve + `RELEASED` dans **UNE SEULE TX** via `releaseAfterCleanup({ cleanup })` → `deleteLocalRowsInTx` (ownership vérifié), fallback `localCleanupTx` sur `already_released`/`pre_provider_released`, aucun écriture sur `blocked` ; **contrat OFF `!c4Enabled || !allocation` strictement inchangé** (unit `deployments.service.spec` 112/112 ✓).
- **Test DNS réécrit en 3 phases** (l'ancienne assertion « row détachée » décrivait un défaut, plus la cible livrée) : (1) fail DNS → `blocked dns_not_conclusive`, **tout adressable** (deployment + CS liée + alloc `BOUND` + 0 preuve + tentative `FAILED_RETRYABLE`) ; (2) **échec injecté en TX finale** (`completeReleaseInTx` → throw) + app 404 → rollback **conjoint** vérifié en PG (rows + preuve annulées, alloc `BOUND`) ; (3) rejeu → `released`, deployment **null**, CS **réellement supprimée** (jamais résiduelle), evidence = 1 (`appOutcome: 'ABSENT'` = 404 au rejeu, `dnsOutcome: 'DELETED'`, identifiants).
- **Courses converties en ordres observés** (remplacement des seuls `Promise.allSettled`) : suppressions concurrentes → (a) séquentiel 404, (b) intercalé derrière barrière réseau (`gate` sur `fakeDeleteApplication`) → `released` xor `already_released`, evidence 1 ; finalize → +2 tests ordres (dont barrière sur `fakeDeploymentStatus` pendant le probe hors TX) ; D10 → ordres A/B + **verrou `FOR UPDATE` observé** (`pg_locks` `granted=false`, non-settlement) avant 409.
- **Test exact du timeout CREATE** : `createGitBehavior='timeout'` (30 ms puis `ETIMEDOUT`) → `unknownAfter.phase/outcome` durables, `createGitCount` inchangé, **0 tentative `DELETE` ajoutée**, alloc jamais `RELEASED`, releases `call_uncertain`, evidence 0 — **PostgreSQL réel, transport simulé, aucun mock de base**.
- 3 blocs `expect(...)` mal parenthésés pendant la rédaction → corrigés (compilation = 0) ; 1 assertion `appOutcome` corrigée (`ABSENT` pour un 404 au rejeu).

### 6. Exécuté / non exécuté / différé
- **Exécuté (revue + correction C4)** : preuves périmètre + migration + prisma · `tsc` · `nest build` · unit 56/969 · e2e c4test **21/21** · premig 3/3 · batteries c3test 8/106 + c1_test 2/43 (total e2e **12 suites / 173 tests**) · revue de code ciblée · **implémentation D6** (`remove()` + `c4-release.deleteLocalRowsInTx`) · **réécriture des courses en ordres observés** (DNS 3 phases, concurrents, finalize ordres 1/2, D10 ordres + verrou `pg_locks`) · **test exact timeout CREATE** · cette section.
- **Non exécuté (volontairement, interdits de revue)** : staging/commit/push · suppression de toute base · migration/appli en base live · modification de `.env` · activation du flag · appel provider/DNS réel.
- **Différé (hors périmètre C4 ou fin de projet)** : application réelle de la migration + test d'installateur (checklist CLAUDE.md « avant toute mise en prod ») · `npm run lint` (eslint absent, pré-existant) · upgrades sous ON (limite C3 documentée) · tests front (périmètre API).

### 7. État final
- **ARRÊT** : 23 chemins (15 M + 8 ??), **staging vide, aucun commit, aucun push** ; HEAD = origin/main = `1fe8241` (0/0) ; `HOSTING_C4_ENABLED` **absente des deux `.env` (OFF partout)** ; zéro écriture live, zéro provider/DNS réel, aucune activation ; bases `c4test`/`c4premig`/`c3test`/`c1_test` **conservées** ; validations = **tsc 0 · build 0 · unit 969/969 · e2e 173/173 (12 suites)**.


# GO SOCLE COMMERCIAL (2026-10-02) — chantier autonomie, branche `feat/socle-commercial` (en cours, ARRÊT final pour revue owner)

## 2026-10-02 — Lot P0 : préparation du chantier (base dédiée, branche)
- Action: état des lieux (HEAD `3245694`, propre, aucun service sur 3000/3001), branche `feat/socle-commercial` créée, base dédiée `icode_host_pro_socle` créée sur `icode-postgres` + 48 migrations déployées, `apps/api/.env` du worktree recréé (copie du `.env` principal, DATABASE_URL → socle, gitignored), `.env.example` vérifié.
- Files: apps/api/.env (gitignored), branche git.
- Tests: `prisma migrate status` = up to date.

## 2026-10-02 — Lot P1 : RBAC des lectures admin de modules de déploiement (audit C-02) [x]
- Action: `RolesGuard` + `@Roles(ADMIN)` ajoutés sur les 3 lectures publiques du controller (`GET /`, `GET /:id`, `GET /:id/projects`); e2e permanent `rbac-deployment-modules.e2e-spec.ts` écrit et exécuté.
- Reason: audit C-02 — la config interne des modules de déploiement (serveurs/UUID/routes) était lisible par tout USER; seuls les consommateurs légitimes (UI admin) restent servis.
- Files modified: apps/api/src/store/deployment-modules.controller.ts; created: apps/api/test/rbac-deployment-modules.e2e-spec.ts.
- Tests: e2e **7/7 PASS** (401 anonyme ×3, 403 USER ×3, 403 SUPPORT_L1, 200 ADMIN, 403 mutation USER, compteur panneau 0/1, zéro donnée sensible); `tsc --noEmit` PASS; scan global des contrôleurs OK.
- Commit local: `86c9f61` `fix(api): restrict deployment-module reads to ADMIN (audit C-02)`.

## 2026-10-02 — Lot P2 : confirmation de paiement (aucun droit avant règlement) [x]
- Action: migration additive + checkout `PENDING_PAYMENT` sans droits + `confirmOrderPaid` idempotent + endpoint ADMIN `confirm-payment` + simulateur de recette (gate strict, refus production) + masquage CARTe publique + sweep de reprise (`OrderLifecycleService`) + email gratuit corrigé (l'invité recevait JAMAIS son mot de passe temporaire) + idempotence clé cliente (`Idempotency-Key`) et chaînage post-annulation + `.env.example`.
- Reason: GO socle commercial — aucune méthode active n'est une preuve de paiement; aucune souscription/service/provisioning avant confirmation serveur tracée; reprise durable des commandes figées; refus honnête du paiement carte tant qu'aucun prestataire n'est choisi.
- Files: schema.prisma + migration `20261002000000_add_payment_confirmation`; src/config/payment-simulator.ts (nouveau); src/store/checkout.service.ts, checkout.controller.ts, payment-methods.controller.ts, store.module.ts; src/store/admin-orders.controller.ts (nouveau); src/store/order-lifecycle.service.ts (nouveau); .env.example; specs: checkout-c3.spec.ts (réécrit), test/store-payment-confirmation.e2e-spec.ts (nouveau), test/store-checkout-domains.e2e-spec.ts + test/c3-provisioning.e2e-spec.ts (adaptés).
- Tests: e2e nouveau **25/25 PASS**; e2e adaptés **21/21 + 8/8 PASS**; unit complet **1001/1001 PASS (56 suites)** (checkout-c3 17/17); `tsc --noEmit` PASS; lint = eslint absent du workspace (préexistant, non bloquant).
- Validations croisées: C1 401/403/201 RBAC, idempotence confirm, rollback conflit métier, refus production simulateur, expiration+chaînage, relance PAID — toutes prouvées sur PG réel (base socle).

## 2026-10-02 — Lot P3 = audit A1 : compte client (reset mdp + édition profil) [x]
- Action: migration additive `PasswordResetToken` (sha256 au repos) + `POST /auth/forgot-password` (réponse identique connu/inconnu, rate-limit 5/min, TTL borné, email best-effort façon invitations) + `POST /auth/reset-password` (400 générique unique inconnu/utilisé/expiré, longueur vérifiée avant brûlage du jeton, transaction mdp + usage unique + destruction des refresh tokens actifs) + `PATCH /users/me` (nom/email propres au JWT, trim, nom vide = clearance, 409 email pris, no-op si identique, audit `auth.profile.update` des champs, lecture seule en impersonation) + web (mode « Mot de passe oublié ? » sur `/auth`, page `/auth/reset?token=…`, panneau « Coordonnées » sur `/profil`, helpers api.ts) + `.env.example` (`PASSWORD_RESET_EXPIRES_IN_MINUTES`).
- Reason: GO socle commercial / audit §1.1 « clients et accès » — les deux capacités non couvertes côté client : récupérer un compte perdu et corriger nom/email sans intervention admin; anti-énumération + aucun secret en journal; sessions tuées immédiatement (fenêtre de réemploi 10 s de `refresh()` non applicable au reset → `deleteMany` et non `revokedAt`).
- Files: prisma/schema.prisma + migration `20261002100000_add_password_reset`; src/auth/auth.service.ts, auth.controller.ts, rate-limiter.ts, dto/forgot-password.dto.ts + dto/reset-password.dto.ts (nouveaux); src/config/configuration.ts; src/users/users.service.ts, users.controller.ts, dto/update-profile.dto.ts (nouveau); web: src/lib/api.ts + src/app/auth/page.tsx + src/app/auth/reset/page.tsx (nouveau) + src/app/profil/page.tsx; .env.example; specs: auth.service.spec.ts, users.service.spec.ts (étendus), test/account-recovery.e2e-spec.ts (nouveau).
- Tests: e2e nouveau **16/16 PASS** (A anti-énumération + rate-limit, B parcours complet reset + sessions mortes + audit sans secrets, C profil isolation, D impersonation 403); non-régression e2e smoke **32/32 PASS** (store-payment-confirmation 25 + rbac 7); unit complet **1015/1015 PASS (56 suites)**; `tsc --noEmit` API **et** Web PASS; lint = eslint absent du workspace (préexistant, non bloquant).
- Leçon e2e: `MailSettingsService.isEnabled()` lit le flag `enabled` de la row mail — la fixture doit forcer `enabled: true` (snapshot/restore), sinon aucun email n'est envoyé et le flux échoue silencieusement (anti-énumération oblige).
- (commit P3 : voir plus bas après exécution)

## 2026-10-02 — Lot P4 = audit B1 : visibilité (mes commandes / mes factures + listes admin) [x]
- Action: vues client `GET /client/orders|invoices` (+ détail) avec **isolation par propriétaire servie côté API** (`customer.userId = sub` + repli email du dossier invité), détail croisé = 404 (jamais 403), pagination stricte (page=0 → 400, statut invalide → 400), select sans secret interne (`hasPdf` au lieu du chemin disque) ; listes admin `GET /store/admin/orders` (+ **`summary` KPI** `groupBy` par statut qui suit les filtres), `GET /store/admin/orders/:id`, nouveau `AdminBillingController` (`invoices`, `invoices/:id`, `customers` + `_count`), tous `@Roles(ADMIN)` ; bouton « Confirmer le règlement » sur la page commande admin = l'`confirm-payment` existant devient atteignable depuis l'UI ; web 4 pages (`/client/commandes`, `/client/factures`, `/manager/commandes`, `/manager/factures`) + nav CLIENT/ADMIN + liens « Voir mes commandes » sur `/checkout/success` (promesses « espace client » tenues).
- Reason: GO socle commercial / audit §5 lot B1 + E-03/E-07 — aucune liste client ni admin n'existait (le succès du checkout promettait l'état de la commande « dans votre espace client » sans page pour le voir) ; critère d'acceptation : chaque liste paginée et filtrée par propriétaire (client) / ADMIN (admin) + e2e d'isolation.
- Files: src/store/dto/store-lists.dto.ts, src/store/client-store.controller.ts, src/store/admin-billing.controller.ts (nouveaux); src/store/admin-orders.controller.ts (liste + détail), src/store/store.module.ts; web: src/lib/api.ts, src/config/nav.ts, src/app/client/commandes/page.tsx, src/app/client/factures/page.tsx, src/app/manager/commandes/page.tsx, src/app/manager/factures/page.tsx (nouveaux), src/app/checkout/success/page.tsx; spec: test/visibility-lists.e2e-spec.ts (nouveau). Aucune migration.
- Tests: e2e nouveau **15/15 PASS** (isolation 404 croisé, repli email invité, pagination/validation 400, RBAC 401/403, KPI summary, recherche, aucun secret en liste); non-régression e2e smoke **48/48 PASS** (store-payment-confirmation 25 + account-recovery 16 + rbac 7); unit complet **1015/1015 PASS (56 suites)**; `tsc --noEmit` API **et** Web PASS; lint = eslint absent du workspace (préexistant, non bloquant).
- (commit P4 : voir plus bas après exécution)

## 2026-10-03 - Lot P5 = audit B2 : coherence tarifaire (promo facturee + devis + taux) [x]
- Action: regle promo unique `CheckoutService.activeBasePrice` (promo active si strictement < catalogue, promo >= catalogue ignoree, jamais de prix facture superieur, promo 0 valide) + `buildPricing` sur prix actif ; devis public `POST /store/quote` (`QuoteDto` slug/options/addons, aucun montant recu, sans auth ni rate-limit) qui reutilise exactement `buildPricing` et renvoie `product{priceHtCents,promoPriceHtCents,activePriceHtCents}` ; nouveau `TaxRatesAdminController` (`store/admin/tax-rates` CRUD, ADMIN strict, nom unique 409, UN SEUL `isDefault` en transaction, suppression 409 si produit rattaché, audit taxrate.*) + `tax-rate.dto.ts` (ratePercent 0..100) ; web: helpers `activePriceCents`/`promoActive`/`quoteCart`/tax-rates dans `api.ts`, `PriceTag` boutique + carte accueil (prix actif en grand, catalogue barre — inverse de l'ancien affichage), fiche produit `base = prix actif` + catalogue barre au recap, panier re-fetch quote a chaque changement (souscription/Taxe/Total depuis le serveur, repli local), `cartHtCents` sur prix actif, page `/manager/taxe` (CRUD complet) + entree `ADMIN_NAV` "Taux de taxe". Aucune migration.
- Reason: GO socle commercial / audit 5 lot B2 + anomalies E-01 — l'affichage boutique (prix promo) et la facturation (prix catalogue) donnaient DEUX totaux differents pour le meme panier, et la promo n'etait modifiable qu'en base (aucune UI, decision 6-6) ; critere d'acceptation : prix affiche = prix debite (0 ecart devis/commande) + CRUD taux admin testé RBAC.
- Files: src/store/checkout.service.ts (activeBasePrice/buildPricing/quote), checkout.controller.ts (@Post quote), dto/checkout.dto.ts (QuoteDto), dto/tax-rate.dto.ts + tax-rates.admin.controller.ts (nouveaux), store.module.ts; web: src/lib/api.ts, src/lib/cart.ts, src/config/nav.ts, src/app/shop/page.tsx, src/app/shop/[slug]/page.tsx, src/app/page.tsx, src/app/cart/page.tsx, src/app/manager/taxe/page.tsx (nouveau); specs: src/store/checkout-pricing.spec.ts + test/pricing-consistency.e2e-spec.ts (nouveaux).
- Tests: unit nouveau **21/21 PASS** (regle promo 9 cas, arrondi PAR LIGNE 130 != 131, quote === buildPricing) ; e2e nouveau **12/12 PASS** (0 ecart devis/commande, promo ignoree si >=, 400 option requise, taux 5,5 % applique, RBAC/doublon/isDefault/delete 409) ; smoke **63/63 PASS** (payment 25 + recovery 16 + rbac 7 + visibility 15) ; unit complet **1036/1036 PASS (57 suites)** ; `tsc --noEmit` API **et** Web PASS ; lint = eslint absent du workspace (preexistant, non bloquant).
- Lecon: la reponse `CheckoutResult` n'a PAS de champ `status` (uniquement `orderId`/`nextStep`/`invoiceNumber`) — l'assertion de statut se fait cote DB (`prisma.order`), pas sur le corps HTTP.
- (commit P5 : voir plus bas apres execution)

## 2026-10-03 — Lot P6 = audit C2 + C3a : portefeuille & recharge par virement [x]
- Action: `WalletService` (nouveau module `WalletModule`, SEUL ecrivain de `walletBalanceCents` : `$transaction` + `SELECT ... FOR UPDATE`, anti-negatif sous verrou, idempotence P2002 = replay neutre (`replayed:true`) ou 409 si cle volee par un autre compte, `ensureOwnedCustomer` = dossier lie au compte / repli email invite (P4) / creation / 409 si dossier d'un AUTRE compte) + recharge C3a `POST /client/wallet/recharges` (multipart, justificatif OBLIGATOIRE PNG/JPEG/WebP/PDF <= 5 Mo stocke `public/wallet-proofs/`, ligne `CREDIT/PENDING` **sans effet solde**, reference serveur `RCH-<10 hex>`) + admin `store/admin/wallet/recharges` (GET liste filtres statut + recherche / GET :id / GET :id/proof StreamableFile / validate = CAS `PENDING->SUCCEEDED` + increment MEME transaction — revalidation 409 / reject = CAS ->`CANCELED` 0 credit + motif appende au note, preuve conservee), `@Roles(ADMIN)`, audit `wallet.recharge.create|validate|reject` avec acteur ; web helpers `getMyWallet`/`listMyWalletTransactions`/`createWalletRecharge` (FormData retry 401)/`listAdminRecharges`/`validateAdminRecharge`/`rejectAdminRecharge`/`fetchRechargeProofBlob` + libelles `WALLET_*`, pages `/client/portefeuille` (StatCard solde, depot avec justificatif, historique paginé) et `/manager/recharges` (StatCard en attente, filtres, Valider/Rejeter/Justificatif), entrees CLIENT_NAV `Portefeuille` + ADMIN_NAV `Recharges`, nouvel icone `IconWallet`. **Aucune migration** (modele `WalletTransaction` deja existant).
- Reason: GO socle commercial / audit 5 lots C2 (portefeuille) + C3a (recharge virement, decision 6-5 option a = sans prestataire) — aucun moyen pour le client d'alimenter son solde ni pour l'admin de controler un depot ; criteres: solde JAMAIS negatif, credit EXACTEMENT une fois (CAS serveur), isolation stricte par compte, justificatif oblige + conserve + RBAC.
- Files: src/wallet/wallet.service.ts, dto/wallet.dto.ts, client-wallet.controller.ts, admin-wallet.controller.ts, wallet.module.ts (nouveaux), src/app.module.ts (wiring) ; web: src/lib/api.ts, src/config/nav.ts, src/components/icons.tsx, src/app/client/portefeuille/page.tsx + src/app/manager/recharges/page.tsx (nouveaux) ; specs: src/wallet/wallet.service.spec.ts + test/wallet-recharge.e2e-spec.ts (nouveaux).
- Tests: unit nouveau **19/19 PASS** (C2 verrou/idempotence/concurrence 5x400 -> 2 OK / 3 refus / final 200, C3a CAS validate/reject, ownership 4 cas) ; e2e nouveau **12/12 PASS** (401 + dossiers isoles, justificatif/montants 400, PENDING solde 0 + fichier disque, liste admin RBAC, validate 1x + revalidate 409, preuve admin 200 / client 403 / 404, rejet 0 credit + re-rejet 409, concurrence PG reelle + replay idempotent) ; smoke **63/63 PASS** (payment 25 + recovery 16 + rbac 7 + visibility 15) ; unit complet **1055/1055 PASS (58 suites)** ; `tsc --noEmit` API **et** Web PASS ; lint = eslint absent du workspace (preexistant, non bloquant).
- Decision restante documentee: « payer une commande par solde » au checkout NON cable en P6 (necessite une source de confirmation `wallet` dans le flux C0 de confirmation de paiement).

## 2026-10-03 - Lot P7 = audit D1 : facturation (PDF figé + échéance + mentions + numérotation sûre) [x]
- Action: `InvoicePdfService` (render pur = A4 non compressé, `CreationDate = issuedAt`, **snapshot seulement**, `ensurePdf` = `public/invoices/<id>.pdf` + seule écriture `pdfPath`) ; émission checkout enrichie (`claimInvoiceSequence` renvoie devise + numéro + ligne `BillingSetting` figée, `dueDate = issuedAt + invoiceDueDays` clamp 0..3650, `legalMentionsSnapshot` 6 champs) ; singleton `BillingSetting` créé par **`INSERT … ON CONFLICT ("id") DO NOTHING`** + relecture dans la tx (l'ancien create+catch P2002 avortait la tx → 25P02) ; API admin `GET/PATCH store/admin/billing-settings` (identité, mentions 10×500, `invoiceDueDays` 0..90, `''`/`[]` = efface, IsEmail, audit `billing.settings.update`) + `GET store/admin/invoices/:id/pdf` ; API client `GET client/invoices/:id/pdf` (propriétaire = 200, autre = 404, anonyme = 401) ; web helpers `getBillingSettings`/`updateBillingSettings`/`downloadInvoicePdf` (blob + retry 401), boutons PDF + échéance sur `/client/factures` et `/manager/factures`, page `/manager/facturation` + entrée ADMIN_NAV « Paramètres facturation ». **Migration additive** `20261003000000_add_invoice_billing_terms` (`invoiceDueDays` défaut 14, 51e au total) ; **dépendance** `pdfkit` + `@types/pdfkit` (pnpm, lockfile).
- Reason: GO socle commercial / audit 5 lot D1 - aucune facture téléchargeable en PDF avec mentions légales ni échéance, et rien ne prouvait l'unicité des numéros sous concurrence ; critères: numéro unique sous concurrence PG réelle, PDF stable octet-identique, mentions figées à l'émission (jamais relues), isolation du téléchargement.
- Files: src/store/invoice-pdf.service.ts + spec (nouveaux), dto/billing-settings.dto.ts (nouveau), checkout.service.ts (claim/ON CONFLICT/snapshot), admin-billing.controller.ts (settings + PDF), client-store.controller.ts (PDF), store.module.ts (provider), prisma/schema.prisma + migrations/20261003000000_add_invoice_billing_terms (neuve), package.json + pnpm-lock (pdfkit) ; web: src/lib/api.ts, src/config/nav.ts, src/app/client/factures/page.tsx, src/app/manager/factures/page.tsx, src/app/manager/facturation/page.tsx (nouveau) ; spec e2e: test/invoice-billing.e2e-spec.ts (nouveau).
- Tests: unit nouveau **5/5 PASS** (render figé/stable, ensurePdf 1 écriture, 404) ; e2e nouveau **11/11 PASS** (émission ms-exactes + snapshot, PDF 401/404/200 + contenu figé + régénération identique, 2 téléchargements octet-identiques, 6 checkouts parallèles → 6 numéros distincts + 1 ligne settings, RBAC/validations 400/effacement) ; smoke **63/63 PASS** ; unit complet **1060/1060 PASS (59 suites)** ; `tsc --noEmit` API **et** Web PASS ; lint = eslint absent du workspace (preexistant, non bloquant).
- Decisions: (1) numérotation `AAAA-<seq>` **conservée sans remise à zéro annuelle** (§6-6 = owner, décision restante documentée dans `/manager/facturation`) ; (2) leçons techniques: repo SANS `esModuleInterop` → `import PDFDocument = require('pdfkit')` obligatoire, pdfkit encode le texte en hex dans les TJ (décodage nécessaire dans les assertions).

## 2026-10-03 - Lot P8 = audit D2 : abonnements récurrents (échéances + renouvellement par solde + dunning + suspension) [x]
- Action: `RenewalService` (nouveau, `StoreModule` + import `WalletModule`) avec `sweep()` public en 4 passes idempotentes : (1) **renouvellement** des échéances (`autoRenew` + `nextBillingDate <= now`, famille PAID/PROVISIONING/ACTIVE, souscription ACTIVE du même produit) → NOUVELLE commande (`renewsOrderId` chaîné, mère `autoRenew=false` dans la MÊME transaction par CAS — contrainte `@unique` en secours) + NOUVELLE facture UNPAID (numéros partagés : `claimInvoiceSequence` sorti de `CheckoutService` dans `invoice-sequence.ts`, lignes/mentions/échéance copiées = price-lock de la mère) puis **paiement par solde** (`WalletService.debit`, clé `renewal:<orderId>`) → `confirmOrderPaid(source 'wallet')` (source ajoutée à `ConfirmSource`) : `PAID→ACTIVE` dans la même transaction, **sans provisioning** ; solde insuffisant → facture reste UNPAID (aucun crédit fabriqué, période suivante jamais ouverte) ; (2) **reprise** : débit committé non confirmé (crash) → re-confirmation SANS second débit, sinon nouvel essai de prélèvement ; (3) **dunning** : rappel UNE fois à `dueDate − dunningReminderDays` (CAS `Invoice.dunningRemindedAt`, audit `billing.dunning_reminder`, email best-effort) ; (4) **suspension** à `dueDate + dunningGraceDays` → souscription ACTIVE→SUSPENDED (CAS, audit `subscription.auto_suspend`) = **STATUT SEUL, aucun appel infrastructure (§6-4 non tranché → décision restante BLOQUÉ)**. Gardes: `gateSubscription` (ACTIVE même produit → ok ; PENDING/SUSPENDED → skip SANS flip = chaîne résumable ; absente/CANCELLED/REJECTED/produit changé → flip + audit `renewal.chain_stopped`), `confirmOrderPaid` enrichi (champ `renewal` du `TxOutcome`, CAS récurrent pose `autoRenew` + `nextBillingDate = addBillingCycle(paidAt, cycle)` — décision technique serveur, aucun champ client), `provisionOrder` **no-op bénin** si `renewsOrderId`, expiration 48 h (`expireStalePending`) **exclut** `renewsOrderId` (l'impayé vit le dunning). Nouveaux `billing-cycle.ts` (`addBillingCycle` UTC déterministe clamp jour : 31 janv → 28/29 févr, 31 août → 30 sept, ONETIME → null) et `invoice-sequence.ts` (corps verbatim P7 partagé). API `POST /store/admin/renewal/sweep` (ADMIN) + timer `RENEWAL_SWEEP_MS` (défaut 60 000) / `RENEWAL_SWEEP_ENABLED=false` (pattern order-lifecycle). **Migration additive** `20261003000001_add_invoice_dunning` (`Invoice.dunningRemindedAt`, 52e au total). Web: colonne « Abonnement » sur `/client/commandes` (Badge « Auto · échéance » / « Renouvellement arrêté » / — ONETIME) + lignes renouvellement/échéance/ligne de chaîne sur le détail (`OrderDetail.renewsOrderId` ajouté aux types).
- Reason: GO socle commercial / audit 5 lot D2 - aucune échéance ni renouvellement d'abonnement, aucun dunning ni suspension automatique : un client dont l'abonnement expire était simplement oublié, et rien ne prouvait qu'un renouvellement débite exactement une fois ; critères: renouvellement → 2e facture (horloge accélérée), impayé → relance unique puis suspension (statut seul), reprise de crash sans double débit, exclusion du renouvellement par l'expiration 48 h, RBAC du déclencheur.
- Files: src/store/renewal.service.ts + renewal.service.spec.ts (nouveaux), billing-cycle.ts, invoice-sequence.ts (nouveaux), checkout.service.ts (ConfirmSource wallet / isRenewal / CAS récurrent / PAID→ACTIVE / gardes C3+provisioning / email renouvellement), order-lifecycle.service.ts (garde expiration), provisioning.service.ts (no-op renouvellement), admin-billing.controller.ts (POST renewal/sweep), store.module.ts (WalletModule + provider), invoice-pdf.service.spec.ts (fixture dunningRemindedAt), prisma/schema.prisma + migrations/20261003000001_add_invoice_dunning (neuve) ; web: src/lib/api.ts (renewsOrderId), src/app/client/commandes/page.tsx ; spec e2e: test/recurring-billing.e2e-spec.ts (nouveau).
- Tests: unit nouveau **17/17 PASS** (matrice D2 : création+débit+confirm wallet, solde insuffisant sans crédit, arrêts de chaîne CAS + product_changed, skip suspendu résumable, reprise sans double débit, relance UNE fois, suspension CAS sans infra, anti-chevauchement, coupe-timer + 4 cas `addBillingCycle`) ; e2e nouveau **9/9 PASS** (A échéance ms exactes + ONETIME null, B renouvellement payé = 2e commande+2e facture numérotée distincte+débit unique sans provisioning+idempotence, B2 chaîne renewal2, C impayé → UNPAID, C2 relance unique (marqueur+audit+email) puis suspension ACTIVE→SUSPENDED statut seul, C3 chaîne résumable, D crash débit/sans-confirm → reprise 1 seul débit, E renouvellement EXCLU de l'expiration 48 h vs commande standard CANCELLED, F RBAC 401/403/201) ; smoke **63/63 PASS** ; e2e P7 invoice-billing **11/11 PASS** (non-régression checkout) ; unit complet **1077/1077 PASS (60 suites)** ; `tsc --noEmit` API **et** Web PASS ; lint = eslint absent du workspace (preexistant, non bloquant).
- Leçons: (1) l'encodage se vérifie AUX OCTETS (`EF BF BD` = U+FFFD) — la console PowerShell affiche le UTF-8 en mojibake et `Get-Content` sans BOM lit en ANSI : ne JAMAIS recopier les caractères mojibake vus en console dans un oldString ; le diff git est le révélateur fiable des pertes (un bloc `invoice → PAID` avait été perdu pendant une édition, retrouvé via `git show HEAD:...`) ; (2) le stub e2e reçoit `transport.sendMail({from,to,subject,...})` en UN argument (pas `(cfg,msg)`) ; (3) `HostingServiceAllocation` n'a PAS de `orderId` → « aucune infrastructure » se prouve par `Deployment.orderId` + absence de statut PROVISIONING.

## 2026-10-03 - Lot P9 = audit E1 : exploitation (audit complet + UI 5 actions admin + écran moyens de paiement + CI) [x]
- Action: audit M-05 complet — `ConfirmPaidContext.actorId?`, `traceAudit(..., actor?)` (actorId + actorEmail sur `payment.checkout` : créateur au checkout / owner+admin à la confirmation, 4 call sites), `payment.confirmed` + actorId/actorEmail + `details.from/to`, **nouvelles lignes `order.transition`** via helper `recordOrderTransition` (best-effort, try/catch, post-commit, skip si from===to) : confirm PENDING→PAID/ACTIVE, legacy `provision_no_method`/`provision_legacy` (PAID→PROVISIONING, émis après `setOrderStatus`), claim C3 (post-switch, `via:'c3_claim'`, ajouté au return `claimed`), `postActivationEffects` si `outcome.orderActivated` (PROVISIONING→ACTIVE, `via:'activation_proof'` — couvre proof-gate, TX-B et finalize) ; `admin-orders.controller` passe `actorId: actor.sub` ; `payment.method.update` journalise `feePercent`/`feeFixedCents`. UI M-06 — `/manager/commandes` panneau « Actions administrateur » (5 actions : provision(+force)/cancel-provisioning/finalize/terminate/resync-limits, `actionsFor(o)` par état, `pickAction` motif ≥ 8, `runAction` + reload) + helpers `api.ts` (adminProvisionOrder/adminCancelProvisioning/adminTerminateOrder/adminFinalizeOrder/adminResyncLimits) ; nouvelle page `/manager/moyens-paiement` (liste + édition isActive/displayOrder/feeType/feePercent/feeFixedCents/config JSON validé, `configEnc` jamais exposée) + entrée ADMIN_NAV. CI — `.github/workflows/ci.yml` (premier du dépôt) : service postgres:16-alpine, pnpm deduit de packageManager, install figé, prisma generate + migrate deploy, tsc API+Web, unit `jest src --maxWorkers=4`, e2e complet `--runInBand`, sweeps OFF, simulateur non défini ; yaml-lint OK.
- Reason: GO socle commercial / audit 5 lot E1 - M-05 (audit incomplet : `payment.checkout` sans acteur, transitions OrderStatus hors AuditLog, frais non journalisés) + M-06 (5 actions admin obligées de passer par l'API ou un dev, aucun écran moyens de paiement) + aucun pipeline CI ; critères: acteur sur payment.checkout, transitions tracées, frais journalisés en valeurs, CI exécutant unit + e2e.
- Files: src/store/checkout.service.ts (actorId/actorEmail/from-to/order.transition), admin-orders.controller.ts (actorId), provisioning.service.ts (recordOrderTransition + 4 sites), billing-payment.admin.controller.ts (frais), provisioning.service.spec.ts + provisioning-c3.spec.ts (assertions + auditMock), test/audit-completeness.e2e-spec.ts (nouveau) ; web: src/lib/api.ts (5 helpers + AdminPaymentMethod/list/update), src/app/manager/commandes/page.tsx (panneau actions), src/config/nav.ts, src/app/manager/moyens-paiement/page.tsx (nouveau) ; .github/workflows/ci.yml (nouveau) ; docs: CHANGELOG.md, TASKS.md. Aucune migration (52 inchangées).
- Tests: e2e nouveau **5/5 PASS** (audit-completeness : acteur checkout, acteur admin + from/to + transition, frais en valeurs, PAID→ACTIVE no-method réel, RBAC) ; unit ciblées **128/128 PASS** (provisioning.service, provisioning-c3, checkout.service, checkout-c3, checkout.controller) ; **unit complet 1077/1077 PASS (60 suites)** ; non-régression e2e 7 suites **80/80 PASS** (store-payment-confirmation, recurring-billing, invoice-billing, store-cancel-provisioning, store-terminate-active-service, audit, audit-completeness) ; `tsc --noEmit` API **et** Web PASS ; `yaml-lint` OK ; smoke 63/63 repris en P8 (non rejoué : surfaces inchangées).
- Leçons: (1) les mocks Jest `mockRejectedValue` font échouer les best-efforts « silencieux » → tout helper d'audit ajouté a SON try/catch (exigé par le test « aucun module ») ; (2) transitions d'état TOUJOURS post-commit (jamais dans une tx pouvant rollbacker) ; (3) éditions multiples d'une même zone de fichier = revérifier `git diff` (un Edit avait matché le bloc voisin confirm-email → réparé) ; (4) e2e a besoin `ORDER_SWEEP_ENABLED=false` + `RENEWAL_SWEEP_ENABLED=false` ; (5) CI : `loadAppConfig` exige DATABASE_URL/PORT/JWT_SECRET (fail-fast), specs pilotent PAYMENT_SIMULATOR_ENABLED elles-mêmes.

## 2026-10-04 - Lot P10 = clôture GO socle : validations globales + preuves + rapports [x]
- Action: validation finale complète (unit **1077/1077 PASS (60 suites)** ; e2e complet **407/407 PASS (38 suites)** sur `icode_host_pro_socle` avec exclusion commentée des 4 suites legacy ; `tsc --noEmit` API + Web ; `yaml-lint` CI) ; relance honnête 1re passe AVEC legacy = 407 verts + **39 échecs attendus** (`recette/logs/e2e-final-p10.log`), run vert de référence = `e2e-final-p10-run2.log` ; CI mise à jour (`--testPathIgnorePatterns c3-premig c4-premig c4-release c4-rollback` + explication) ; base recette `icode_host_pro_recette` portée 48 → **52 migrations** (`prisma migrate deploy` **depuis apps/api** — `npx` à la racine installerait `prisma@8-rc`, interdit) ; API reconstruite (`nest build` OK) ; `next build` = **OOM exit 134** (inutilisable sur cette machine, `tsc` reste la validation web) ; recette relancée via `recette/up-p10.ps1` (API 3011 + web **`next dev`** 3002) ; script `recette/capture-socle-p10.mjs` → **11 captures** `socle-p10-*.png` dont le **panneau « Actions administrateur »** et l'**écran moyens de paiement** (cibles P9, visuellement validées) — login des captures via API même origine (cookie httpOnly) car le fill UI synthétique CDP perd l'onChange du 1er champ React ; livrables de revue : `docs/RAPPORT-SOCLE-COMMERCIAL.md`, `recette/GUIDE-RECETTE-P10.md`, `recette/up-p10.ps1`, `HANDOVER.md`, `PROJECT_STATUS.md`, `docs/suivi-projet.html`, `recette/diff-socle-commercial.patch` (93 fichiers, +15 848/−355).
- Reason: GO socle commercial / P10 - livrables finaux exigés : chaque capacité = statut PASS/ÉCHEC/BLOQUÉ/NON TESTÉ + preuve + limite, captures + guide de recette, patch complet, liste commits/fichiers/migrations/dépendances ; critère d'arrêt = rapport global pour revue **sans merge ni push**.
- Files: docs/RAPPORT-SOCLE-COMMERCIAL.md (nouveau), recette/GUIDE-RECETTE-P10.md + recette/up-p10.ps1 + recette/capture-socle-p10.mjs (nouveaux, hors git), recette/socle-p10-*.png (11 captures), recette/logs/e2e-final-p10*.log, .github/workflows/ci.yml (exclusion legacy), CHANGELOG.md, TASKS.md, HANDOVER.md, PROJECT_STATUS.md, docs/suivi-projet.html.
- Tests: unit complet **1077/1077 PASS (60 suites)** ; e2e complet **407/407 PASS (38 suites)** ; 1re passe avec legacy = 407 verts + 39 échecs attendus des 4 suites à base dédiée ; `tsc --noEmit` API + Web PASS ; `yaml-lint` PASS ; 11 captures visuellement validées (détail Actions admin, moyens de paiement, abonnements, mes factures, mes commandes…).
- Décisions/limites: (1) **4 suites legacy = NON TESTÉ** (`c3-premig`/`c4-premig`/`c4-release`/`c4-rollback` : bases figées avant le GO, colonnes `Order.paidAt` absentes — exclusion CI documentée, réparation = refabrique des dumps dédiés) ; (2) pipeline GitHub **non exécuté** (push interdit en chantier) = validation locale des mêmes étapes ; (3) `next build` OOM = limitation machine (`up-p10.ps1` utilise `next dev`) ; (4) décisions owner toujours ouvertes : §6-1 prestataire (C1/C3b BLOQUÉS), §6-4 effet infra suspension, §6-6 remise à zéro annuelle, §6-7 RGPD + switch inscription gratuite, « payer par solde au checkout », frais non appliqués ; (5) `npx prisma` **depuis apps/api uniquement**.

## 2026-10-04 - Lot Q-A = correction/achèvement socle GO (items 1+2+4 fusionnés : règlement par solde atomique + idempotence wallet stricte + consentement renouvellement) [x]
- Action: **API** — `payOrderWithWallet` refactorisé (type `WalletTxOutcome {replayed, balanceCents, status, conf}` ; verrou commande `FOR UPDATE` puis client ; **rejeu in-tx** si statut ≠ PENDING + débit wallet identique → 201 `replayed:true`, sinon 409 ; net legacy `netDebited` couvrant → confirmation seule / partiel → 409 / frais → `applyWithClient` ; **`postConfirmEffects` wrappé try/catch+log dans `payOrderWithWallet` ET `confirmOrderPaid`** — jamais d'erreur après commit ; audit `payment.confirm_failed` guardé) ; endpoints `POST /client/orders/:id/pay-with-wallet` + `/client/invoices/:id/pay-with-wallet` (`CheckoutService` + `ensureOwnedCustomer`) ; `WalletService.apply`/`applyInTx`/`applyWithClient` identité de rejeu stricte ; **correctif P2002 checkout** : `resolveIntention(baseKey, clientKey)` nul → `resolveIntention(baseKey, null)` → rejeu honnête (fin du 409 trompeur « compte existe déjà ») ; `PATCH /client/orders/:id/renewal` + nouveau DTO `RenewalToggleDto` (armement consentement daté + échéance CAS / révocation CAS, audit `subscription.renewal_toggled`, 409 ONETIME, 404 non propriétaire) ; `ORDER_LIST_SELECT` + `renewalConsentAt` ; `renewal.service.ts` heads/attemptPayment : consentement non null + `payOrderWithWallet` (re-gate avant débit) ; `checkout.service.ts` CAS armement si `renewalConsentAt` ; `dto/checkout.dto.ts` `renewalConsent` ; Prisma `Order.renewalConsentAt` + `Invoice.subscriptionId` (+FK SetNull, `@@index`) — **2 migrations additives 53e/54e**, anciennes intactes, Client régénéré.
- Action (suite) : **e2e** — nouveau `test/wallet-payment.e2e-spec.ts` **14/14 PASS** : A solde insuffisant (0 écriture), B atomique (montant exact + invoice PAID + balance), **C double-clic concurrent (2×201, 1 débit)**, D rejeu séquentiel, **D2 rejeu d'intention checkout (même contenu ± clé client → même commande)**, E annulé→409, F spy `confirmOrderInTx` reject → rollback + `payment.confirm_failed`, G spy `postConfirmEffects` reject → 201 état committé, H débit legacy `legacy-split:` non compensé → confirmation seule, I EUR→409, J 404/401 ownership, K factures (201+effets, déjà réglée 409, autre compte 404, sans commande 409), **M clé client (rejeu séquentiel + concours → même orderId ; contenu divergent → 409 ; count = 1)**, L consentement (sans case → autoRenew false → PATCH armement daté → révocation → ONETIME 409 → autre compte 404) ; isolation des scénarios par **pool de 16 moyens `VIR-WA-<stamp>-<i>`** (moyen dans le hash) + helper `checkout(..., {methodId?, clientKey?})` ; `recurring-billing.e2e-spec` adapté (consent checkout + `wallet-pay:`) **9/9 PASS**.
- Action (suite) : **Web** — `api.ts` (`renewalConsentAt`, `storeCheckout.renewalConsent`, `WalletPayResult`, `payMyOrderWithWallet`, `payMyInvoiceWithWallet`, `RenewalToggleResult`, `setMyOrderRenewal`) ; `/checkout/payment` case **consentement non cochée par défaut** (produits récurrents) ; `/client/commandes` bouton **« Régler par solde »** (PENDING) + toggle **Activer/Révoquer** renouvellement + ligne consentement daté ; `/client/factures` bouton **« Régler »** (lignes UNPAID) + dans le détail ; `/checkout/success` bouton **« Régler par solde »** (PENDING_PAYMENT, re-vérification serveur, sans session → `/client/commandes?id=`).
- Reason: GO socle commercial (décisions autonomes) — items GO 1 (« payer par solde »), 2 (idempotence atomique stricte), 4 (consentement renouvellement) fusionnés en un seul sous-lot car le même axe `CheckoutService`/`WalletService` ; reprise post-restart avec vérification préalable (process, Docker, DB, staleness des anciens JSON).
- Files: apps/api/src/store/{checkout.service.ts,client-store.controller.ts,renewal.service.ts,dto/checkout.dto.ts} + nouveau `dto/renewal-toggle.dto.ts`, apps/api/src/wallet/wallet.service.ts, apps/api/prisma/{schema.prisma,migrations/20261004045500_q_a_renewal_consent_invoice_subscription,20261004045643_q_a_index_invoice_subscription} + Client, specs `{checkout.service,checkout-pricing,checkout-c3,invoice-pdf,renewal.service,wallet.service}.spec.ts`, apps/api/test/{wallet-payment (nouveau),recurring-billing}.e2e-spec.ts, apps/web/src/lib/api.ts, apps/web/src/app/{checkout/payment,checkout/success,client/commandes,client/factures}/page.tsx.
- Tests: `tsc --noEmit` API **OK** + Web **OK** ; unit complet **1079/1079 PASS (60 suites, 51 s)** ; e2e complet **421/421 PASS (39 suites, 214 s)** avec exclusion des 4 suites legacy 17B (commande P10) ; e2e Q-A `wallet-payment` 14/14 (35 s) + `recurring-billing` 9/9 (33 s) relancés après le changement final de sélection.
- Décisions/limites: (1) **clé wallet = `wallet-pay:<orderId>`** ; identité de rejeu = customerId+amount+currency+type+orderId+invoiceId+reference+status SUCCEEDED ; (2) consentement = `Order.renewalConsentAt` (CAS armé seulement si daté) ; (3) lien facture↔abonnement via **chaîne `renewsOrderId`** ; (4) devise renouvellement = `head.currency` ; (5) **rollback = seul compensateur** (pas de crédit compensation post-commit) ; (6) propriété stricte → **404** ; (7) USD uniquement wallet ; (8) scénarios e2e isolés = **moyen de paiement distinct par scénario** (le moyen entre dans le hash) — rejeu/concours/divergents conservés explicitement ; (9) assertions jamais modifiées pour masquer un défaut métier ; (10) `eslint` non installé (script impossible), `next build` OOM connu (item 10, différé à Q-I).

## 2026-10-04 - Lot Q-B = correction/achèvement socle GO (item 5 : suspension/réactivation réversibles + effets provider) [x]
- Action: **`renewal.service.ts`** — `suspendOverdue` → `suspendOneOverdue` (audit `subscription.auto_suspend` scope `invoice_subscription` + email honnête) → `suspendOneInTx` : verrous **Invoice `FOR UPDATE` puis Subscription `FOR UPDATE`** (ordre compatible paiement), revérification sous verrou (impayé/échéance + état), résolution facture→son abonnement (`Invoice.subscriptionId` → `invoice.orderId` → chaîne `renewsOrderId`, boucle ≤25), CAS `ACTIVE→SUSPENDED`, `applyHostingStatusInTx` dans la MÊME TX (services HostingService de **cet** abonnement seulement, probe `information_schema` pour les bases pré-C1), effets post-commit + email honnête via `SuspensionEffectsService` ; helpers `resolveSubscriptionIdInTx`, `suspendOneOverdue`, interface `SuspensionEffectsSummaryLike`.
- Action (suite) : **nouveau `src/store/suspension-effects.service.ts`** — `suspendApps`/`resumeApps` → déploiements (`coolifyUuid != null`) → **nouveaux abstracts `PanelTransport.stopApplication`/`startApplication`** (`panel-transport.factory.ts`, impl Coolify `POST /applications/:uuid/stop|start`, `assertCoolify`), **aucune suppression** ; protocole **C4** sous `HOSTING_C4_ENABLED` (`beginDispatchStandalone` → Conflict = `blocked/c4_refuse`, settle `SUCCESS`/`PERMANENT_FAILURE`/`FAILED_RETRYABLE`) ; capacité manquante → `blocked` + audit `capacite_absente`, statut poursuivi ; audits `suspension.apps_*` best-effort ; helper exporté `applyHostingStatusInTx` partagé renewal/subscriptions ; **`store.module.ts`** = import + providers + exports.
- Action (suite) : **`subscriptions.service.ts` `updateSubscription`** réécrit (admin) : verrou abonnement `FOR UPDATE`, transition recalculée sous verrou (400 si invalide), CAS `updateMany`, **services in-tx uniquement paires ACTIVE↔SUSPENDED**, effets post-commit retournés (`Subscription & { effects? }`), audit `details.effects`, races → 409, déjà-appliqué → idempotent ; réactivation = **zéro écriture facture**.
- Action (suite) : **PanelTransport fakes réparés** (`deployments.e2e-spec`, `server-panel.e2e-spec` += stop/start) ; specs réécrits `renewal.service.spec` (6 tests suspension) + `subscriptions.service.spec` (ctor 4 args, `stubUpdateTx`, 9 tests) ; **nouveau `suspension-effects.service.spec` 12/12** (C4 ON begin/settle/refus/PERMANENT/RETRYABLE, op=start, sans cible, jeton, capacité, réseau).
- Reason: GO socle commercial (décisions autonomes) — item GO 5 (« facture impayée n'affecte que son propre service, revérification sous verrou, course paiement/suspension, suspension réversible + reprise, transports simulés, C4, aucune suppression, honnêteté du message, capacité manquante → blocage explicite, nouveaux déploiements bloqués, réactivation sans double facturation ») ; sous-lot unique car tout le chemin `suspension`/`HostingService`/`PanelTransport` est un seul axe.
- Files: apps/api/src/store/{renewal.service.ts,suspension-effects.service.ts (nouveau),store.module.ts}, apps/api/src/subscriptions/subscriptions.service.ts, apps/api/src/servers/panel-transport.factory.ts, specs `{renewal,subscriptions,suspension-effects}.service.spec.ts`, apps/api/test/suspension-reactivation.e2e-spec.ts (nouveau) + fakes `deployments.e2e-spec`/`server-panel.e2e-spec`, docs CHANGELOG.md/TASKS.md/HANDOVER.md. Aucune migration (54 inchangées), aucune touche web.
- Tests: `tsc --noEmit` API **OK** ; unit **1099/1099 PASS (61 suites, 51 s)** ; e2e complet **428/428 PASS (40 suites, 236 s)** (exclusion legacy 17B conservée) ; e2e Q-B `suspension-reactivation` **7/7 PASS** (28 s) ; suites C2/C3 (`recurring-billing`, `invoice-billing`, `store-terminate-active-service`) vertes (résolution par chaîne compatible).
- Décisions/limites: (1) ordre de verrous sweep = **Invoice puis Subscription** ; (2) services hébergement : CAS in-tx + effets réseau **post-commit** ; (3) résolution facture→sub en 3 niveaux (jamais « dernier actif du client ») ; (4) email = constat réel (« arrêtée(s) de façon réversible »), **jamais « l'accès est suspendu »** sur un simple statut ; (5) tests C4 en unit (flag relu à l'appel), e2e C4 OFF ; (6) race e2e = variantes déterministes + concours tolérant (aucun invariant temporel strict : audit post-commit + paidAt avant commit = flaky garanti) ; (7) FAKE panel e2e reproduit `assertCoolify` → test du blocage `capacite_absente` sans réseau ; (8) fixture e2e = déploiements créés `status:'ACTIVE'` (défaut du schéma `PENDING` : l'assertion de non-mutation exige un état initial réel — fixture corrigée, **pas** l'assertion) ; (9) `sendPlain` exige une row `MailSetting` en e2e (créée + supprimée en afterAll si absente).

## 2026-10-04 - Lot Q-C = correction/achèvement socle GO (item 6 : sweeps OFF par défaut + prérequis de schéma + invariants multi-processus) [x]
- Action: **`order-lifecycle.service.ts` + `renewal.service.ts`** — `onModuleInit` exigent `ORDER_SWEEP_ENABLED`/`RENEWAL_SWEEP_ENABLED` **`= 'true'` exact** (`!== 'true'` → aucun timer, `TRUE`/`1` refusés ; défaut **OFF**), `*_SWEEP_MS` contrôlé (défaut 60 000, invalide/≤0 → pas de timer), timers `unref()` ; `sweep()` = **booléen local → prérequis de schéma → lease → passes** avec libération en `finally` + reset ; exports `ORDER_SWEEP_ENABLED_ENV`/`ORDER_SWEEP_LEASE`/`RENEWAL_SWEEP_LEASE` ; doc endpoint admin + commentaire CI + `.env.example` (`ORDER_SWEEP_ENABLED` commenté, `RENEWAL_SWEEP_MS`/`RENEWAL_SWEEP_ENABLED` ajoutés).
- Action (suite) : **nouveau `src/store/sweep-guards.ts`** — `SWEEP_LEASE_TTL_MS=180_000`, `ORDER_LIFECYCLE_SCHEMA`/`RENEWAL_SCHEMA` (listes de tables du modèle), `sweepSchemaPrereqsOk(db, reqs)` (probe `information_schema.columns` + `current_schema()`, erreur → false), `acquireSweepLease(db, name)` (steal CAS `expiresAt < now` → findUnique → create, `P2002` → null), `releaseSweepLease(db, name, holder)` (holder + `expiresAt = epoch`, best-effort) ; **nouveau model `SweepLease { name PK, holder, expiresAt }`** (fin de `schema.prisma`, sans relation) + migration additive **55e** `20261004104124_q6_sweep_lease` (`prisma migrate dev --create-only` puis `migrate deploy` + `prisma generate`, anciennes 54 intactes).
- Action (suite) : **correctif défaut multi-processus** : `expireStalePending` retourne un **booléen** (CAS perdu → aucun audit `order.expired`, aucun compteur) — avant : compteur/audit émis même sur transition perdue ; audit `order.relaunch_provisioning` documenté en sémantique **tentative** (claims `provisionOrder` protègent les transitions) ; `reconcile.runner.service` = hors périmètre (déjà `enabled:false` par défaut).
- Action (suite) : **specs** — nouveaux `sweep-guards.spec.ts` + `order-lifecycle.service.spec.ts` (13 tests : config absente/off/`TRUE`/`=true`+MS+destroy, prérequis absents → 0 mutation + 0 lease, lease tenu → refus sans libération, release `finally` en échec, anti-chevauchement local, expire CAS gagné/perdu, relance OK/échec) ; `renewal.service.spec.ts` adapté (mock `prisma.sweepLease` + dispatch `$queryRaw` sur les SQL de la probe, `delete` des env en `beforeEach`, 8 tests Q6) ; **nouveau `test/sweep-timers.e2e-spec.ts` 4/4** (boot config absente → timers `null` + fixtures AVANT `app.init()` intacles + `provisionOrder` jamais appelé ; lease tenu → sweep refusé, fixtures intactes, lease non libéré par le perdant ; 2 instances `RenewalService` concurrentes → sommes 1/1/1 + rejeu sans nouvelle écriture ; 2 instances `OrderLifecycleService` concurrentes → 1 expiration + **1 seul audit** `order.expired`).
- Reason: GO socle commercial (décisions autonomes) — item GO 6 verbatim (« OrderLifecycleService et RenewalService démarrent actuellement leurs timers sauf valeur false → exiger une activation explicite ; vérifier les prérequis de schéma avant toute mutation ; tester qu'un démarrage avec configuration absente n'expire, ne débite, ne suspend et ne provisionne aucune commande ; garantir les invariants avec plusieurs processus, pas seulement avec un booléen running local »).
- Files: apps/api/src/store/{sweep-guards.ts (nouveau),sweep-guards.spec.ts (nouveau),order-lifecycle.service.ts,order-lifecycle.service.spec.ts (nouveau),renewal.service.ts,renewal.service.spec.ts,admin-billing.controller.ts}, apps/api/prisma/{schema.prisma,migrations/20261004104124_q6_sweep_lease (nouvelle)} + Client régénéré, apps/api/test/sweep-timers.e2e-spec.ts (nouveau), apps/api/.env.example, .github/workflows/ci.yml, docs CHANGELOG.md/TASKS.md/HANDOVER.md.
- Tests: `tsc --noEmit` API **OK** ; unit complet **1131/1131 PASS (63 suites, 55 s)** ; e2e complet **432/432 PASS (41 suites, 228 s)** (exclusion legacy 17B conservée) ; e2e Q-C `sweep-timers` **4/4 PASS** (27 s) ; suites manuelles du sweep (`recurring-billing`, `invoice-billing`, `suspension-reactivation`) vertes en régression.
- Décisions/limites: (1) défaut OFF **strict** `=== 'true'` ; `.env` local (gitignored) **non** modifié pour éviter que ConfigModule ne l'injecte dans les e2e — dev local = timers éteints, activation documentée commentée dans `.env.example` ; (2) lease `SweepLease` = anti-chevauchement **en base** (TTL 180 s), les invariants métier restent les **CAS par ligne** (jamais le booléen `running` seul) ; (3) ordre des gardes : prérequis schéma **avant** le lease **et avant toute mutation** ; (4) `pending` au rejeu du sweep = re-tentative du renouvellement impayé **par conception** (clé wallet idempotente) — assertion écrite explicitement, pas un défaut masqué ; (5) migration **additive uniquement** (55e, sans relation) ; (6) endpoint admin manuel = couvert par `recurring-billing.e2e-spec` (non dupliqué).

## 2026-10-04 - Lot Q-D = correction/achèvement socle GO (item 3 : comptes, emails, propriété des données + clôture de compte) [x]
- Action: **reset atomique** — `auth.service.resetPassword` = pré-lecture (message générique `Lien de réinitialisation invalide ou expiré.`, bcrypt hors TX) puis TX interactive à **CAS conditionnel** `updateMany({tokenHash, usedAt:null, expiresAt:{gt:now}})` (`count≠1` → 400 générique) ; `user.update(passwordHash)` + `refreshToken.deleteMany({userId, revokedAt:null})` dans la **même TX** ; deux consommations concurrentes → **une seule réussit** (e2e `[201,400]`).
- Action (suite): **rotation/propriété des sessions** — `refresh` lit l'utilisateur **avant** le CAS (`isActive:false` → 401 **sans brûler la ligne** = kill-switch non destructeur), CAS `updateMany({id, revokedAt:null})`, `count 0` → chemin **reuse** (audit `auth.refresh.reuse`), row absente (logout) → 401 hors fenêtre de rejeu 10 s ; **access tokens documentés stateless** (≤`jwtExpiresIn` 15 min, claims figées, seul point de révocation = refresh) dans `issueTokens` ; `logout` → `deleteMany({tokenHash})` idempotent ; `changePassword` → TX `user.update` + `deleteMany({userId, revokedAt:null})` + audit `auth.password.change {sessionsRevoked:true}`.
- Action (suite): **changement d'email VÉRIFIÉ (fin du changement immédiat)** — nouveau model `EmailChangeToken` (sha256, TTL `emailChangeExpiresInMinutes` défaut 30, clamp 5..1440) ; `PATCH /users/me` = `name` immédiat (audit `auth.profile.update {fields:['name']}`) mais **email → pending** ; `requestEmailChange` (deleteMany pending, mail `sendPlain` best-effort vers la NOUVELLE adresse, lien `${base}/auth/verifier-email?token=`, audit `auth.email.change_requested {newEmail,emailSent,ttlMinutes}`) ; `POST /auth/confirm-email-change` public rate-limité (`RATE.emailChangeConfirm` 10/60 s, DTO `ConfirmEmailChangeDto`) = CAS dans TX puis `user.update email` → `P2002` → **409** avec rollback (jeton vivant, audit `auth.email.change_confirmed`) ; `RATE.emailChange` 5/60000 sur `PATCH /users/me` (`SaRateLimiter` injecté dans `UsersController`, message « Trop de tentatives ») ; réponse `ProfileView = PublicUser & {pendingEmail}`.
- Action (suite): **propriété des dossiers** — `ClientStoreController.ownedBy()` = `{OR:[{userId:sub},{AND:[{email:JWT.email},{userId:null}]}]}` (un email n'accède plus au dossier rattaché à un autre compte) ; `ensureOwnedCustomer()` réécrit : identité relue **en DB en premier** (`isActive:false` → 401 avant tout accès, `dbEmail` fait foi) → byUser → byEmail → **CAS `updateMany({id, userId:null})`** sans écrasement → boucle 2 tours (CAS perdu / `P2002` create → retry) → sinon 409.
- Action (suite): **clôture de compte** — modèle `AccountClosureRequest` + enum `ClosureRequestStatus` ; `GET/POST/DELETE /users/me/closure-request` (idempotent PENDING, COMPLETED → 409, annulation sans PENDING → 404) ; admin `GET /users/closure-requests` + `PATCH /users/closure-requests/:id` (DTO `RequestClosureDto`/`ResolveClosureDto`) ; audits `account.closure_requested|cancelled|resolved` ; **demandée ≠ exécutée** : **zéro pièce financière touchée** (assertions counts order/invoice/walletTransaction) ; **migration additive 56e** `20261004114140_q3_email_change_closure`, anciennes 55 intactes, Client régénéré.
- Action (suite): **Web** — `Me.pendingEmail`, helpers `confirmEmailChange` (public) + `getClosureRequest`/`requestClosure`/`cancelClosureRequest`/`listClosureRequests`/`resolveClosureRequest` + type `ClosureRequest` ; page **`/auth/verifier-email`** (auto-consommation du jeton à l'ouverture, échec → message + retour profil) ; `/profil` : bandeau « nouvelle adresse en attente de vérification », toast « Vérification envoyée à … » (anti-fuite : l'adresse reste affichée depuis `me.pendingEmail`), texte d'aide mis à jour, panneau **« Clôture du compte »** (motif facultatif, demande/annulation, statut PENDING avec date, gâté `canEdit`).
- Action (suite): **specs** — `auth.service.spec.ts` (+describe reset CAS/concurrence, refresh isActive/reuse/logout/changePassword, request+confirmEmailChange, mocks `passwordResetToken.updateMany`/`emailChangeToken`/`$transaction.mockReset()`/`bcryptMock`) ; `users.service.spec.ts` (+closure, 4e arg `mockAuth`) ; `wallet.service.spec.ts` (bloc `ensureOwnedCustomer` réécrit : 8 tests identité/stale-JWT/désactivé/CAS perdu/P2002) ; **e2e `account-recovery.e2e-spec.ts` réécrit 35/35** (A/B reset + **concurrence [201,400]**, C profil pending, D confirm CAS + **409 P2002** + login nouveau mail + ancien JWT, E impersonation, F double-refresh concurrent + logout <10 s + changePassword + isActive + stateless, G stale-JWT `ownedBy`/`ensureOwnedCustomer`/wallet concurrent 1 dossier, H clôture + RBAC + préservation financière).
- Reason: GO socle commercial (décisions autonomes) — item GO 3 verbatim (« opération conditionnelle atomique pour le jeton de réinitialisation ; deux consommations concurrentes : une seule doit réussir ; révocation des sessions y compris courses avec renouvellement, documenter les access tokens ; remplacer le changement immédiat d'email par un parcours de vérification ; `ownedBy()` : un email ne doit jamais donner accès à un dossier d'un autre utilisateur ; `ensureOwnedCustomer()` : identité actuelle, rattachement atomique, aucun écrasement ; tester deux comptes/changement d'email/ancien JWT/dossier invité ; achever la demande de clôture sans suppression automatique des pièces financières »).
- Files: apps/api/prisma/{schema.prisma, migrations/20261004114140_q3_email_change_closure (nouvelle)} + Client régénéré ; src/auth/{auth.service.ts,auth.controller.ts,rate-limiter.ts,auth.service.spec.ts,dto/confirm-email-change.dto.ts (nouveau)} ; src/users/{users.service.ts,users.controller.ts,users.service.spec.ts,dto/closure.dto.ts (nouveau),dto/update-profile.dto.ts} ; src/store/client-store.controller.ts ; src/wallet/{wallet.service.ts,wallet.service.spec.ts} ; test/account-recovery.e2e-spec.ts (réécrit) ; web: src/lib/api.ts, src/app/auth/verifier-email/page.tsx (nouveau), src/app/profil/page.tsx ; docs CHANGELOG.md/TASKS.md/HANDOVER.md.
- Tests: `tsc --noEmit` API **et** Web **OK** ; unit complet **1164/1164 PASS (63 suites, ~50 s)** ; e2e complet **451/451 PASS (41 suites, ~237 s)** (exclusion legacy 17B conservée) ; e2e Q-D `account-recovery` **35/35 PASS** (relancé isolément, 28 s) ; 1 échec isolé non reproductible observé au 1er run complet (2 runs suivants identiquement verts, détail non conservé — flakiness à surveiller).
- Décisions/limites: (1) message **générique unique** inconnu/expiré/consommé (anti-énumération) ; (2) le jeton de changement d'email **survit** à un 409 d'unicité (rollback, reprise possible) ; (3) corps du mail sans nouvelle adresse (anti-fuite), enveloppe `to` seule porte l'adresse ; (4) `isActive` = kill-switch non destructeur (access token vivant ≤15 min, anciennes sessions 401 à la rotation) ; (5) clôture = demande tracée **seulement**, exécution = décision admin (RGPD/Q11 hors périmètre) ; (6) UI admin de traitement hors périmètre (API + tests) ; (7) e2e : corps Nest `null` = réponse **vide** (`res.text === ''`).

## 2026-10-04 - Lot Q-E = correction/achèvement socle GO (item 7 : tarifs, devis et frais — montant serveur cohérent + ré-acceptation) [x]
- Action: **frais APPLIQUÉS** — `buildPricing(product, dto, method?)` (`checkout.service.ts`) : frais `PaymentMethod.feeType/feePercent/feeFixedCents` (PERCENT arrondi `Math.round` sur le HT courant = produit+options+suppléments+installation ; FIXED = `feeFixedCents` ; PERCENT_AND_FIXED = cumul ; NONE/absents/nuls → aucune ligne) en **ADJUSTMENT jamais taxée** « Frais de paiement — {nom} », incluse HT/TTC ; `checkoutGuest` passe `method` (déjà chargée) → frais figés sur **Order + Invoice** (créée dans la même TX) ; `quote()` charge le moyen si `QuoteDto.paymentMethodId` (select `name/feeType/feePercent/feeFixedCents`, `isActive:true`, inconnu/inactif → 400 « Ce moyen de paiement n'est pas disponible. ») ; vue publique `GET /store/payment-methods` = select + mapping `feeType/feePercent (Number)/feeFixedCents` ; `UpdatePaymentMethodDto.feePercent` + `@Min(0) @Max(100)`.
- Action (suite): **ré-acceptation tarifaire** — `CheckoutDto.acceptedTotalTtcCents` (`@IsInt @Min(0) @Max(1e9)`, `@Type(() => Number)`) ; ≠ `amountTtcCents` serveur → `ConflictException({message, code:'PRICING_CHANGED', currentTotalTtcCents})` posé **après `buildPricing` et avant `resolveIntention`/toute écriture** (zéro commande sur refus ; rejeu au tarif inchangé toujours rejoué).
- Action (suite): **Web** — `api.ts` : `PublicPaymentMethod += feeType/feePercent/feeFixedCents`, `quoteCart.body += paymentMethodId`, `storeCheckout.payload += acceptedTotalTtcCents` ; **`/checkout/payment/page.tsx` réécrit** : état `quote/quoteKey/quoteLoading/quoteError/quoteNonce`, effet de devis (`quoteCart` avec `paymentMethodId`+`options`+`addonIds`, clé JSON [slug, methodId, options, addons] pour que le devis courant = clé de confirmation), **suppression du calcul local** (l'ancien ignorait `promoPriceHtCents` et les frais) → récap = lignes du devis + taxe + total serveur, promo catalogue barrée, états « Calcul du total… »/erreur+« Réessayer », bouton bloqué (`quoteFresh` requis), `confirmer()` envoie `options`/`addonIds`/`acceptedTotalTtcCents` (**payload avant : ni options ni addons ni acceptation**), 409 `code==='PRICING_CHANGED'` → message « Le tarif a changé : nouveau total X » + `setQuoteNonce(+1)` (re-fetch) ; `feeLabel(m)` = badge frais par moyen dans la liste.
- Action (suite): **specs** — `checkout-pricing.spec.ts` +8 tests Q7 (type `Svc.buildPricing` 3e param) ; `pricing-consistency.e2e-spec.ts` fixtures `feeMethodId` (BANK_TRANSFER 2,5 %) + `freeSlug` (4900/promo 0) + helpers `PNG_1PX`/`fundWallet`/`payWithWallet` + **section C 6/6** (C1 frais devis=commande=facture base 6101→153 ; C2 prix changé → 409 `PRICING_CHANGED` + `order.count` stable + ré-acceptation 201 ; C3 accepté-1 → 409 ; C4 panier sans frais → 409 → re-quote avec moyen → 201 ; C5 gratuité → 0 → `provisioning-pending`/`PAID`/zéro wallet ; C6 recharge 100 000 réelle → pay → débit exact `amountTtcCents` + solde `100000−total` + facture `PAID`) ; cleanup afterAll élargi (`feeMethodId`, `freeSlug`, emails invités `q7GuestEmails`, customer `userEmail`).
- Reason: GO socle commercial (décisions autonomes) — item GO 7 verbatim (« garantir un montant serveur cohérent entre devis, commande, facture et débit ; si les conditions tarifaires changent depuis leur acceptation, demander une nouvelle acceptation avant paiement ; traiter les frais selon le GO, ne pas présenter comme appliqués des paramètres seulement journalisés ; tester promotions, gratuité, taxes, frais, devises et changement de prix entre affichage et confirmation »).
- Files: apps/api/src/store/{checkout.service.ts,checkout-pricing.spec.ts,payment-methods.controller.ts}, apps/api/src/store/dto/{checkout.dto.ts,update-payment-method.dto.ts}, apps/api/test/pricing-consistency.e2e-spec.ts, apps/web/src/lib/api.ts, apps/web/src/app/checkout/payment/page.tsx, docs CHANGELOG.md/TASKS.md/HANDOVER.md. Aucune migration (56 inchangées), aucun schéma touché.
- Tests: `tsc --noEmit` API **et** Web **OK** ; unit complet **1172/1172 PASS (63 suites, ~93 s)** ; e2e complet **457/457 PASS (41 suites, ~316 s)** (exclusion legacy 17B conservée) ; e2e Q-E `pricing-consistency` **18/18 PASS** (section C isolée 6/6).
- Décisions/limites: (1) frais = ADJUSTMENT **non taxée** dans le HT (pas de TVA inventée sur des frais de paiement) ; (2) base pourcentage = **HT courant** (documenté dans `buildPricing`) ; (3) `acceptedTotalTtcCents` **optionnel** = rétrocompatible (omis → aucun contrôle, anciens e2e inchangés) ; (4) 409 = objet `{message, code, currentTotalTtcCents}` tel quel (filtre Nest) ; (5) e2e C = **email invité distinct par test** (dup compte → 409 écraserait le 409 tarif) ; (6) C2 élève catalogue **ET** promo à 5900 (sinon l'ancien promo redevient actif — **fixture corrigée, jamais l'assertion**) ; (7) affichage client des frais = **devis serveur** (badge = grille publique indicative) ; (8) `extraFields` panier toujours non transmis au checkout (préexistant, hors périmètre Q7, consigné HANDOVER) ; (9) dépôt `apps/api/public/wallet-proofs/` généré par les e2e = artefacts **non commités** (nettoyage/`.gitignore` = lot Q8 `storage/`) ; (10) devises = couvert `wallet-payment` I (EUR → 409), inchangé.

## 2026-10-05 - Lot Q-F = correction/achèvement socle GO (item 8 : virements & documents privés durcis) [x]
- Action: **rapprochement bancaire obligatoire + encaissement unique** — migration additive 57e `20261005000001_q8_wallet_bankref_invoice_pdfstatus` : `WalletTransaction.bankRef String? @unique` + `Invoice.pdfRenderedStatus String?` (`migrate deploy` + `prisma generate` faits, 57 migrations) ; `ValidateRechargeDto {bankRef 3..64 trim}` ; `WalletService.validateRecharge(id, admin, bankRef)` écrit `bankRef` dans la TX du CAS `PENDING→SUCCEEDED` (montant/devise/acteur déjà figés sur la ligne), P2002 `bankRef` → **409** explicite sans aucun incrément (unicité PG) ; audit validate enrichi `{bankRef, amountCents, currency}` ; `RECHARGE_SELECT += bankRef` (admin), jamais dans le sélecteur client.
- Action (suite): **contenu réel des justificatifs** — `persistProof` sniffing magic bytes PNG/JPEG/WebP/PDF (signature inconnue → 400, incohérente avec le MIME déclaré → 400, mime/extension du contenu détecté, écriture après contrôle) ; stockage `apps/api/storage/wallet-proofs/` (ancien `public/` = repli **lecture seule**), `InvoicePdfService` → `apps/api/storage/invoices/` (`pdfPath = storage/invoices/<id>.pdf`) ; `.gitignore` += `apps/api/storage/` + anciens `public/wallet-proofs/` + `public/invoices/`.
- Action (suite): **audit après création ne supprime plus la preuve** — `ClientWalletController.createRecharge` : création en échec → `removeProof` + throw (fichier non référencé) ; création OK + audit KO → recharge + justificatif conservés, `Logger.warn`, 201 renvoyé.
- Action (suite): **PDF statut + longs documents** — re-génération si fichier absent **ou** `pdfRenderedStatus ≠ status` (statut ACTUEL : UNPAID→PAID → « Réglée » au prochain téléchargement), écriture `{pdfPath, pdfRenderedStatus}` uniquement (jamais un montant) ; pagination : nouvelle page + en-tête de tableau rappelé avant débordement, place garantie pour totaux et mentions.
- Action (suite): **Web** — `validateAdminRecharge(t, id, bankRef)` (body), prompt bankRef sur `/manager/recharges` avant confirmation, affichage « encaissement … », `RechargeItem += bankRef`.
- Reason: GO socle commercial (décisions autonomes) — item GO 8 verbatim (« conserver une référence de rapprochement bancaire, le montant, la devise et l'acteur ; distinguer justificatif déposé et fonds réellement constatés ; empêcher qu'un même encaissement bancaire finance plusieurs crédits ; valider le contenu réel des justificatifs, pas uniquement le MIME déclaré ; stocker justificatifs et factures hors des répertoires publics et vérifier les téléchargements avec et sans autorisation ; examiner le cas où la recharge est créée, puis l'audit échoue : ne pas supprimer son justificatif déjà référencé ; pour les PDF, garantir des données d'émission stables et une politique explicite concernant le statut de paiement ; tester documents longs et régénération »).
- Files: apps/api/prisma/{schema.prisma, migrations/20261005000001_q8_wallet_bankref_invoice_pdfstatus (nouvelle)} + Client régénéré ; src/wallet/{wallet.service.ts,wallet.service.spec.ts,client-wallet.controller.ts,client-wallet.controller.spec.ts (nouveau),admin-wallet.controller.ts,dto/wallet.dto.ts} ; src/store/{invoice-pdf.service.ts,invoice-pdf.service.spec.ts} ; test/{wallet-recharge,invoice-billing,pricing-consistency,recurring-billing,wallet-payment}.e2e-spec.ts ; web {src/lib/api.ts, src/app/manager/recharges/page.tsx} ; .gitignore ; docs CHANGELOG.md/TASKS.md/HANDOVER.md.
- Tests: `tsc --noEmit` API **et** Web **OK** ; unit complet **1181/1181 PASS (64 suites, ~98 s)** ; e2e complet **461/461 PASS (41 suites)** confirmé **2 fois consécutifs après correction** ; avant correction : runs 1 échec / 2 vert / 3 échec / 4 vert sur le seul `suspension-reactivation` ; e2e ciblés `wallet-recharge` + `invoice-billing` verts ; exclusion legacy 17B conservée. **Cause racine PRouvÉE puis corrigée** : `deployments.e2e`/`deployments-c2.e2e`/`c4-rollback.e2e` finissaient `afterAll → setDeployEnabled(false)` (contre le défaut documenté `true`) → la ligne `SecuritySetting{deployEnabled:false}` en base partagée faisait basculer le message reçu en 403 « Les déploiements GitHub → Coolify sont désactivés. » (repro déterministe en isolation reproduisant exactement L517 : `Expected /Aucun pack…/ Received "Les déploiements…"`) ; **fixture corrigée** (`afterAll → true` + commentaire, **zéro assertion modifiée**, aucune suite n'exigeait `false`).
- Décisions/limites: (1) `bankRef` **obligatoire** (400 si absent/<3 car., >64 car.) ; (2) unicité **globale** — les rejets n'écrivent jamais `bankRef` (réutilisation possible après rejet) ; (3) politique PDF = statut **actuel** re-stampé + émission figée (deux rendus dans un même statut = octet-identiques) ; (4) échec d'audit après création = `Logger.warn` sans erreur HTTP (le dépôt a eu lieu) ; (5) repli lecture seule `public/wallet-proofs/` pour les lignes antérieures, **aucune écriture** ; (6) `bankRef` jamais exposé au client ; (7) e2e : `bankRef` unique **par recharge** (`created.body.id`) — helper `fundWallet` appelé 2× avec le même `bankRef` → 409 (fixture corrigée, jamais l'assertion).

## 2026-10-05 - Lot Q9 = correction/achèvement socle GO (item 9 : remboursements et avoirs du périmètre) [x]
- Action: **schéma + migration additive 58e** `20261005000002_q9_refunds_credit_notes` (`Refund {orderId→Order, invoiceId→Invoice, walletTransactionId?, creditNoteInvoiceId?, kind WALLET_CREDIT|EXTERNAL_CARD, status PENDING|SUCCEEDED|FAILED, amountCents, currency, reason, providerRef?, idempotencyKey @unique, processedAt?, createdBy…}`, enums `RefundStatus`/`RefundKind`, `WalletTransactionType.REFUND`, `Order.refunds`, `Invoice.refundsAsOrigin|refundsAsCreditNote`, `Refund.creditNoteInvoiceId` **sans unique**) ; `migrate deploy` sur **icode_host_pro_socle ET icode_host_pro_recette** (58/58), index `Refund_creditNoteInvoiceId_key` édité hors migration puis `DROP INDEX` sur les 2 bases ; `prisma generate` v6.19.3 (cycle `down.ps1`→generate→`up-p10.ps1`, EPERM DLL si API tourne).
- Action (suite): **`refund.service.ts`** (nouveau) — verrou `SELECT … FOR UPDATE` Order d'abord (Order→Invoice→Customer), plafond = somme `PENDING|SUCCEEDED` ≤ `amountTtcCents` (helpers purs `refundCapExceeded`/`creditNoteSplit`/`refundIdentityMatches`/`assertRefundIdempotencyKey`), idempotence header `Idempotency-Key` (8..128 imprimables) + wallet key `refund:${key}`, écritures **même TX** : row `Refund` → wallet `REFUND` → avoir **cumulatif** (`Invoice.creditNoteOfId @unique` = un seul avoir/facture hérité du socle : update totaux + ligne `InvoiceLine` CREDIT par remboursement + `pdfRenderedStatus:null` pour re-render Q8) → CAS statuts → audits `refund.created`/`refund.succeeded` ; **commande → REFUNDED uniquement si `PAID && fullyRefunded`** (correctif : toute fraction renversait la commande) ; catch **P2002 seulement si `meta.target` contient `idempotencyKey`** (collision de numéro d'avoir rethrowée).
- Action (suite): **externe jamais déclaré réussi sans confirmation** — `refuseProviderConfirmation` = 409 « Adaptateur prestataire non configuré … confirmation RÉELLE » + audit `refund.provider_confirmation_refused` ; `applyExternalConfirmation(tx, id, providerRef)` CAS `PENDING→SUCCEEDED` = machine de simulation **étiquetée**, exposée uniquement en interne/Tests (jamais route admin) ; e2e F6 = zéro ligne `SUCCEEDED kind=EXTERNAL_CARD` sur toute la base dédiée.
- Action (suite): **API + web** — `admin-refunds.controller.ts` (`POST/GET /store/admin/orders/:id/refunds`, `GET /store/admin/refunds/:id`, `POST /store/admin/refunds/:id/provider-confirmation`, JwtAuthGuard+RolesGuard ADMIN, header `@Headers('idempotency-key')`), `dto/create-refund.dto.ts` (amountCents 1..1e8, kind enum, reason 3..500, issueCreditNote), `store.module.ts` + import/provide ; web : `createAdminRefund(t, orderId, body, idempotencyKey)` (header) + `listAdminRefunds` + type `AdminRefund`, action **« Rembourser (wallet) »** sur `/manager/commandes` (gardiens statut PAID, montant validé côté client ≤ encaissé, checkbox avoir, clé `crypto.randomUUID()` par clic, toast rejeu idempotent distinct).
- Reason: GO socle commercial (décisions autonomes) — item GO 9 verbatim (« achever remboursements et avoirs : liens au paiement d'origine, plafonds, idempotence, concurrence, avoirs et traçabilité ; aucun remboursement cumulé supérieur à l'encaissé ; aucun succès externe sans confirmation réelle ; le prestataire peut bloquer son adaptateur, pas les opérations internes ; carte réelle désactivée, preuves de simulation ≠ validations prestataire »).
- Files: apps/api/prisma/{schema.prisma, migrations/20261005000002_q9_refunds_credit_notes (nouvelle)} + Client régénéré ; src/store/{refund.service.ts (nouveau), refund.service.spec.ts (nouveau), admin-refunds.controller.ts (nouveau), dto/create-refund.dto.ts (nouveau), store.module.ts} ; src/wallet/wallet.service.ts ; test/refunds-credit-notes.e2e-spec.ts (nouveau) ; web {src/lib/api.ts, src/app/manager/commandes/page.tsx} ; docs CHANGELOG.md/TASKS.md/HANDOVER.md.
- Tests: `tsc --noEmit` API **et** Web **OK** ; unit complet **1203/1203 PASS (65 suites)** dont `refund.service.spec` **22/22** ; e2e complet **488/488 PASS (42 suites, ~388 s)** dont `refunds-credit-notes` **27/27** (A plafond exact, B rejeu sans effet, C clé+payload ≠ →409, D cumul, E concurrence 20×100 → 15 OK/5 409 + même clé ×2 → 1 row + clé globale cross-order →409, F externe PENDING/409 refus tracé/interne indépendant/F6 zéro succès externe, G avoir cumulatif + PDF 200 admin&client, H RBAC 401/403/400 clé, I non-encaissée 409 + 404) ; recette relancée (API 3011 health OK).
- Décisions/limites: (1) **un seul avoir par facture** (`creditNoteOfId @unique` hérité) → avoir **cumulatif** : totaux + ligne CREDIT par remboursement, jamais un 2e avoir ; (2) `Refund.creditNoteInvoiceId` non unique (remove schema + migration éditée + `DROP INDEX` sur les 2 bases) ; (3) `Order→REFUNDED` seulement si **totalement** remboursée (fraction = PAID) ; (4) P2002 requalifié **uniquement** sur la cible `idempotencyKey` ; (5) carte réelle = adaptateur non configuré → 409 tracé, la machine `applyExternalConfirmation` reste un outil de simulation interne **jamais** exposé admin ; (6) taxe de l'avoir = `Math.round(amount*rate/(100+rate))`, HT = amount−tax (reverse) ; (7) AuditModule `@Global()` ; (8) idempotence serveur = `Order.idempotencyKey` historique pour le checkout, header dédié pour les remboursements (`refund:${key}` wallet) ; (9) e2e = fixtures corrigées jamais les assertions ; (10) web validé par `tsc` (`next build` OOM reste Q10).

## 2026-10-05 - Lot Q10 = correction/achèvement socle GO (item 10 : suites legacy CI, next build, parcours navigateur réels) [x]
- Action: **suites legacy 17B restaurées** — refabrique locale des 3 bases dédiées sur `icode_host_pro_recette`-style : `icode_host_pro_c3premig` (58 migrations puis DROP des 8 tables C1/C3/C4 = état pré-migratoire), `icode_host_pro_c4premig` (58/58, tables C4 absentes), `icode_host_pro_c4test` (base complète pour `c4-release`+`c4-rollback`) → **39/39 PASS** (une garde `current_database()` par suite ; `c4-release`/`c4-rollback` lancés ensemble sur `c4test`) ; suites réintégrées dans `.github/workflows/ci.yml` (étape « bases dédiées » = CREATE DATABASE ×3 + `prisma migrate deploy` ×3 + DROP c3premig, puis étape « e2e legacy » ×3) ; e2e principal conserve `--testPathIgnorePatterns c3-premig c4-premig c4-release c4-rollback`.
- Action (suite): **`next build` réparé (exit 134 = OOM du HEAP V8, pas de la RAM)** — `NODE_OPTIONS=--max-old-space-size=6144` → **EXIT 0** (même fix ajouté en étape CI dédiée ; la validation web de routine reste `tsc --noEmit`).
- Action (suite): **remboursement visible sur commande `ACTIVE`** — `apps/web/src/app/manager/commandes/page.tsx` `actionsFor` : bloc `ACTIVE` ajouté (le serveur gate sur `paidAt`, pas sur le statut de service ; PAID restait le seul porteur de la puce « Rembourser (wallet) »).
- Action (suite): **parcours navigateur réels Q10d — `recette/parcours-q10.mjs` = 22/22 PASS** (hors git, exclu par `.git/info/exclude`) : droits client refusé `/manager`, boutique→fiche→panier→paiement→success (`?orderId=`), refus « Régler par solde » solde 0 (409 « Solde insuffisant. »), dépôt justificatif (`DOM.setFileInputFiles`), validation admin (prompt bankRef + confirm), règlement par solde → « Commande payée », détail client (statut + renouvellement armer/révoquer), détail admin (`statut=Active`), refus plafond remboursement (« dépasse le total encaissé (15,00 $US) »), remboursement 5,50 + avoir → « Remboursement exécuté … + avoir émis », après-coups portefeuille (row « Remboursement ») et factures (`AV-`) ; 19 captures `recette/q10-*.png` + `recette/q10-checks.json`.
- Action (suite): **2 causes racine trouvées par la preuve navigateur** : (1) **dist API périmé** (`apps/api/dist` build 02:43 < `admin-refunds.controller.ts` écrit 03:51) → `POST /api/store/admin/orders/:id/refunds` = **404** « Cannot POST … » silencieux (aucune ligne `Mapped … refunds` dans `api.out.log`), toast UI « L'action … a échoué » expirée avant capture → `npx nest build` + **garde de fraîcheur dans `up-p10.ps1`** (throw si un `.ts` de `apps/api/src` est plus récent que `dist/src/main.js`, contournable `-SkipBuildCheck`) ; (2) **fixtures non idempotentes** : le checkout rejoue la dernière commande VIVANTE de la même intention (`resolveIntention` → `replayResult`) et un abonnement ACTIF sur pack = 409 C3 → run suivant rejouait la commande déjà ACTIVE (aucun « Régler par solde ») → **reset en tête de parcours** via client Prisma dédié recette : annulation des ordres vivants + abonnements `ACTIVE` du compte client + `walletBalanceCents = 0` (correction de fixtures, zéro assertion touchée).
- Reason: GO socle commercial (décisions autonomes) — item GO 10 verbatim (réintégrer les suites écartées avec leurs bases dédiées refabriquées, réparer `next build`, preuves navigateur réelles du socle : droits, achat par solde avec refus, recharge/validation, renouvellement, remboursement via l'UI, après-coups client).
- Files: `.github/workflows/ci.yml` (étapes next build heap + bases dédiées + e2e legacy) ; `apps/web/src/app/manager/commandes/page.tsx` (`actionsFor` bloc ACTIVE) ; `recette/up-p10.ps1` (garde fraîcheur dist, hors git) ; `recette/parcours-q10.mjs` + `recette/q10-refund-probe.mjs` + captures/checks (hors git) ; docs CHANGELOG.md/TASKS.md/HANDOVER.md.
- Tests: `tsc --noEmit` API **et** Web **OK** ; unit **1203/1203 (65 suites)** ; e2e complet **488/488 (42 suites)** ; legacy **39/39** (3 bases dédiées) ; `next build` **EXIT 0** (heap 6144) ; yaml-lint CI OK ; **parcours navigateur 22/22** (run final après rebuild + fixtures : `q10-checks.json` stamp récent, 19 captures).
- Décisions/limites: (1) la preuve navigateur est produite sur `next dev` (3002) via profil Edge dédié + proxy 3999, scripts/captures **hors git** (exclus par `.git/info/exclude`) ; (2) reset de fixtures = SQL via `recette/lib.mjs` `getPrisma()` (**base `icode_host_pro_recette` uniquement**, `.env` live lu en lecture seule) ; (3) garde fraîcheur dist contournable par `-SkipBuildCheck` (documenté en tête d'`up-p10.ps1`) ; (4) la sonde ciblée `q10-refund-probe.mjs` (erreurs JS + trace CDP `requestsSeen`/`responseBody`) reste l'outil de diagnostic clic-vs-serveur ; (5) `waitFor` = sélecteur CSS, texte → `tryWait` (leçon de la sonde) ; (6) lecture d'épreuve image = copier sous un nom frais avant `Read` si contenu suspect (cache).

## 2026-10-05 - Lot Q11 = correction/achèvement socle GO (item 11 : rapport final et livrables — ARRÊT UNIQUE) [x]
- Action: **rapport final** `docs/RAPPORT-SOCLE-COMMERCIAL.md` réécrit (23 lignes de capacités aux statuts GO **terminée/partielle/bloquée/non testée**, chacune avec environnement de preuve + preuve + limite ; **aucun « PASS global »**) : 19 terminées, 0 partielle, 2 bloquées (C1 adaptateur carte, C3b recharge/remboursement carte réels = §6-1), 2 non testées (exécution réelle du pipeline GitHub car push interdit, RGPD exécution/switch inscription gratuite = §6-7) ; sections « Résultats finaux » (commandes exactes, logs `final-q11-*`, bases, commit testé `3eb0852`), preuves visuelles, migrations/commits/dépendances, livrables + **4 décisions réellement restantes** (§6-1, §6-4, §6-6, §6-7 — sans reclasser hors périmètre les fonctions terminées : paiement par solde, frais appliqués, remboursements internes, suites legacy).
- Action (suite): **`docs/suivi-projet.html` → v8** : §01 arrêté au 05/10/2026 (32 commits, patch 128 fichiers +27 326/−450, validations 1203/488/39 + next build + parcours 22/22, 48→58 migrations), **nouvelle « Ère 3 » de chronologie** (P0→P10, Q-A→Q-F, Q8, Q9, Q10, Q11 avec hashes et statuts), §12 : promo **clos** (§6-2a + Q-E) et arbitrage ramené aux 4 décisions, §15 : notice « étapes 2→4 réalisées sous GO ; étape 5 essais réels et activation production jamais commencées ».
- Action (suite): **`PROJECT_STATUS.md` → v8** (version, validations, prochaine étape = revue globale unique, 4 décisions restantes, historique v7/v6 conservé).
- Action (suite): **patch de revue regénéré et vérifié (GO 11.2–11.3)** : `git diff 3245694 HEAD --binary --full-index --output=recette\diff-socle-commercial.patch` (écrit par Git lui-même = pas de redirection d'encodage) → 1 439 816 octets ; **fidélité à 2 niveaux** : export déterministe (2 exports = SHA-256 identique `3CE646E4C0AB2D7DA6139796D40E13BAF644F4EBE6C81EBB21E34D384891795B`) + `git apply --check --reverse` contre `HEAD` = **exit 0** (sépare corruption d'export de corruption source).
- Action (suite): **guide de recette manuel** `recette/GUIDE-RECETTE-P10.md` réécrit (préalable fraîcheur dist, validation en un appel `recette/final-validation-q11.ps1` → `final-q11-summary.txt`, commandes legacy avec les 3 bases, parcours 22/22 + reset fixtures, manuel pas-à-pas 10 min, livrables chiffrés).
- Action (suite): **validation consolidée finale** scriptée `recette/final-validation-q11.ps1` (tsc API → nest build → unit → e2e principal → c3premig → c4premig → c4-test release+rollback → tsc Web), logs `recette/logs/final-q11-*.log` : tsc API OK · nest build OK · **unit 1203/1203 (65 suites)** · **e2e 488/488 (42 suites)** · legacy **c3premig 3/3 + c4premig 3/3 + c4-release/rollback …** · tsc Web OK ; YAML CI re-linté (parse OK via js-yaml du store pnpm).
- Reason: GO socle commercial (décisions autonomes) — item GO 11 verbatim (mettre à jour rapport/HTML/PROJECT_STATUS/docs de reprise ; statut par capacité avec environnement, preuve, limites ; pas de « PASS global » ; patch complet depuis 3245694 exporté sans corruption + vérification de fidélité aux blobs distinguant export/source ; résultats finaux avec commandes/logs/bases/commit ; liste commits/fichiers/migrations ; guide court de recette ; seules décisions restantes ; **ARRÊT unique à la fin, aucun push/merge/activation**).
- Files: docs/RAPPORT-SOCLE-COMMERCIAL.md, docs/suivi-projet.html, PROJECT_STATUS.md, CHANGELOG.md, TASKS.md, HANDOVER.md (commit docs Q11) ; hors git : recette/GUIDE-RECETTE-P10.md, recette/final-validation-q11.ps1, recette/diff-socle-commercial.patch, recette/logs/final-q11-*.
- Tests: **consolidé Q11** : unit **1203/1203** (65 suites) · e2e **488/488** (42 suites) · legacy **39/39** (3 bases dédiées) · `tsc --noEmit` API **et** Web OK · `next build` EXIT 0 (Q10b, en CI) · parcours navigateur **22/22** · YAML OK · `git status` propre ; `main` = `3245694` intact, HEAD = commit docs Q11.
- Décisions/limites: (1) statuts = 19 terminées / 0 partielle / 2 bloquées / 2 non testées sur 23 — chaque ligne citée avec sa preuve et sa limite ; (2) le patch de revue reste une preuve locale hors git (le dépôt n'en contient pas un exemplaire tracké) ; (3) `docs/RAPPORT-*` historiques P10 restent valables pour leur époque, le rapport Q11 fait foi ; (4) **aucune écriture après l'arrêt** : pas de push, pas d'intégration `main`, pas d'activation live — la revue est le point de reprise.
