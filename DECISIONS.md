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
**Status: APPROVED** (2026-09-02, Phase 9 livrée + testée réellement)
Decision: adaptateurs fournisseurs réels via un `panelProvider` (HESTIA/COOLIFY) avec
credentials **chiffrées au repos** (AES-256-GCM, jeton jamais exposé) et **vérification d'API**
déclenchée par l'admin. `PanelTransportFactory` (couture de test type ProbeTransport) :
Coolify `GET {base}/version` Bearer (version en JSON **ou texte brut** — validé contre le vrai
panel `portal.arumdigital.com:8000/api/v1`, v4.1.2), Hestia `?cmd=sysinfo&format=json&returncode=yes`
Basic (user `api` défaut). `POST /api/servers/:id/panel-verify` (ADMIN) persiste
`panelVerifiedAt`/`panelOk`/`panelDetail` + audit `server.panel.verify`. Utilisateur de panneau
optionnel (défaut `api`). Était « premier pas réel » via la sonde (ADR-025, Phase 8) ; la Phase 9
le complète avec les credentials + la vérification d'API.

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
- ADR-024 Détails infrastructure Serveurs + pages CRUD admin larges (below) — 2026-09-01.
- ADR-025 Sonde de connectivité réelle des serveurs (below) — 2026-09-01.
- ADR-010 Provider adapters (above) — 2026-09-02, Phase 9.
- ADR-026 Auto-détection IP/port + accès direct + métriques serveur (above) — 2026-09-02, Phase 9bis.
- ADR-027 Sécurité, comptes & support (below) — 2026-09-02, Phase 10.
- ADR-028 Base de connaissance + clés Turnstile admin (below) — 2026-09-02, Phase 11.
- ADR-030 Déploiement GitHub → Coolify (below) — 2026-09-03, Phase 10bis.

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

## ADR-024 — Détails infrastructure Serveurs + pages CRUD admin larges (Phase 7ter)
**Status: APPROVED** (2026-09-01, GO du propriétaire posé via AskUserQuestion : « créer un menu
dans la sidebar pour les serveurs… modifier encore la partie des infos affichées (et modifiables)
sur l'interface admin » + choix explicites « Page Produits dédiée aussi », champ IP/Port/Fournisseur/
Région/Quota, case à cocher TLS strict, « Module de Panneau Serveur (HESTIA/COOLIFY d'abord,
cPanel/DirectAdmin ensuite) »)
Decision: la fiche d'infrastructure sera pilotée « au fur et à mesure » quand la connexion réelle
des serveurs sera établie (ADR-010/ADR-007 futures). Pour accueillir ces futurs connecteurs, la
page admin dédiée de gestion des serveurs est construite dès maintenant avec un **registre de détails
d'infrastructure** :
- **Extension du modèle `Server`** (migration `init_server_details`) — tous les nouveaux champs
  **optionnels** pour ne jamais bloquer la création d'un hôte :
  - `ipAddress String?` (IPv4/IPv6, sans validation stricte à ce stade — format libre limité 64),
  - `port Int?` (1–65535, défaut SSH 22 documenté),
  - `provider String?` (Hetzner, OVH… — libre, pas un enum tant que l'offre n'est pas stable),
  - `region String?` (région/localisation du datacenter),
  - `quotaMaxAccounts Int?` (quota maximal de comptes hébergés sur l'hôte),
  - `strictTls Boolean @default(true)` (vérification stricte des certificats SSL/TLS sur les
    futures requêtes API du serveur),
  - `panelProvider ServerPanelProvider @default(NONE)` — **enum d'adaptateur** :
    `NONE | HESTIA | COOLIFY`, commenté pour l'ajout futur de `cPanel`, `DirectAdmin`, etc.
- **Pages admin larges dédiées** (sidebar — les pages ne sont plus centrées étroites) :
  - `/manager/serveurs` : table CRUD **ADMIN-only** large (Serveur, IP, Port, Fournisseur, Région,
    Quota, TLS, Panneau, Statut, Actions) avec **édition inline** complète ; prête à accueillir les
    statuts PROVISIONING/ACTIVE/PROBLEM **pilotés par la connexion réelle** (aujourd'hui saisis
    manuellement, note explicite dans l'UI).
  - `/manager/produits` : table CRUD ADMIN (Produit, Type, Statut, Actions) — même refonte large.
  - **Dashboard `/manager` passé en LECTURE SEULE** : synthèse (stats + derniers serveurs/produits)
    + liens « Gérer → » vers les pages dédiées ; **plus aucune édition depuis le dashboard**.
- **Conteneur élargi** : `wrap-md` 900 → **1320px** + table horizontale `.table-wide` (le bug
  « boutons serveurs derrière la case produits » de l'ancien dashboard 2 colonnes étroites est
  structurellement éliminé).
- **Évolutivité** : le `panelProvider` prépare l'ADR-010 (adaptateurs Coolify/Hestia, puis
  cPanel/DirectAdmin) ; le registre de détails alimentera les futures observations de
  connexion/charge. Le provisionnement reste un **stub** (ADR-021) — pas de déploiement réel,
  pas de jobs async (ADR-007 inchangés, PROPOSED).
- Statuts serveur saisis manuellement aujourd'hui (UNKNOWN reste le statut initial d'une création).

