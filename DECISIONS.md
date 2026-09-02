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

# REJECTED
None recorded in this clean baseline.
