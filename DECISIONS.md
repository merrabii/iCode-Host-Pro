# DECISIONS — Architecture Decision Register

## Status rules
**PROPOSED**: recommendation, not approved.
**APPROVED**: explicitly approved by owner.
**REJECTED**: explicitly rejected by owner.

Never infer approval.

## Phase 0 approval
On 2026-08-30 the owner gave an explicit GO to start Phase 0 (Architecture & Foundations) and approved decisions D1–D8 of the Phase 0 plan. The following ADR statuses were updated PROPOSED → APPROVED at the start of implementation. This is owner approval, not an inferred one. Phase 0 itself is now IN PROGRESS for implementation.

## ADR-001 — Monorepo
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: Turborepo + pnpm workspaces.

## ADR-002 — Frontend
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: Next.js App Router.

## ADR-003 — Backend
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: NestJS.

## ADR-004 — Database
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: Prisma.

## ADR-005 — API
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: versioned REST + OpenAPI.

## ADR-006 — Docker development
**Status: PROPOSED** (full scope not yet approved)
Base infrastructure compose plus development, production-like and test configurations. Redis remains conditional on final jobs architecture.
Note: the Phase 0 socle is covered separately by ADR-012 (PostgreSQL-only development compose, no Redis). ADR-006 full scope stays PROPOSED.

## ADR-007 — Async jobs
**Status: PROPOSED — NOT APPROVED**
Options discussed: BullMQ+Redis; PostgreSQL jobs/pg-boss; Temporal; custom queue. A prior recommendation favored pg-boss for self-hosted simplicity, but the owner has not approved it.

## ADR-008 — Config and encryption
**Status: PROPOSED — NOT APPROVED** (includes the Phase 0 socle config decision scope)
Direction: environment infrastructure config, database-backed configuration where appropriate, application-level authenticated encryption and validated startup configuration.
Note: ADR-008 is **not** partially approved by the Phase 0 GO. The minimal non-structuring development config socle used in Phase 0 (dev env vars, startup validation, .env.example) is a separate approved decision: see ADR-011. No secret management, no provider credential encryption and no persisted configuration architecture were decided; they remain to be decided later under a full ADR-008.

## ADR-009 — Installation lifecycle
**Status: PROPOSED**
Direction: CLI-first, resumable/idempotent phases and persisted state. Any exact dual lock mechanism previously mentioned remains a proposal, not an owner decision.

## ADR-010 — Provider adapters
**Status: PROPOSED**
Direction: fine-grained capability interfaces and provider isolation. Coolify/Hestia capabilities require verification.

# APPROVED
- ADR-001 Monorepo (Turborepo + pnpm workspaces) — 2026-08-30.
- ADR-002 Frontend (Next.js App Router) — 2026-08-30.
- ADR-003 Backend (NestJS) — 2026-08-30.
- ADR-004 Database (Prisma) — 2026-08-30.
- ADR-005 API (versioned REST + OpenAPI) — 2026-08-30.
- ADR-011 Socle config minimal Phase 0 (below) — 2026-08-30.
- ADR-012 Docker dev Phase 0 (below) — 2026-08-30.
- ADR-013 Conventions nommage (below) — 2026-08-30.
- ADR-014 Zero table métier en Phase 0 (below) — 2026-08-30.
- ADR-015 Approche authentication (below) — 2026-08-30.
- ADR-016 Modèle de données Phase 1 (below) — 2026-08-30.
- ADR-017 Modèle cœur Phase 2 : Product + Server (below) — 2026-08-31.
- ADR-018 Console d'administration /manager (below) — 2026-08-31.
- ADR-019 Journal d'audit (below) — 2026-08-31.
- ADR-020 Inscription fermée + invitations (below) — 2026-08-31.
- ADR-021 Espace client : Souscription + Service (below) — 2026-08-31.
- ADR-022 Configuration mail + emails d'invitation (below) — 2026-08-31.
- ADR-023 Design system de l'interface (below) — 2026-08-31.