## ADR-025 — Sonde de connectivité réelle des serveurs (Phase 8)
**Status: APPROVED** (2026-09-01, GO du propriétaire posé via AskUserQuestion — Phase 8
« Connexion réelle des serveurs » : « Implémenter le premier connecteur (ADR-010) :
ping/détection de l'état réel d'un serveur (Hestia/Coolify), vérification de l'API,
statut PROVISIONING/ACTIVE/PROBLEM piloté par la connexion, test de connectivité depuis
/manager/serveurs. »)
Decision: **premier pas réel vers l'ADR-010** — une **sonde de connectivité** (TCP + HTTP)
déclenchée par l'admin depuis `/manager/serveurs`, qui détecte l'état réseau réel d'un
serveur et **propose** une bascule de statut. Les **adaptateurs de fournisseurs réels**
(Coolify/Hestia : appel de leur API, credentials, création de comptes) restent HORS
périmètre — la sonde est le connecteur minimal de détection d'état.
- **Modèle `Server`** (migration `init_server_check`, 7e migration) — 3 champs de résultat,
  **nullable**, jamais saisis par l'admin (écrits uniquement par la sonde) :
  `lastCheckedAt DateTime?` (dernière sonde), `lastProbeOk Boolean?` (null = jamais sondé),
  `lastProbeDetail String?` (message lisible : « TCP 22 : accessible (18 ms) », « HTTP 200 en
  45 ms », « Connexion refusée », « Délai dépassé (5 000 ms) », « Erreur TLS : … », « Hôte
  introuvable »).
