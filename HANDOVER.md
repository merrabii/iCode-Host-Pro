# HANDOVER

## Read in order
README.md → PROJECT_CONTEXT.md → PROJECT_STATUS.md → DECISIONS.md → TASKS.md → CHANGELOG.md → MASTER_PROMPT.md → docs references.

## Before changing code
Determine current phase, actual implementation, proposed versus approved decisions, blockers and owner test requirements. If unclear, analyze rather than guess.

## Current state (Phase 6 — IMPLEMENTED 2026-08-31, awaiting owner live validation + push)
Implementation is current. Summary of the stack:
- **Auth (Phase 1, ADR-015/016)**: JWT Bearer access (15m) + httpOnly refresh cookie (rotated, sha256-hashed, revocable), bcryptjs, ADMIN/USER RBAC + RolesGuard. Tables `User` + `RefreshToken` (migration `init_auth`). Web `/auth`.
- **Core model (Phase 2, ADR-017)**: tables `Product` + `Server` — PLATFORM-GLOBAL reference data, **no ownerId** (migration `init_core`). Product read = any authenticated; Product mutation & all Server routes = ADMIN only.
- **Admin console (Phase 3, ADR-018)**: `GET /api/users` + `PATCH /api/users/:id` (promote/demote, activate/deactivate) — ADMIN only, **anti-lockout guards**; `GET /api/manager/summary` — ADMIN only. Web `/manager` dashboard + catalog (status transitions, editable hostname) + `/manager/utilisateurs`.
- **Audit journal (Phase 4, ADR-019)**: table `AuditLog` (migration `init_audit`) — append-only, ADMIN read (`GET /api/audit`, paginated+filtered). `AuditModule` `@Global`. Web `/manager/journal`.
- **Invitations (Phase 5B, ADR-020)**: **`POST /api/auth/register` → 410 Gone** (inscription fermée). New accounts only via `POST /api/auth/accept-invite` (token + email + password + name). Table `Invitation` (migration `20260831084839_init_client_access`) — token sha256 (raw shown once), issuerId SetNull, TTL `INVITE_EXPIRES_IN_DAYS` default 7. ADMIN routes `GET/POST /api/invitations` + `POST /api/invitations/:id/revoke` (idempotent). Web `/manager/invitations`. **AuthModule ↔ InvitationsModule via `forwardRef` on both sides** (`acceptInvite` → `InvitationsService.consume` + existing `issueTokens`); `inviteExpiresInDays` optional in configuration.
- **Client workspace (Phase 5A, ADR-021)**: tables `Subscription` (userId Cascade, productId Restrict) + `Service` (subscriptionId Cascade, serverId nullable SetNull). Client routes (any authenticated): `GET/POST /api/client/subscriptions`, `PATCH …/:id/cancel`, `GET/POST /api/client/services`. ADMIN routes: `GET /api/admin/subscriptions` + `PATCH …/:id` (whitelist approve/reject/suspend/activate), `GET /api/admin/services` + `PATCH …/:id` (assign existing Server + REQUESTED→PROVISIONING→ACTIVE **stub**). **Ownership by possession in the service layer** (`where: {userId}` → another client's id is 404); **client listings use an explicit Prisma `select` WITHOUT `serverId`/`server`** — never expose infra. Provisioning is a status-transition stub (ADR-010/007 OUT; `Deployment` deferred). Web `/client` + `/manager/subscriptions`.
  - Prisma rule learned: `include` can't mix with scalar fields — use `.select` when you need scalars + relations (see `SERVICE_SELECT` in `subscriptions.service.ts`).
- **Mail (Phase 6, ADR-022)**: singleton `MailSetting` (migration `20260831120703_init_mail`) — `enabled`, `host`, `port`, `secure`, `user?`, `passwordEnc?`, `fromEmail`, `fromName?`. **Password AES-256-GCM at rest** (`CryptoService`, key = sha256(`ENCRYPTION_KEY`), payload base64 `iv||tag||data`; `ENCRYPTION_KEY` optional at boot, required at password save → clear 400; **never returned by the API**, only `hasPassword`). ADMIN routes `GET|PUT /api/admin/mail` (PATCH-semantics: `enabled=true` requires host+fromEmail → 400; `''` = clear on user/fromName; empty password = unchanged) + `POST /api/admin/mail/test` (uses saved config, independent of `enabled`, surfaces SMTP error as 400). Web `/manager/mail`.
  - **Invitations + email**: `InvitationsService.create` sends best-effort (never throws; `emailSent` in the return; audit `invite.email` `{email, emailSent, reason?}`); **the one-time token stays the manual fallback** in `/manager/invitations`. Link = `PUBLIC_BASE_URL + /auth?invite=<token>&email=<email>`.
  - Architecture: `MailService` is STATELESS (config passed in) to avoid the `MailSettingsService`↔`MailService` provider cycle; `MailTransportFactory` is the **test seam** — e2e overrides it (`overrideProvider(MailTransportFactory)`), so **no real SMTP is ever contacted in tests**. `MailModule` imports `AuthModule` via `forwardRef` (cycle Link **Mail→Auth→Invitations→Mail** at the module-file level — same pattern as Auth↔Invitations). `CryptoModule` is non-global. `publicBaseUrl` in config.
  - Env: `ENCRYPTION_KEY` + `PUBLIC_BASE_URL` in `.env.example` AND in local gitignored `apps/api/.env` (dev-only values) — e2e needs the key when a test saves an SMTP password.
- **Admin bootstrap**: `db:seed` (idempotent, from gitignored `.env` ADMIN_EMAIL/ADMIN_PASSWORD).
- `@nestjs/jwt` pinned `^11.0.2` (CJS) to keep jest/tsc happy. nodemailer 9.1.0 (CJS, jest-safe).
- Tests: unit **90/90** (11 suites, +27 Phase 6), e2e **61/61 8 suites** (+mail). Existing e2e suites create test users **directly via Prisma** (register is closed), except auth e2e which exercises invite→accept→login. `testTimeout: 30000` in `test/jest-e2e.json`.
- Dev servers: api :3001 running (nest watch, left up for owner Phase 6 validation); web :3000 on demand (start it WITHOUT running `web build` in parallel — `.next` corruption).
- Phase 6 needs the **owner's real SMTP** for live validation (Gmail app-password / Brevo / a local relay): configure `/manager/mail`, send a test mail, create an invitation and confirm the email arrives.

Reported decisions: ADR-001..005 + 011..014 APPROVED (Phase 0); ADR-015+016 (Phase 1); **ADR-017 (Phase 2)**; **ADR-018 (Phase 3)**; **ADR-019 (Phase 4)**; **ADR-020 + ADR-021 (Phase 5)**; **ADR-022 (mail settings + invitation emails, Phase 6 — validates a NARROW ADR-008 slice: app-level encryption at rest)** **APPROVED (2026-08-31)**; ADR-006 full, 007, 008 full, 009, 010 stay PROPOSED.

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