## ADR-011 — Socle config minimal (Phase 0)
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: minimal non-structuring development config socle only: development environment variables, minimal startup validation (fail early on missing required socle values), `.env.example` files. Does NOT decide ADR-008 (secret management, provider credential encryption, persisted configuration architecture all remain open).

## ADR-012 — Docker dev minimal (Phase 0)
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: development compose runs PostgreSQL only in Docker Desktop (named volume, healthcheck). No Redis until the async jobs architecture (ADR-007) is decided. Does NOT supersede full ADR-006.

## ADR-013 — Conventions de nommage (Phase 0)
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: root package `icode-host-pro`; applications in `apps/web` (frontend, Next.js) and `apps/api` (backend, NestJS); shared code in `packages/`.

## ADR-014 — Zero table métier en Phase 0
**Status: APPROVED** (2026-08-30, Phase 0 GO)
Decision: no artificial domain table (no HealthCheck). The Phase 0 Prisma schema declares no business models. DB/Prisma connectivity is proven by a real raw query (`SELECT 1`) in the health check. The only database artifact is Prisma's own `_prisma_migrations` framework table (baseline for the real migration chain). Any future table requires a real architectural justification in its phase.

## ADR-015 — Approche authentication (Phase 1)
**Status: APPROVED** (2026-08-30, Phase 1 GO)
Decision: stateless JWT Bearer access token (short-lived) + refresh token in a httpOnly cookie (rotated, revocable, persisted in DB). Password hashing with bcrypt. RBAC minimal: `role` (ADMIN/USER) on User + guards. Registration open in Phase 1 (to be tightened later). OAuth, MFA, password-reset, email verification fully deferred.

## ADR-016 — Modèle de données Phase 1
**Status: APPROVED** (2026-08-30, Phase 1 GO)
Decision: first real justified business tables — `User` (email unique, password hash, name, role, active) and `RefreshToken` (hashed token, FK user, expiry, revocation, for rotation). Introduces the real migration baseline (`_prisma_migrations`), superseding the zero-table Phase 0 (ADR-014) for the auth domain only. No provider credentials, no other domain tables yet.

## ADR-017 — Modèle cœur Phase 2 : Product + Server (globaux plateforme)
**Status: APPROVED** (2026-08-31, Phase 2 GO)
Decision: the Phase 2 core domain introduces exactly TWO platform-GLOBAL reference
entities, possessed by the PLATFORM (administered in `/manager`), carrying NO
ownerId:
- `Product` — catalogue item (managed offering), global reference.
- `Server` — infrastructure host (VPS / Coolify / HestiaCP / future), global,
  internal data.
These are NOT client-owned. Client-owned resources (Subscription / Service /
Deployment…) are explicitly deferred and will be introduced only when a real
workflow needs them — NOT in Phase 2. No Provider table (deferred to a future
Providers phase, ADR-010 remains PROPOSED), no Deployment join yet.
Access (via existing Role, ADR-015): `Product` read = any authenticated
(ADMIN+USER); `Product` mutation & all `Server` routes = ADMIN only (internal
infrastructure must never be exposed to clients). Admin bootstrap via an
idempotent seed (`db:seed`); credentials from gitignored `.env`, placeholders in
`.env.example`, no real secret in Git. ADR-006/007/008/009/010 unchanged.

## ADR-018 — Console d'administration /manager (Phase 3)
**Status: APPROVED** (2026-08-31, Phase 3 GO)
Decision: complete the admin console (`/manager`) WITHOUT touching the data
model (reuses `User.role`/`isActive`, `Product.status`, `Server.status`; no new
table, no migration):
- Account management — ADMIN only: `GET /api/users` (list, no passwordHash),
  `PATCH /api/users/:id` (promote/demote `ADMIN↔USER`, activate/deactivate).
  **Anti-lock-out guards**: you may never change your own role or deactivate your
  own account; the platform must keep at least one active ADMIN (refusing the
  demotion/deactivation of the last active ADMIN). Both are ForbiddenException.
- Dashboard — ADMIN only: `GET /api/manager/summary` aggregates product/server/
  user counts by status/role.
- `Product` status transitions and `Server` status/hostname editing remain
  ADMIN-only via the existing `PATCH /products/:id` and `PATCH /servers/:id`.