- **`ProbeTransportFactory`** (`src/servers/probe-transport.factory.ts`) = **couture de test**
  sur le modèle exact de `MailTransportFactory` (Phase 6) : l'e2e la surcharge
  (`overrideProvider`) → **aucun réseau réel en test** ; l'unit test le vrai transport sur
  loopback. `ServersService` dépend de la factory (jamais du réseau).
  - **Pas de paramètre primitif injecté au constructeur** (leçon Phase 8 : un `Number` injecté
    serait résolu par Nest comme un token DI introuvable et ferait échouer AppModule en entier —
    c'est l'objet de la couture qui se fait échouer). Le timeout (défaut 5 000 ms) vit dans
    `create(timeoutMs)`, surchargeable test par test.
  - Protocole dérivé du port : `80/443/8443` ⇒ HTTP(S), sinon (SSH/autre) ⇒ TCP connect. Un
    champ `probeMode` explicite permet de forcer HTTP (sert aux tests sur port éphémère).
    `strictTls=false` désarme `rejectUnauthorized` (le cas 80/443 d'un panneau interne).
  - Toute **réponse HTTP = joignable** (même 5xx) : le code est la donnée.
- **Endpoint** `POST /api/servers/:id/check` (ADMIN) : charge le serveur, cible `hostname` +
  `port` (défaut **22**), sonde, **persiste** les 3 champs, journalise **`server.check`** dans
  l'audit (`{host, port, ok, detail, latencyMs, httpStatus, statusLeft}`). Réponse
  `{ server, probe }`.
- **Le statut reste piloté (et validé) par l'ADMIN** : la sonde **ne force jamais** le statut
  (elle écrit `lastProbe*` et propose). Sur `/manager/serveurs`, après un test, l'admin peut
  cliquer `→ ACTIVE` (résultat OK) ou `→ PROBLEM` (échec) — c'est la « bascule rapide »
  cohérente avec le résultat, un PATCH classique journalisé `server.update`. PROVISIONING reste
  saisi manuellement. Le projet vers une **politique automatique** des statuts (pilotage auto
  par sonde périodique) est mentionné mais **hors périmètre ici**.
- **UI** `/manager/serveurs` : nouvelle colonne **Connexion** — badge persistant
  (OK / Échec / — = jamais testé), détail `lastProbeDetail`, bouton **« Tester »** (spin
  pendant la sonde), et raccourci `→ ACTIVE`/`→ PROBLEM` aligné sur le dernier résultat.
- **Tests** : unit 98/98 (+ 7 : 3 check du service — succès/échec/404 — + 4 transport réel sur
  loopback : HTTP 200, TCP ok, refusée, hôte introuvable) ; e2e **67/67 (9 suites)** dont la
  nouvelle suite `server-check` (5 tests : 401/403/404, succès persisté, échec + audit
  `server.check`) — tout en surchargeant la couture (zéro réseau en test). Typecheck web + `web
  build` PASS. Smoke live : sonde réelle `localhost:5432` → « TCP 5432 : accessible (8 ms) »
  OK persisté ; `127.0.0.1:5999` → « Connexion refusée » persisté ; audit `server.check` rempli.
- **Hors périmètre (inchangés)** : adaptateurs fournisseurs réels + credentials + auto-
  provisionnement (ADR-010 complet reste PROPOSED), jobs/sondes périodiques (ADR-007),
  gestion de secrets (ADR-008 full), cPanel/DirectAdmin.

## ADR-026 — Auto-détection IP/port + accès direct + métriques serveur (Phase 9bis)
**Status: IMPLEMENTED** (2026-09-02, demande du propriétaire) — extension directe d'ADR-024/025 et
du travail ADR-010 : quand un serveur est ajouté, son **IP** (via DNS) et son **port** (dérivé de
`apiBaseUrl`) étaient vides ; pas d'accès rapide à l'hôte ; les métriques RAM/CPU/Disque/bande
passante n'existaient pas.
Decision:
- **IP auto-détectée (DNS)** à la création (si non fournie) et à l'édition (si IP précédemment vide
  ou hostname changé). Une **IP saisie manuellement n'est jamais écrasée**. Couture test dédiée
  `HostResolverFactory` (`dns.promises.lookup`, remplaçable en e2e — zéro DNS réel en test), même
  pattern que Probe/Panel.
- **Port déduit d'`apiBaseUrl`** (`http://h:8000/api/v1` → 8000 ; protocole sans port → 443/https,
  80/http). Appliqué seulement quand **aucun port n'est posé** (un port manuel reste prioritaire).
- **Accès direct** : bouton **« Ouvrir »** sur chaque carte → origine dérivée d'`apiBaseUrl` si
  présent, sinon `https://{hostname}` (onglet neuf). **Lien cliquable `apiBaseUrl`** sur la carte.
- **Métriques serveur** (`ramMb`/`cpuCores`/`diskGb`/`bandwidthLimit`, migration 9) : **auto-
  détectées** via `PanelVerifyResult.metrics` quand le panneau les expose (Hestia `sysinfo`,
  parse best-effort), **null pour Coolify (pas d'endpoint fiable → saisie manuelle par l'admin)**.
  Une métrique auto-détectée est appliquée **uniquement sur un champ vide** — ne jamais écraser une
  valeur saisie manuellement. UI : 4 champs sur la carte (— si inconnu) + section « Métriques » du
  drawer.
- **Hors périmètre** : récupération de métriques temps-réel/sondes périodiques (ADR-007), détection
  de charge, adaptateurs cPanel/DirectAdmin.

