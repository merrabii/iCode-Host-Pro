# PROJECT_STATUS — iCode Host Pro

## Overall status
**PHASE 7 IMPLÉMENTÉE 2026-08-31 — DESIGN SYSTEM DE L'INTERFACE (ADR-023, commit `31af3e2`) + POLISH UI propriétaire (selects, contraste light, toasts). Purement front, aucun changement API/DB. Typecheck + build PASS. À valider visuellement puis commiter comme « Phase 7 polish ».**

## Current phase
**Phase 7 — Polish UI (ADR-023 follow-up), retour propriétaire 2026-08-31 : « couleurs et style à ne pas changer » + 4 finitions front — (1) sélects déroulants optimisés (chevron SVG + alignement boutons), (2) contraste des bordures light, (3) espacement des messages, (4) messages en pop-up (toast + bouton OK, auto-dismiss 5 s). Implémenté, typecheck + build + smoke PASS. Prochaine étape : validation visuelle propriétaire → commit « Phase 7 polish » → push (Phases 6 + 7 + polish en attente d'instruction).**

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
- **Design system (Phase 7, ADR-023)** — réécriture visuelle complète du front (aucun changement API/DB) :
  - **Tokens CSS** (`apps/web/src/app/globals.css`, ~1 100 lignes) : palette dark/light de la référence copiée **à l'identique** (bg `#070c1f` / light `#f8fafc`, sidebar, header, card, borders, text, active…), teintes badges/icônes (green/blue/violet/amber/cyan/pink/gray + rouge ajouté pour les erreurs), tokens marque `--brand-primary #00b377` / `--brand-primary-dark #009966` / gradient / glow, polices, sidebar 280px / topbar 64px, rayons, ombres, breakpoints responsive (<1100 / <900 / <600). Classes composants : topbar, sidebar, nav active, hero, stats, panels, table, badges, boutons, inputs, alertes, empty/spinner, auth-card, utils.
  - **Brand-agnostic** : la marque vit uniquement dans `apps/web/src/config/brand.ts` + tokens `--brand-primary*`. Rebrand différé Code Diali = modifier ces deux endroits seulement.
  - **Thème** : `data-theme` sur `<html>` (dark par défaut), persisté `localStorage 'ihp-theme'`, **script anti-FOUC** inline dans `layout.tsx`, bascule `ThemeToggle` dans la topbar. `layout.tsx` `<html lang="fr">`.
  - **Composants partagés** : `components/icons.tsx` (~20 icônes SVG inline), `components/ui.tsx` (Button/Badge/Alert/Panel/StatCard/Field/Input/Select/PageLoading/EmptyState/PageIntro/Denied/statusTone), `components/app-shell.tsx` (topbar + sidebar + nav + logout + mode `bare`), `components/theme-toggle.tsx`, `lib/session.ts` (`useAdminSession` — bootstrap admin dédupliqué des 6 pages), `config/nav.ts` (ADMIN_NAV 6 entrées + Espace client).
  - **9 pages refactorées** (`/`, `/auth`, `/manager`, `/manager/utilisateurs`, `/manager/journal`, `/manager/invitations`, `/manager/mail`, `/manager/subscriptions`, `/client`) — **logique métier inchangée** (mêmes appels/états/handlers), zéro style inline métier. Documentation : `docs/design/DESIGN_SYSTEM.md`.
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

## Verified (Phase 7 polish UI — real checks, 2026-08-31)
- `npx tsc --noEmit` dans `apps/web` → **PASS (exit 0)**.
- `web build` → **PASS** (10 routes intactes ; dev web arrêté + purge `.next` avant build — leçon Phase 2), puis `next dev` relancé sur :3000.
- Smoke HTTP :3000 → **200** sur les 9 pages (`/`, `/auth`, `/client`, `/manager`, `/manager/invitations`, `/manager/journal`, `/manager/mail`, `/manager/subscriptions`, `/manager/utilisateurs`).
- **Aucun changement API/DB** : pas de migration, suites API inchangées (unit 90/90 + e2e 61/61).

## Verified (Phase 7 — real checks, 2026-08-31)
- `npx tsc --noEmit` dans `apps/web` → **PASS (exit 0)**.
- `corepack pnpm --filter @icode-host-pro/web build` → **PASS** (10 routes, exit 0). Dev web arrêté pendant le build (risque de corruption `.next` — pratique établie Phase 2) ; API :3001 restée up.
- Smoke HTTP :3000 → **200** sur `/`, `/auth`, `/manager`, `/manager/utilisateurs`, `/manager/journal`, `/manager/invitations`, `/manager/mail`, `/manager/subscriptions`, `/client`. HTML servi : `lang="fr"`, script `ihp-theme` (anti-FOUC) présent ; CSS servi contient les tokens du design system (29 Ko, marque `#00b377`, fonds dark/light).
- **Aucun changement API/DB** : pas de migration, aucun test API touché (unit 90/90 + e2e 61/61 inchangés depuis la Phase 6).

## Pending
- **Validation visuelle propriétaire du polish** : chevrons des selects (statuts serveur/produit dans `/manager`, affectation serveur `/manager/subscriptions`, filtre action `/manager/journal`) alignés avec les boutons ; bordures plus nettes en thème clair ; toasts pop-up (OK ferme immédiatement, disparition ~5 s) ; plus aucun message collé au contenu.
- **Commit « Phase 7 polish »** (prêt — la branche contient déjà le design 31af3e2) + **push** des Phases 6 (47838c1), 7 (31af3e2) et du polish sur instruction.
- (Optionnel, Phase 6) test live d'invitation avec email : créer une invite → l'email arrive avec le lien `/auth?invite=…` → accept de bout en bout.

## Decisions
- ADR-001..005, 011..014: **APPROVED** (Phase 0). ADR-015+016: **APPROVED** (Phase 1). ADR-017: **APPROVED** (Phase 2). ADR-018: **APPROVED** (Phase 3). ADR-019: **APPROVED** (Phase 4). ADR-020+021: **APPROVED** (Phase 5 GO). **ADR-022 (configuration mail + emails d'invitation) : APPROVED** (Phase 6 GO, 2026-08-31) — valide un périmètre étroit d'ADR-008 (chiffrement applicatif au repos). **ADR-023 (design system de l'interface) : APPROVED** (Phase 7 GO, 2026-08-31 — « copier le style et couleurs complet, brand-agnostic, tout modifiable ») + **polish UI (selects, contraste light, toasts)** du même ADR. ADR-006 full, 007, 008 complet, 009, 010: **PROPOSED** (untouched). See DECISIONS.md.

## Next action
Validation visuelle propriétaire du polish → commit « Phase 7 polish » → push Phases 6 + 7 + polish → proposition Phase 8.

## Out of scope (do not build yet)
Déploiement réel chez un provider (ADR-010), jobs/Redis (ADR-007), OAuth / MFA / Turnstile (différés par le propriétaire au profit du « Mail seul »), billing/paiements, `Deployment` (reste différé), asset storage, reverse proxy/SSL, observability, ADR-008 complet (gestion de secrets / config persistée).