Registration remains OPEN (deferred from ADR-015) — the owner explicitly kept
closing registration / an invitation flow OUT of Phase 3 ("plus tard"). Providers
(ADR-010), jobs/Redis (ADR-007), OAuth and client ownership (ADR-017) unchanged.

## ADR-019 — Journal d'audit (Phase 4)
**Status: APPROVED** (2026-08-31, Phase 4 GO)
Decision: introduce an **append-only audit journal** to trace sensitive platform
actions ("qui a fait quoi"), readable only by ADMIN:
- New table `AuditLog` (migration `init_audit`): `actorId` (nullable FK → User,
  `onDelete: SetNull`), `actorEmail` (dénormalisé, survit à la suppression/renommage),
  `action` (code machine), `resourceType`/`resourceId` (Strings **polymorphes**,
  pas de FK), `details` (Json optionnel), `createdAt`. Index sur `createdAt`,
  `resourceType`, `action`.
- **Append-only** : aucun endpoint de mise à jour/suppression. Pas de scellement
  cryptographique (hors périmètre).
- Lecture **ADMIN only** : `GET /api/audit` (pagination offset/limit + filtres
  `actorId`, `action`, `resourceType`, `from`, `to`). Écriture émise CÔTÉ SERVIVE
  (jamais par un client), via appels explicites dans la couche service (pas de bus
  d'événements — choix réversible, zéro nouvelle dépendance).
- Événements journalisés : mutations sensibles (users promote/demote/
  activate/deactivate ; products & servers create/update/delete) **+** auth
  (register, login, refresh, logout).
- `AuditModule` est `@Global` (expose `AuditService`) pour être injecté sans
  import par module ; il ré-enregistre localement `JwtModule` + `RolesGuard` pour
  éviter une dépendance circulaire avec `AuthModule`. La journalisation est
  best-effort : un échec d'écriture ne casse jamais l'opération métier.
- ADR-006/007/008/009/010 unchanged ; registration toujours ouverte (différé).

## ADR-020 — Inscription fermée + invitations (Phase 5B)
**Status: APPROVED** (2026-08-31, Phase 5 GO — propriétaire : « A puis B », la fermeture
de l'inscription d'abord)
Decision: **l'inscription libre est fermée**. `POST /api/auth/register` renvoie
**410 Gone** (« inscription fermée — utilisez une invitation »). Le seul moyen de
créer un compte USER est d'accepter une **invitation ADMIN** :
- Table `Invitation` (migration `init_client_access`) : `email`, `tokenHash`
  (sha256 du jeton brut, unique — le brut n'est JAMAIS persisté, comme le refresh),
  `issuerId` (FK → User, `onDelete: SetNull` — les invitations d'un admin supprimé
  survivent), `expiresAt`, `usedAt`/`revokedAt` (nullable), `createdAt`,
  `@@index([email])`.
- Interface ADMIN-only : `GET/POST /api/invitations`, `POST /api/invitations/:id/revoke`
  (idempotent). Jeton unique imprévisible (`randomBytes(32)` base64url), retourné
  **une seule fois** à l'admin et surfacé dans `/manager/invitations` tant qu'aucune
  stratégie email n'existe. Durée de vie `INVITE_EXPIRES_IN_DAYS` (défaut 7).
- Acceptation : `POST /api/auth/accept-invite` (token + email + mot de passe + nom
  optionnel). Refus si invalide / révoqué / utilisé / expiré / email ≠ email invité
  (400). Crée un compte `USER`, marque `usedAt`, puis émet les jetons comme un login.
- Événements d'audit : `invite.create`, `invite.revoke`, `invite.accept`.
- Le seed admin (Phase 2) et tous les comptes ADMIN existants sont inchangés.
  OAuth/MFA/password-reset/email toujours différés.

## ADR-021 — Espace client : Souscription + Service (Phase 5A)
**Status: APPROVED** (2026-08-31, Phase 5 GO — propriétaire : « c'est l'admin qui doit
ajouter et modifier et gérer les serveurs complètement mais le client ne manipule pas
l'infra »)
Decision: premier **workflow client** (ADR-017 le différait faute de besoin réel) :
un USER **souscrit** à un `Product` du catalogue ; l'ADMIN **approuve** ; le client
**demande un `Service`** ; l'ADMIN **affecte un serveur** et (stub) fait avancer le
statut. Le client **ne touche jamais l'infrastructure** (aucune donnée serveur exposée).
- Tables (migration `init_client_access`) :
  - `Subscription` (client-owned) : `userId` FK → User (`onDelete: Cascade`),
    `productId` FK → Product (`onDelete: Restrict`), `status`
    (`PENDING`/`ACTIVE`/`REJECTED`/`SUSPENDED`/`CANCELLED`, défaut PENDING), timestamps,
    `@@index([userId])`, `@@index([status])`.
  - `Service` : `name`, `subscriptionId` FK → Subscription (`onDelete: Cascade`),
    `serverId` (nullable, FK → Server `onDelete: SetNull` — le service peut exister
    sans serveur), `status` (`REQUESTED`/`PROVISIONING`/`ACTIVE`/`PROBLEM`/
    `SUSPENDED`/`REMOVED`, défaut REQUESTED), `@@index([subscriptionId])`.
- Accessibilité **par possession, couche service** : les lectures/mutations client
  passent toujours par `where: { userId: actor }` ; l'id d'un autre client renvoie
  **404** (pas de fuite d'existence). `Deployment` reste différé.
- Routes client (tout authentifié) : `GET/POST /api/client/subscriptions`,
  `PATCH /api/client/subscriptions/:id/cancel`, `GET/POST /api/client/services` (le
  `serverId` n'est PAS dans le DTO client). Catalogue = `GET /api/products` existant.
- Routes admin (RolesGuard ADMIN) : `GET /api/admin/subscriptions`,
  `PATCH /api/admin/subscriptions/:id` (whitelist : approve PENDING→ACTIVE, reject
  PENDING→REJECTED, suspend ACTIVE→SUSPENDED, activate SUSPENDED→ACTIVE),
  `GET /api/admin/services`, `PATCH /api/admin/services/:id` (affecter un serveur
  existant + transitions REQUESTED→PROVISIONING→ACTIVE).
- Le provisionnement est un **stub de transition de statut** : aucun déploiement
  réel (ADR-010), aucun job asynchrone (ADR-007) — inchangés/hors périmètre.

## ADR-022 — Configuration mail + emails d'invitation (Phase 6)
**Status: APPROVED** (2026-08-31, Phase 6 GO — propriétaire : « l'admin doit pouvoir
ajouter/modifier/gérer la configuration de mail depuis l'interface admin (smtp, host,
port…) avec possibilité de tester avec envoi de mail test » ; périmètre « Mail seul »
choisi sur AskUserQuestion — OAuth/MFA/Turnstile différés)
Decision: fin du jeton affiché manuellement quand aucune stratégie email n'existe.
L'ADMIN gère une configuration SMTP singleton depuis `/manager/mail` et peut envoyer
un mail de test ; quand l'envoi est activé, chaque invitation émet un email
**best-effort** (jamais bloquant) avec le lien `/auth?invite=<token>&email=<email>`.
- Table `MailSetting` (migration `init_mail`) — singleton géré par `firstOrCreate` :
  `enabled` (active l'envoi AUTO sur invitations ; le test fonctionne dans tous les
  cas), `host`, `port` (587 STARTTLS défaut, 465 = `secure`), `secure` (TLS implicite),
  `user?`, `passwordEnc?`, `fromEmail`, `fromName?`.
- **Chiffrement au repos** (choix propriétaire) : mot de passe SMTP chiffré
  AES-256-GCM (clé = sha256(`ENCRYPTION_KEY`), payload base64 `iv||tag||data`) via
  `CryptoService` (`src/crypto/`, non-global). **Jamais renvoyé par l'API** : le DTO
  masqué expose seulement `hasPassword`. `ENCRYPTION_KEY` est optionnelle au boot
  (comme `INVITE_EXPIRES_IN_DAYS`) ; absente → 400 clair à l'enregistrement d'un mdp.
  - Valide un **périmètre étroit d'ADR-008** (chiffrement applicatif au repos) ; le
    ADR-008 complet (gestion de secrets, architecture de config persistée),
    ADR-006/007/009/010 restent PROPOSED.
- Découplage d'envoi : `MailService` est **sans état** (config passée en paramètre) —
  évite un cycle de providers avec `MailSettingsService` (qui possède lecture/ligne +
  déchiffrement) ; `MailTransportFactory` est la **couture de test** que l'e2e
  surcharge (`overrideProvider`) → aucun SMTP réel en test. L'endpoint de test (POST
  `/api/admin/mail/test`) remonte l'erreur SMTP dans un 400 pour aider l'admin.
- Routes (ADMIN) : `GET|PUT /api/admin/mail`, `POST /api/admin/mail/test` ;
  PATCH-semantics (`undefined` = inchangé, `''` = effacé sur les champs nullables).
- Invitations (`src/invitations/`) : `MailModule` importé, `sendInvitationMail`
  best-effort (try/catch, never throw) ; le token à usage unique reste le fallback
  affiché dans `/manager/invitations` ; retour enrichi `emailSent` ; audit
  `mail.settings.update` / `mail.test` / `invite.email` (masqué).
- Front : page `/manager/mail` (badge Configuré/Non configuré, warning `hasPassword`,
  section test SMTP), messages `emailSent` dans `/manager/invitations`.
- Hors périmètre (inchangés) : OAuth/MFA/Turnstile (différés par le propriétaire),
  billing, deploy réel (ADR-010), jobs async (ADR-007), storage d'assets, ADR-008 complet.

## ADR-023 — Design system de l'interface (Phase 7)
**Status: APPROVED** (2026-08-31, GO explicite du propriétaire : « Ne copier que le style
et couleurs complet (sidebar + topbar + cartes…) de la page html envoyée et oublier tout
le reste. le system ne doit absolument pas etre liée a une brand et tout doit etre
modifiable. »)
Decision: reproduction **à l'identique** du style et des couleurs de la page HTML fournie
par le propriétaire (dashboard d'hébergement, thèmes dark/light, vert marque `#00b377`).
Tout le contenu métier de la référence est ignoré (aucune marque tierce). La console
iCode Host Pro passe du style inline ad hoc à ce design system.
- **Tokens = variables CSS** (`apps/web/src/app/globals.css`) : palette dark/light
  complète extraite de la référence (bg/sidebar/header/card/border/text/active…),
  teintes badges/icônes, polices `--font`/`--mono`, dimensions sidebar 280px / topbar
  64px, rayons, ombres, breakpoints. Source : `docs/design/DESIGN_SYSTEM.md`.
- **Brand-agnostic** : aucun élément de design ne porte de marque. La marque vit
  uniquement dans `apps/web/src/config/brand.ts` + tokens `--brand-primary*` (rebrand
  différé « iCode Host Pro → Code Diali » = modifier uniquement ces deux endroits).
- **Tout modifiable** : chaque couleur/dimension/police/effet est une variable CSS ;
  aucun style inline métier dans les pages.
- Thème `data-theme` sur `<html>`, **dark par défaut**, persisté (`localStorage
  ihp-theme`), **script anti-FOUC** inline dans `layout.tsx`, bascule dans la topbar.
- Composants : shell + topbar + sidebar + nav, héros, stats, panneaux, boutons, badges,
  inputs/selects/tables, alertes — classes globales réutilisables + fins wrappers
  (`components/ui.tsx`, `components/app-shell.tsx`, `components/icons.tsx`).
- Toutes les pages (`/`, `/auth`, `/manager*`, `/client`) sont refactorées avec le
  design system, **logique métier inchangée** (mêmes appels/états/handlers).
- Pas de framework CSS, pas de Tailwind, pas de dépendance côté style (comme la
  référence). Aucune table, aucune migration, aucun changement API.
- Hors périmètre : redesign du contenu métier de la référence (non copié), tout
  autre changement visuel au-delà des tokens copiés.

# REJECTED
None recorded in this clean baseline.