## ADR-027 — Sécurité, comptes & support (Phase 10)
**Status: APPROVED** (2026-09-02, plan Phase 10 validé par le propriétaire) — refonte
« security-first » de l'authentification + support client structuré, **toute option de
sécurité NON obligatoire** (l'admin renforce ou relâche via des flags singleton) + tickets.
Decision:
- **Feature-flags admin (singleton `SecuritySetting`, migration `init_security_support`,
  10e migration)** — pattern exact de `MailSetting` : `turnstileEnabled`,
  `oauthGoogleEnabled`, `oauthGithubEnabled`, `mfaRequiredForAdmins`,
  `selfRegistrationEnabled` (création de compte À LA COMMANDE uniquement),
  `deployEnabled` (Phase 10bis GitHub→Coolify). **Tous `@default(false)`** — rien n'est
  obligatoire. `GET/PUT /api/admin/security` (ADMIN, audit `security.settings.update`),
  enforcement central dans `SecuritySettingsService` (Turnstile seulement si activé ET
  clé présente ; fournisseur OAuth refusé (403) s'il n'est pas activé ; inscription à la
  commande fermée (403) si flag off ; MFA admin forcée au login si flag on).
- **Hiérarchie des rôles** : enum `Role` étendu `ADMIN USER SUPPORT_L1 SUPPORT_L2 SUPPORT_L3` ;
  rang linéaire `USER(0) < L1(1) < L2(2) < L3(3) < ADMIN(99)` via `auth/roles.ts`
  `ROLE_RANK` + helper exporté `roleRank` (source unique partagée par RolesGuard, tickets,
  console support). Le guard passe si `actorRank >= roleRank(requis)` — **équivalent pour
  ADMIN** (tous les `@Roles(Role.ADMIN)` rang 99 → aucune route existante ne change).
- **Impersonation « Se connecter en tant que client »** : jeton signé `role: USER` **inscrit
  à la signature** (un jeton stale reste USER même si la cible est promue) + marqueur
  `imp:{by, kind: admin|support}` qui force la **lecture seule** (verbes mutants 403) et
  **n'émet AUCUNE ligne refreshToken ni cookie** — la session meurt à son TTL (60 min,
  cap 24 h) et `POST /api/auth/refresh` ne peut jamais la prolonger. Routes : `POST
  /api/users/:id/impersonate` (ADMIN) + `POST /api/users/:id/mfa-reset` (ADMIN, secours
  anti-verrouillage) — **divergence intentionnelle du plan** : routes réelles sur
  `/api/users/:id/…` (source de vérité = client web), PAS `/admin/users/…` ; `POST
  /api/auth/impersonate/return` (200), `POST /api/support/access` (L2+, code 6 chiffres).
  Web : jeton en **sessionStorage**, bandeau rouge sur `/client`, Revenir = cleanup.
- **Code support 6 chiffres** (`SupportCode`) : généré par le CLIENT (`POST
  /api/client/support-code`, un seul actif, révocation du précédent en `$transaction`) ;
  **jamais stocké en clair** — `codeHash = HMAC-SHA256(SUPPORT_CODE_PEPPER ?? ENCRYPTION_KEY,
  code)` ; TTL 60 min (clamp 5..1440) ; montré une seule fois (canal = téléphone) ; email
  best-effort. Rédemption par L2+ (`POST /api/support/access`) : `timingSafeEqual` sur
  digests hex sans short-circuit, **verrouillage à 5 essais** (auto-révocation + audit
  `support.code.locked`), code inexistant → comparaison factice + throttle IP. Statut /
  révocation par le client (`GET/DELETE /api/client/support-code`, jamais le code).
