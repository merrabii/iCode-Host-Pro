# PROJECT_STATUS — iCode Host Pro

## Overall status
**PHASE 6 OWNER-VALIDATED 2026-08-31 — CONFIGURATION MAIL ADMIN + EMAILS D'INVITATION (ADR-022). Validation live avec SMTP Brevo réel maîtrisé (domaine codediali.com lié/validé, événements `delivered`). Commit unique fait (47838c1). Push en attente d'instruction.**

## Current phase
**Phase 6 — Configuration SMTP gérée depuis /manager + mail de test + emails d'invitation automatiques. OWNER-VALIDATED (2026-08-31) avec SMTP Brevo réel. En attente du push puis de la proposition Phase 7.**

## State (real, as of this update)
- Monorepo: pnpm workspaces + Turborepo (ADR-001). `apps/web` (Next.js 15), `apps/api` (NestJS 11), `packages/` reserved.
- API: `GET /api/health` (app + real DB connectivity via `SELECT 1`), validated startup config socle (ADR-011), global `/api` prefix, dev CORS, OpenAPI/Swagger at `/api/docs` (ADR-005).
- **Auth (Phase 1, ADR-015)**: stateless JWT Bearer access (short-lived `15m`) + refresh httpOnly cookie (rotated, revocable, sha256-hashed). bcryptjs. RBAC `ADMIN | USER` + guards. **Phase 5 (ADR-020) : `POST /api/auth/register` → 410 Gone (inscription fermée)**; `POST /api/auth/accept-invite` crée le compte USER.
- DB: migrations `init_auth`, `init_core`, `init_audit`, `init_client_access` et **`20260831120703_init_mail`** (**`MailSetting`**). `prisma migrate status` → up to date (**5 migrations**). Prisma client 6.19.3.
- **Invitations (Phase 5B, ADR-020)**: jeton one-shot, TTL 7 j, routes ADMIN, web `/manager/invitations`. **Phase 6 : envoi email automatique best-effort** (`emailSent` dans le retour ; token manuel conservé en fallback si config absente/échec); audit `invite.email` `{email, emailSent, reason?}`.
- **Mail (Phase 6, ADR-022)**: singleton `MailSetting` (enabled, host, port, secure, user, `passwordEnc`, fromEmail, fromName). **Password AES-256-GCM at rest** (`CryptoService`, clé = sha256(`ENCRYPTION_KEY`), payload base64 iv||tag||data) — **jamais renvoyé par l'API**, seulement `hasPassword`. `ENCRYPTION_KEY` optionnelle au boot, requise à l'enregistrement d'un password (400 clair sinon).
- Routes ADMIN `GET/PUT /api/admin/mail` (PATCH-semantics ; `enabled=true` requiert host+fromEmail → 400 ; `''` = effacé sur user/fromName) + `POST /api/admin/mail/test` (utilise la config enregistrée, indépendant de `enabled` ; remonte l'erreur SMTP dans un 400). `MailService` sans état (évite le cycle de providers), `MailTransportFactory` = couture de test overridée en e2e (aucun SMTP réel). Audit `mail.settings.update` (masqué) / `mail.test` (ok/error).
- Web: **`/manager/mail`** (formulaire SMTP : Activer, host, port 465/587/25, secure, user, password « inchangé si vide », fromEmail, fromName ; badge Configuré/Non configuré + warning hasPassword ; section test SMTP). `/manager/invitations` : ✅ email envoyé à X sinon ⚠️ bannière + lien manuel toujours copiable. Nav `/manager` + lien « Configuration mail ».
- **Module wiring**: `MailModule` (AuthModule via `forwardRef` — cycle d'import Mail→Auth→Invitations→Mail), `CryptoModule` (non-global). Invitations → MailSettingsService (best-effort, never throw). `publicBaseUrl` (`PUBLIC_BASE_URL`) pour les liens absolus des emails, défaut localhost:3000.
- Docker Postgres 16 (ADR-012) up and healthy.

## Verified (Phase 6 — real checks, 2026-08-31)
- Unit **90/90** (11 suites : + crypto 5, mail 5, **mail-settings 14**, invitations 14 — mocks MailSettingsService).
- e2e **61/61, 8 suites** (+ **mail** 10 tests avec `overrideProvider(MailTransportFactory)` : 401/403 RBAC, defaults masqués, PUT store → GET hasPassword jamais raw, PUT enabled sans host 400, test OK/400 message SMTP, invite email enlevé→true / désactivé→false, audit masqué). Aucun SMTP réel contacté.
- Builds API + web PASS (route `/manager/mail` incluse). Typecheck web PASS. `prisma migrate status` → in sync.
- Live smoke API :3001: admin login → `GET /api/admin/mail` defaults masqués `{host:null,hasPassword:false}` → `POST /api/admin/mail/test` sans config → 400 « Configuration mail non définie. ».

## Owner live validation (Phase 6 — 2026-08-31)
- **VALIDÉ par le propriétaire** : domaine **codediali.com** acheté et lié/validé dans Brevo ; config SMTP Brevo réelle enregistrée (host `smtp-relay.brevo.com`, port 587, user `9bda29001@smtp-brevo.com`, fromEmail **contact@codediali.com**, fromName « iCode Host Pro », enabled) ; mail de test envoyé et **`delivered` confirmé dans Brevo Logs→SMTP** (vers mourad.moreno@gmail.com + mourad.errabii@gmail.com). Password jamais réaffiché (`hasPassword` only, audit masqué).
- Incidents Brevo maîtrisés pendant la validation (côté compte Brevo, remontés correctement par l'app) : **525 Unauthorized IP** (autoriser l'IP publique dans Brevo — IP ADSL **dynamique**, à réautoriser au changement) ; **sender non validé** → rejet ASYNCHRONE post-250 (l'API montrait `ok:true` ; vu en Brevo Logs→SMTP event `error` « sender not valid ») — fix avec expéditeur validé `contact@codediali.com`.
- **Rebrand (note owner, différé)** : « iCode Host Pro » → **Code Diali** (`codediali.com`) une fois le projet terminé.

## Pending
- Push Phase 6 (on owner request) — le commit unique `47838c1` est prêt à partir.
- (Optionnel) test live d'invitation avec email : créer une invite → l'email arrive avec le lien `/auth?invite=…` → accept de bout en bout.
- Proposition Phase 7.

## Decisions
- ADR-001..005, 011..014: **APPROVED** (Phase 0). ADR-015+016: **APPROVED** (Phase 1). ADR-017: **APPROVED** (Phase 2). ADR-018: **APPROVED** (Phase 3). ADR-019: **APPROVED** (Phase 4). ADR-020+021: **APPROVED** (Phase 5 GO). **ADR-022 (configuration mail + emails d'invitation) : APPROVED** (Phase 6 GO, 2026-08-31) — valide un périmètre étroit d'ADR-008 (chiffrement applicatif au repos). ADR-006 full, 007, 008 complet, 009, 010: **PROPOSED** (untouched). See DECISIONS.md.

## Next action
Push Phase 6 (on owner request) → proposition Phase 7.

## Out of scope (do not build yet)
Déploiement réel chez un provider (ADR-010), jobs/Redis (ADR-007), OAuth / MFA / Turnstile (différés par le propriétaire au profit du « Mail seul »), billing/paiements, `Deployment` (reste différé), asset storage, reverse proxy/SSL, observability, ADR-008 complet (gestion de secrets / config persistée).
