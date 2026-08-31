# PROJECT_STATUS — iCode Host Pro

## Overall status
**PHASE 5 COMPLETE 2026-08-31 — ESPACE CLIENT + ACCÈS SÉCURISÉ (ADR-020 invitations, ADR-021 client workspace). En attente de validation live et de push.**

## Current phase
**Phase 5 — Inscription fermée + invitations (5B) puis espace client (5A). IMPLEMENTED + tests verts. Awaiting owner live validation / push.**

## State (real, as of this update)
- Monorepo: pnpm workspaces + Turborepo (ADR-001). `apps/web` (Next.js 15), `apps/api` (NestJS 11), `packages/` reserved.
- API: `GET /api/health` (app + real DB connectivity via `SELECT 1`), validated startup config socle (ADR-011), global `/api` prefix, dev CORS, OpenAPI/Swagger at `/api/docs` (ADR-005).
- **Auth (Phase 1, ADR-015)**: stateless JWT Bearer access (short-lived `15m`) + refresh httpOnly cookie (rotated, revocable, sha256-hashed). bcryptjs. RBAC `ADMIN | USER` + guards. **Phase 5 (ADR-020) : `POST /api/auth/register` → 410 Gone (inscription fermée)**; `POST /api/auth/accept-invite` (token + email + password + name) crée le compte USER. Endpoints: `login`, `refresh`, `logout`, `GET /api/users/me`.
- DB: migrations `init_auth` (users/refresh_tokens), `init_core` (Product/Server), `init_audit` (AuditLog) et **`20260831084839_init_client_access`** (Invitation + Subscription + Service + enums SubscriptionStatus/ServiceStatus). `prisma migrate status` → up to date (4 migrations). Prisma client 6.19.3.
- **Invitations (Phase 5B, ADR-020)**: table `Invitation` (email, `tokenHash` sha256 unique, `issuerId` FK User SetNull, `expiresAt`, usedAt/revokedAt). Routes ADMIN `GET/POST /api/invitations` + `POST /api/invitations/:id/revoke` (idempotent); jeton `randomBytes(32)` retourné une seule fois; TTL `INVITE_EXPIRES_IN_DAYS` (7). Audit `invite.create/revoke/accept`. Web **`/manager/invitations`** (créer, lien copiable 1×, statuts, révoquer).
- **Espace client (Phase 5A, ADR-021)**: `Subscription` (userId FK User Cascade, productId FK Product Restrict, PENDING/ACTIVE/REJECTED/SUSPENDED/CANCELLED) + `Service` (name, subscriptionId FK Cascade, serverId nullable FK Server SetNull, REQUESTED/PROVISIONING/ACTIVE/PROBLEM/SUSPENDED/REMOVED). Client (tout authentifié): catalogue `GET /api/products`, `GET/POST /api/client/subscriptions`, `PATCH …/cancel`, `GET/POST /api/client/services`. Admin: `GET /api/admin/subscriptions` + `PATCH /api/admin/subscriptions/:id` (whitelist approve/reject/suspend/activate), `GET /api/admin/services` + `PATCH /api/admin/services/:id` (affecter serveur existant + REQUESTED→PROVISIONING→ACTIVE **stub**). **Ownership par possession** (id d'un autre client → 404); listing client SANS `serverId`/`server` (zéro infra). Web **`/client`** + **`/manager/subscriptions`**.
- **Audit (Phase 4 + 5)**: événements `invite.*`, `subscription.*`, `service.*` ajoutés aux libellés du journal web.
- Web: `/auth` (login + formulaire accept-invitation prérempli par `?invite=…&email=…`); `/client` (catalogue, s'abonner, annuler, demander un service, statuts); `/manager/invitations`; `/manager/subscriptions`; nav racine + `/manager` enrichies. Token toujours minted from the httpOnly refresh cookie, jamais en localStorage.
- `AuthModule` ↔ `InvitationsModule` reliés via `forwardRef` (accept-invite ↔ guards). `inviteExpiresInDays` dans `configuration.ts` (optionnel).
- Docker Postgres 16 (ADR-012) up and healthy.

## Verified (Phase 5 — real checks, 2026-08-31)
- Unit **62/62** (8 suites : health 2, products 5, servers 4, users 10, manager 2, audit 5, **invitations 11**, **subscriptions 16**).
- e2e **51/51, 7 suites** (health, auth réécrit invite→accept→login, core RBAC, admin RBAC, audit RBAC, **invitations**, **client**). Les 4 suites existantes créent désormais leurs users via Prisma (register fermé). `testTimeout` e2e 30s.
- Builds API + web PASS (routes `/`, `/auth`, `/client`, `/manager`, `/manager/invitations`, `/manager/journal`, `/manager/subscriptions`, `/manager/utilisateurs`). Typecheck web PASS.
- Live smoke API :3001: `/api/health` ok; register → **410**; login seed admin → token; `GET /api/products` 200; `GET /api/invitations` (ADMIN) 200.
- Migration `20260831084839_init_client_access` appliquée ; `prisma migrate status` → up to date.

## Pending
- Owner live validation (invite → accept → login → `/client` subscribe → approve `/manager/subscriptions` → request service → assign server → ACTIVE; register → 410; client ne voit pas `/api/servers`).
- Push of Phase 5 (on owner request).
- Proposition Phase 6 (on owner request).

## Decisions
- ADR-001..005, 011..014: **APPROVED** (Phase 0). ADR-015+016: **APPROVED** (Phase 1). ADR-017: **APPROVED** (Phase 2). ADR-018: **APPROVED** (Phase 3). ADR-019: **APPROVED** (Phase 4). **ADR-020** (inscription fermée + invitations) et **ADR-021** (espace client Subscription+Service) : **APPROVED** (Phase 5 GO, 2026-08-31). ADR-006 full, 007, 008, 009, 010: **PROPOSED** (untouched). See DECISIONS.md.

## Next action
Owner live validation de la Phase 5, puis push (single commit) sur demande.

## Out of scope (do not build yet)
Déploiement réel chez un provider (ADR-010 — le provisionnement est un stub de transition), jobs/Redis (ADR-007), stratégie email pour les invitations (token surfacé dans `/manager`), billing/paiements, OAuth/MFA/Turnstile, `Deployment` (reste différé), asset storage.