- **MFA deux méthodes** : TOTP (otplib, `step:30 window:[1,0] digits:6`) + repli **email
  OTP** (dispo quand le mail est activé). Self-service (setup/confirm/disable via mot de
  passe + code) ; login en **deux étapes** (challenge mono-usage 300 s, lockout 5 essais,
  throttle IP, anti-replay : le challenge est détruit au succès) ; `mfaRequiredForAdmins`
  force les admins (jeton d'enrôlement limité à setup/confirm au login). Secret TOTP
  chiffré AES-256-GCM (`CryptoService`) — **jamais renvoyé** (seulement `mfaEnabled`).
- **OAuth Google + GitHub** (fetch natif, abstraction `OAuthProviderClient` injectable —
  e2e-mockable) : état CSRF signé en cookie httpOnly (`ihp_oauth_state`, 10 min, comparé
  timing-safe), **`redirect_uri` = URL PUBLIQUE** (`${PUBLIC_BASE_URL}/api/auth/oauth/:provider/callback`,
  jamais `:3001`), email **vérifié** exigé. Scénarios : **login** (email existant → MFA →
  jetons), **inscription À LA COMMANDE** (email inconnu + **checkout intent** valide
  `ihp_checkout` → création + souscription PENDING ; **jamais d'auto-création hors
  commande** — email inconnu sans intent = 403/redirect erreur), **liaison** (mode `link`,
  attache `oauthProvider/oauthSubject` au compte connecté ; conflit = déjà lié ailleurs →
  409). **Liaison de compte** (profil) : un compte email+pass peut lier Google et/ou GitHub
  et délier ; `githubTokenEnc` (AES-256-GCM) alimente la Phase 10bis.
- **Catalogue public + inscription à la commande** : `GET /api/public/products` (public —
  le visiteur consulte avant de commander) ; `GET /api/products` **reste authentifié**
  (non-régression `core.e2e-spec`). `POST /api/checkout/intent {productId}` (public) pose un
  jeton signé 10 min en cookie `ihp_checkout` ; `POST /api/auth/register` (ex-410) réouvert
  **UNIQUEMENT** avec intent valide + flag on → compte + souscription PENDING en
  `$transaction`. OAuth fait de même via le callback.
- **Tickets minimal** : modèles `Ticket` (+`TicketStatus`/`TicketPriority`, `escalatedTo`
  L2/L3 seulement) et `TicketMessage` (`authorEmail` dénormalisé, survit à la suppression
  de l'auteur). Client : ouvrir/lister/voir les siens + messages ; support ≥ L1 :
  répondre, escalader, changer le statut (via `roleRank`). Tout est audité (`ticket.*`).
- **Turnstile** : `TurnstileService` (fetch natif, skip si désactivé/sans clé), enforce sur
  `POST /api/auth/login` + `POST /api/support/access` quand activé ; widget web chargé
  seulement si `NEXT_PUBLIC_TURNSTILE_SITE_KEY` présente.
- **Rate limiter maison** (`auth/rate-limiter.ts`, fenêtre glissante en mémoire par IP, 429)
  sur login / mfa verify / mfa email send / support access / register / checkout intent.
- **Sécurité des invariants** : `mfaSecretEnc`/`githubTokenEnc`/`apiTokenEnc` JAMAIS
  renvoyés par l'API (seulement `mfaEnabled`/`hasApiToken`) ; code support jamais en clair ;
  impersonation = rôle USER forcé + lecture seule + sans refresh ; inscription à la commande
  = seul chemin de création de compte (avec OAuth via intent). Dépendance ajoutée : `otplib`
  (stub ESM en Jest via `moduleNameMapper` → TOTP accepte tout code 6 chiffres en test ;
  l'OTP email réel reste comparé timing-safe).

## ADR-028 — Base de connaissance + clés Turnstile admin (Phase 11)
**Status: IMPLEMENTED** (2026-09-02, demande propriétaire) — la base de connaissance
double-audience et le pilotage **des clés** (pas seulement des toggles) sont consignés ici ;
la refonte design/UX conversion & mobile relève de l'extension du même ADR-023 (APPROVED).
Decision:
- **Clés Turnstile saisies/modifiées par l'admin** (pas de simples boutons) : `SecuritySetting`
  + `turnstileSiteKey String?` (texte, publique — servie par `GET /api/public/auth-config`)
  + `turnstileSecretEnc String?` (AES-256-GCM, **write-only** — GET ne renvoie que
  `turnstileHasSecretKey`). Saisie « laisser vide = inchangé », `''` efface les deux → retour
  au fallback env. **Priorité DB → env** (`TurnstileService.isConfiguredAsync()`) : ce que
  l'admin a configuré gagne sur l'environnement. UI `/manager/securite` (panneau Clés +
  badges état). Invariant : le secret n'est JAMAIS renvoyé par l'API.
- **Base de connaissance « admin-only »** : `KnowledgeArticle` (audience `ADMIN`,
  types `INFORMATIVE` — récapitulatifs de phase — `TECHNICAL` — détails techniques — `HOWTO`
  — guides « comment faire », statut `DRAFT|PUBLISHED|ARCHIVED`, `slug` unique par audience,
  `summary`, `body` HTML, `category`, `phase`, `tags`, `authorEmail`). CRUD `@Roles(ADMIN)`
  audit `knowledge.*`, slug auto + collisions `-2`/`-3`. Web `/manager/connaissance`.
- **Base de connaissance client** (même modèle, audience `CLIENT`) : lectures publiques
  `GET /api/client/knowledge` — **uniquement** `CLIENT + PUBLISHED`, liste **sans** `body`,
  `.../categories`, `.../:idOrSlug` (brouillon client ou article admin → jamais exposé) ;
  l'admin gère entièrement le contenu (créer/publier/archiver pour les clients). Web `/aide`
  (centre d'aide : héro, recherche, chips catégories, cartes groupées, lecteur drawer avec
  **sanitisation défensive** du HTML — `script`/`iframe`/`on*`/`javascript:` supprimés avant
  `dangerouslySetInnerHTML`).
- **Refonte design/UX conversion & mobile (extension ADR-023, cible app.arumdigital)** :
  landing `/` vitrine (héro + showcase + 6 cartes + bandeau stats + CTA), `/offres` catalogue
  pricing, `/auth` split, **tiroir de navigation mobile** (hamburger → drawer + overlay +
  verrouillage scroll, < 900 px), topbar glass `backdrop-filter`, boutons primary gradient +
  glow + press spring, hover-lift panneaux, fonds ambiants `--bg-glow-*` + `background-attachment:
  fixed`, `--radius-hero` 18 px, animation d'entrée `.main`. Marque toujours UNIQUEMENT dans
  `config/brand.ts` + tokens `--brand-*` (rebrand Code Diali différé). **Logique métier des
  pages converties inchangée** ; aucune route/DB touchée par la refonte.
- **Invariants** : le secret Turnstile (`turnstileSecretEnc`) n'est jamais renvoyé ; un
  article client non PUBLISHED ou un article admin n'est jamais exposé au client ; la
  sanisation HTML côté client reste **défensive** (le HTML est de l'admin déjà approuvé) ;
  zéro changement de marque. Migrations 11 (`20260902070000_add_turnstile_keys`) + 12
  (`20260902080000_init_knowledge`) → 12 migrations in sync.

## ADR-029 — Trafic, quotas & suspension : architecture en 4 couches
**Status: PROPOSED** (2026-09-03, analyse `docs/traffic-quotas.md` — à valider par le
propriétaire avant toute implémentation). Distingue **mesure / quota / limitation /
suspension** et constate l'existant :
Decision (recommandée, non implémentée) :
- **Mesure** : aucune mesure de trafic persistée aujourd'hui (seul le journal d'audit
  enregistre les mutations). Si besoin réel constaté → compteurs par route/IP (inline ou
  job périodique, dépend d'ADR-007).
- **Quota** : `Server.quota` existe (ADR-024) mais **n'est pas appliqué** — décider
  explicitement s'il devient un plafond vérifié (souscriptions/services actifs, volume),
  ou le retirer du champ d'intention. Aucun quota par utilisateur aujourd'hui.
- **Limitation** : le rate limiter maison (ADR-027, fenêtre glissante mémoire, par IP) sur
  login/register/MFA/checkout/support suffit en **mono-instance** ; un store partagé
  (Redis/table) ne se justifie qu'en multi-réplicas. Budgets actuels documentés dans
  `docs/traffic-quotas.md`.
- **Suspension** : reste **manuelle** (`User.isActive`, ADR-018, gardes anti-lockout) tant
  qu'il n'y a ni facturation ni abus constaté ; l'automatisation (dépassement de quota →
  suspension) ne viendra qu'avec des quotas appliqués et sera auditée.
- **Périmètre NON retenu maintenant** : paiement/facturation, quotas appliqués, jobs
  périodiques, Redis. Aucun code introduit par cet ADR (documentaire).

## ADR-030 — Déploiement GitHub → Coolify (Phase 10bis)
**Status: IMPLEMENTED** (2026-09-03, plan validé par le propriétaire « go » — consigné, en
attente de validation live propriétaire avant commit + push).
Decision:
- **Auto-détection des repos GitHub** : store `githubTokenEnc` (AES-256-GCM, posé par la
  Phase 10/ADR-027) → `GET /api/client/github/repos` (Bearer + `X-GitHub-Api-Version:
  2022-11-28`, `GET /user/repos?per_page=100&sort=updated`) → liste `{fullName, defaultBranch,
  private, language}`. `POST /api/client/github/link-status` → `{linked, login}`.
- **Cible de déploiement** : le serveur **Coolify connecté** que l'admin a configuré
  (`panelProvider=COOLIFY` + `panelOk=true`) et affecté au `Service` ACTIVE du client — « le
  compte d'hébergement » du client. `POST /api/client/deployments {serviceId, repoFullName,
  branch}` vérifie `deployEnabled` (SecuritySetting, OFF par défaut) + propriété du repo +
  service ACTIVE sur serveur Coolify.
- **Transport** : extension `PanelTransport` (factory, e2e-mockable) — `createGitApp` (`POST
  /applications/public`, **endpoint CONFIRMÉ contre Coolify 4.1.2 réel** : `/applications/git`
  n'existe pas sur cette version, 404), `deployApp` (`POST /applications/{uuid}/deploy`),
  `deploymentStatus` (`GET /applications/{uuid}`, best-effort, ne rejette jamais).
- **Modèle** `Deployment` (PENDING/DEPLOYING/ACTIVE/FAILED, `detail?`, `coolifyUuid` **jamais
  exposé** à l'API — cohérent ADR-021). Audit `deploy.create` / `deploy.failed` /
  `deploy.status`. Rafraîchissement live au `GET /api/client/deployments/:id` quand DEPLOYING.
- **Exigence opérationnelle documentée** : Coolify exige un **jeton API ROOT / write-scope**
  pour créer une application (un jeton lecture seule répond 403 « Missing required
  permissions: write ») — comportement attendu de Coolify, pas un bug du code.
- **Repos PRIVÉS = follow-up** (déploiement initial : repos publics) via GitHub App Coolify,
  documenté hors de l'implémentation actuelle.
- **Périmètre NON retenu maintenant** : GitHub App/private repos, webhooks de statut en
  temps réel (le polling client reste le canal), rollback automatique.

### ADR-030 ADDENDUM — Mode « URL collée » + détection auto (Phase 10bis.5) — 2026-09-03
**Status: IMPLEMENTED + verified (unit 280, e2e 149, tsc api+web, web build 19 routes).**
Décision du propriétaire (demande : « copier-coller le lien de son repo, la détection de
l'app se fait automatiquement avec possibilité de modifier des choses, déploiement simple ;
lier GitHub reste une option mais pas la seule ») — réponses AskUserQuestion : détection
**intelligente**, réglages éditables = **Build pack + Nom de l'app**.
- **Modèle** : `Deployment` + `repoUrl?`, `buildPack?`, `appName?` (migration 14
  `init_deployment_url`). `repoFullName` reste l'identité d'affichage (owner/repo en mode GH,
  segments dérivés de l'URL sinon).
- **Détection (`GithubService.detectRepo`)** : **ne lève JAMAIS** (best-effort). `sanitizeGitUrl`
  (http(s) uniquement, trim, fragment/query retirés, **refus hosts privés/réservés — SSRF léger** :
  localhost, IP littérales, RFC1918/169.254) ; github.com → GET **public SANS token**
  `/repos/{owner}/{repo}` (default_branch + language) + best-effort `/contents/Dockerfile` →
  suggestion `dockerfile` ; sinon `suggestBuildPack(language)` (nixpacks par défaut) ; 404/réseau →
  fallback `main`/nixpacks + `detail`. Quota GitHub unauth (60/h par IP) borné par client
  (JwtAuthGuard) — non anonyme.
- **API** : `POST /api/client/deployments/detect {url}` (JwtAuthGuard, `deployEnabled` requis,
  aucun token GitHub) ; `POST /api/client/deployments` accepte **exactement un** de
  `repoFullName` (mode GH lié, flow inchangé) ou `repoUrl` (mode URL : branch =
  `dto.branch ?? détectée ?? 'main'`, buildPack = `dto.buildPack ?? suggéré ?? 'nixpacks'`,
  appName = `dto.appName ?? service.name` ; skip token/propriété). Les deux → 400.
- **Transport** : `createGitApp` body `name: appName ?? serviceName`, `build_pack: buildPack ??
  'nixpacks'`.
- **Web** : panneau « Déploiements » à 2 onglets — « Dépôt GitHub lié » (si `github.linked`) +
  « URL d'un dépôt » (toujours dispo) : URL → Détecter → prefill branche/langage/build pack →
  champs éditables Nom de l'app + Build pack (nixpacks/dockerfile/dockercompose/static) + select
  Service ACTIVE → Déployer.
- **Causes racines du « rien ne se passe sur l'espace client »** (relevées en live, à corriger
  côté configuration par le propriétaire, PAS un bug du code) : `deployEnabled` OFF (aucune ligne
  `SecuritySetting`) ; aucun `Service` ACTIVE ; jeton API Coolify stocké refusé (403 « You are not
  allowed to access the API » — token périmé/read-only ⇒ mettre un jeton ROOT/write et re-vérifier
  le panneau sur `/manager/serveurs`).

# REJECTED
None recorded in this clean baseline.
