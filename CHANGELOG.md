# CHANGELOG

## Phase 8 bis — REWORK UX PAGE SERVEURS : GRILLE DE CARTES + PANNEAU LATÉRAL (ADR-023 appliqué) — 2026-09-01
Owner feedback: « dans la page serveur le tableau et la page ne sont pas bien UX optimisé ! Prière d'utiliser un style très moderne pour l'affichage des tableaux ou donnée modifiable. » Direction choisie via AskUserQuestion : **grille de cartes + panneau latéral (drawer)** (style dashboards infra modernes — Coolify/Hetzner/Cloudflare). **Aucun changement API/DB** — pur front (`apps/web`), design system ADR-023 respecté (tokens, couleurs, brand inchangés), logique métier et sonde Phase 8 **conservées** à l'identique.
### Added
- **Grille de cartes** (`globals.css` section 22 + `page.tsx`) en remplacement de la table 11 colonnes : toolbar (recherche libre nom/hostname/IP/fournisseur/région + **chips filtres par statut** avec compteurs + compteur affichés/total, tri mémoire sans appel API), cartes responsives (`repeat(auto-fill, minmax(330px,1fr))`) — en-tête (icône teintée par statut + nom + badge statut + hostname mono), champs en grille 2 colonnes (IP/Port mono, Fournisseur, Région, Quota, TLS badge Strict/Off, Panneau badge Hestia/Coolify), **bloc Connexion Phase 8 intégré** (badge OK/Échec/— avec point + détail + « Dernier test » + bouton **Tester** + bascule rapide `→ ACTIVE`/`→ PROBLEM`), pied d'actions **Modifier**/**Supprimer** (icônes Pencil/Trash, révélées au survol via `:hover`/`:focus-within`).
- **Panneau latéral (drawer)** création/édition : glisse depuis la droite (animation 0.22 s), overlay blur, mêmes champs que l'ancien formulaire (nom*+, hostname*+, IP, port, fournisseur, région, quota, panneau, strictTls ; sélect statut **uniquement en édition**), pied Annuler/« Créer le serveur »/« Enregistrer ». **Échap** ferme, clic backdrop ferme, désactivé pendant une requête.
- **Icônes** `icons.tsx` : `IconSearch` (recherche), `IconPencil`, `IconTrash` (actions de liste). État vide liste / recherche sans résultat distincts.
### Changed
- `page.tsx` : l'édition inline toutes-cellules remplacée par le drawer — handlers/validations/toasts **inchangés** (`load`, `createServer`, `updateServer`, `deleteServer`, `checkServer`, `applyStatusQuick`, `toPatch`, `emptyDraft`).
- Le pattern (toolbar + `srv-grid` + `drawer-*`) est générique et réutilisable pour d'autres listes (Produits…) — hors périmètre de ce commit.
### Verified (2026-09-01)
- Aucun changement API/DB → unit **98/98** + e2e **67/67** toujours valides (non rejoués — aucun endpoint/garde touché).
- `npx tsc --noEmit` apps/web **PASS** (exit 0) ; `web build` **PASS** (14 routes, `/manager/serveurs` 6.39 kB — `.next` purgé, dev web arrêté avant build, leçon Phase 2). Marqueurs de la nouvelle structure présents dans le chunk client compilé (`srv-grid`, `srv-card`, `drawer-overlay`, `srv-chip`, `IconSearch/Pencil/Trash`) + CSS servi.
- Smoke :3000 → `/manager/serveurs` **200** ; dev web relancé en fond (PID 876).
### Pending
- Validation live propriétaire (grille + drawer) → commit + push de la Phase 8 (avec ce rework).

## Phase 8 — CONNEXION RÉELLE DES SERVEURS : SONDE DE CONNECTIVITÉ (ADR-025) — IMPLEMENTED 2026-09-01
Owner's AskUserQuestion choice for Phase 8: « Connexion réelle des serveurs » — « Implémenter le premier connecteur (ADR-010) : ping/détection de l'état réel d'un serveur (Hestia/Coolify), vérification de l'API, statut PROVISIONING/ACTIVE/PROBLEM piloté par la connexion, test de connectivité depuis /manager/serveurs. ». Scoped to a narrow ADR-010 slice: a **connectivity probe (TCP + HTTP)** the admin triggers from `/manager/serveurs`, which detects the real network state and **proposes** a status switch. Real provider adapters / credentials / auto-provisioning stay OUT of scope.
### Added
- **Modèle `Server`** (migration `20260901082020_init_server_check`, +1 → **7 migrations**) : 3 champs de résultat, **nullable**, écrits uniquement par la sonde (jamais par l'admin) : `lastCheckedAt DateTime?`, `lastProbeOk Boolean?` (null = jamais sondé), `lastProbeDetail String?`.
- **`ProbeTransportFactory`** (`apps/api/src/servers/probe-transport.factory.ts`) — la **couture de test** sur le modèle exact de `MailTransportFactory` (Phase 6) : `ServersService` dépend de la factory, l'e2e l'override (`overrideProvider`) → **aucun réseau réel en test** ; l'unit test le vrai transport sur loopback. Runtime = `NodeProbeTransport` : **TCP** (`net.connect`) pour les ports type SSH (défaut 22) + **HTTP/HTTPS** (`rejectUnauthorized = strictTls`) pour 80/443/8443 ; toute réponse HTTP = joignable (même 5xx) ; timeout défaut 5 000 ms ; détail lisible (« TCP 22 : accessible (18 ms) », « HTTP 200 en 45 ms », « Connexion refusée », « Délai dépassé (5 000 ms) », « Erreur TLS : … », « Hôte introuvable »).
  - **Leçon DI Nest** : pas de paramètre primitif injecté au constructeur de la factory (un `Number` = token DI introuvable → AppModule échouait à l'init, suite e2e entière sauf `server-check` pois activités). Le timeout vit dans `create(timeoutMs)`, surchargeable test par test.
- **Endpoint** `POST /api/servers/:id/check` (ADMIN) : charge le serveur, cible `hostname` + `port` (défaut 22), sonde, **persiste** les 3 champs, journalise **`server.check`** (`{host, port, ok, detail, latencyMs, httpStatus, statusLeft}`). Réponse `{ server, probe }`. **Le statut n'est JAMAIS forcé** — la sonde propose, l'admin valide.
- **UI** `/manager/serveurs` : nouvelle colonne **Connexion** — badge persistant (OK / Échec / — = jamais testé), détail `lastProbeDetail`, bouton **« Tester »** (spin pendant la sonde), raccourci `→ ACTIVE` (résultat OK) / `→ PROBLEM` (échec) = bascule rapide validée par l'admin (PATCH + audit `server.update`).
- Journal (`/manager/journal`) : libellé `server.check` → « Test de connexion serveur ».
### Verified (2026-09-01)
- Unit **98/98** (12 suites, +7) ; **e2e 67/67, 9 suites** (+ `server-check` : 401/403/404, succès persisté + relecture GET, échec + audit) — override de la couture, **zéro réseau en test**, verts sur Postgres réel.
- `npx tsc --noEmit` apps/web **PASS** ; `web build` **PASS** (14 routes, `/manager/serveurs` 5.8 kB ; `.next` purgé avant build). Dev servers API :3001 + web :3000 relancés en fond.
- Smoke live API :3001 — sonde réelle `localhost:5432` → `{ok: true, detail: "TCP 5432 : accessible (8 ms)", latencyMs: 8}`, persisté + relu ; `127.0.0.1:5999` → `{ok: false, detail: "Connexion refusée"}`, persisté ; audit `server.check` rempli. Smoke web :3000 → **200** `/`, `/manager/serveurs`, `/manager/journal`.
### Pending
- Validation live propriétaire → commit + push.
- Plus tard (hors périmètre ici) : politique automatique des statuts par sonde périodique (ADR-007), adaptateurs fournisseurs réels + credentials (ADR-010 complet), cPanel/DirectAdmin.

## Phase 7ter — GESTION ADMIN SERVEURS & PRODUITS + DÉTAILS INFRASTRUCTURE (ADR-024) — IMPLEMENTED 2026-09-01
Owner asked to fix the `/manager` dashboard overflow (server action buttons behind the products panel) as a real design expert: « ne garde pas les pages centrées et augmente la largeur des pages… créer un menu dans la sidebar pour les serveurs… page sera modifiée au fur et à mesure quand la connexion des serveurs sera établie et avoir beaucoup plus de détails… ». Direction chosen via AskUserQuestion: dedicated **Produits** page too + new Server fields (IP, Port, Fournisseur, Région, Quota Max Comptes, ✓ TLS strict, Module de Panneau HESTIA/COOLIFY d'abord — cPanel/DirectAdmin ensuite).
### Added
- **Modèle `Server` étendu** (migration `20260901021234_init_server_details`, +1 → **6 migrations**) : `ipAddress String?`, `port Int?` (1–65535), `provider String?`, `region String?`, `quotaMaxAccounts Int?`, `strictTls Boolean @default(true)`, **`panelProvider` enum `ServerPanelProvider {NONE HESTIA COOLIFY}`** (commenté pour cPanel/DirectAdmin futurs). Tous optionnels — créer un hôte reste obligatoire seulement sur name/hostname ; statut initial UNKNOWN.
- **API serveurs** : `CreateServerDto` (7 champs optionnels validés — IsInt/IsBoolean/IsEnum/1-65535/quota≥0) + `ServersService.create` whitelist explicite.
- **Sidebar admin** : items **Serveurs** + **Produits** (`config/nav.ts`, ordre : Tableau de bord, Serveurs, Produits, Utilisateurs, Souscriptions, Invitations, Mail, Journal).
- **Pages CRUD larges** : `/manager/serveurs` (table — Serveur, IP, Port, Fournisseur, Région, Quota, TLS badge Strict/Off, Panneau badge HESTIA violet/COOLIFY cyan, Statut, Actions ; **édition inline** Modifier/Enregistrer/Annuler ; création formulaire grid ; note « statuts pilotés par la connexion réelle (à venir) ») + `/manager/produits` (Produit, Type badge, Statut select, Supprimer).
- **Dashboard `/manager` en LECTURE SEULE** : stats + 2 panneaux synthèse (6 premiers serveurs/produits, badges de statut) + panneau « Lien rapide » (CDN vers Utilisateurs/Souscriptions/Invitations/Journal) ; **plus aucun formulaire/édition depuis le dashboard**, CTA hero « Gérer les serveurs » / « Gérer le catalogue ».
- **Layout élargi** : `wrap-md` 900 → **1320px**, `.table-wide` (min-width 760px + scroll-x), `.grid-form` (auto-fit 210px), `.row-editing` surlignage édition inline, `.panel-span`/`.quick-links` — le débordement « serveurs derrière produits » est structurellement éliminé.
- Helpers `lib/api.ts` : types `ServerAdmin`/`ServerPatch`/`ProductAdmin`/`PanelProvider` + `list/create/update/deleteServer` + `list/create/update/deleteProduct`.
### Changed
- DECISIONS.md : **ADR-024 APPROVED** (2026-09-01). La fiche serveur est volontairement « évolutive » : elle sera enrichie automatiquement (statut, charge, observations panel) quand la connexion réelle sera établie (ADR-010/007 futures, restent PROPOSED) ; le provisionnement reste un stub (ADR-021).
- `.tools/` + `.claude/settings.json` (allowlist ports/docker) : non inclus dans le diff fonctionnel.
### Verified (2026-09-01)
- Unit **91/91** (11 suites, +1 test full-details serveur) ; **e2e 62/62, 8 suites** (+1 test ADR-024 : ADMIN POST serveur avec ip/port/provider/region/quota/strictTls/panelProvider puis PATCH panelProvider/port — verts sur Postgres réel).
- `npx tsc --noEmit` apps/web **PASS** ; `web build` **PASS** (14 routes dont `/manager/serveurs` 5.28 kB, `/manager/produits` 3.80 kB, `/manager` 3.66 kB ; `.next` purgé avant build — leçon Phase 2).
- `prisma migrate status` → **6 migrations, in sync**. Smoke live :3000 → **200** sur `/manager`, `/manager/serveurs`, `/manager/produits` + proxy `/api` 401 sans session ; login ADMIN → `/users/me` 200, `/api/servers` (4), `/api/products` (2), `/api/manager/summary` ({2 produits ACTIVE, 4 serveurs, 16/17 users}) — cohérents avec l'API, zéro erreur côté web/API.
- **Redémarrage environnement (2026-09-01)** : Docker Desktop était éteint → postgres au sol + dev servers arrêtés (le web répondait « pas accessible »). Remonté : docker up (postgres healthy), API :3001, web :3000 — c'était un état d'environnement, pas une régression de code.
### Owner validation (2026-09-01)
- **VALIDÉ par le propriétaire** (« validé ») : pages `/manager/serveurs` (création + édition inline avec les nouveaux champs) et `/manager/produits`, dashboard lecture seule, layout large 1320px. Phase 7ter **closed** — commit `1d7131e` poussé sur `origin/main` (avec `31af3e2` design + `76fb0db` polish).
Owner feedback on Phase 7 design: « tout est correct concernant les couleurs et style, c'est très bien à ne pas changer » — the reference palette stays as-is (dark + light) — with 4 pure-front requests:
### Added
- **Sélects déroulants optimisés** (`globals.css` `.select` / `.select-sm`) : flèche OS native supprimée (`appearance:none`) + **chevron SVG du design system** (data-URI, couleur `--text-secondary` par thème), `padding-right: 36px` (texte jamais sous la flèche), `cursor:pointer`. Hauteurs = `.input`/`.btn` → **alignement vertical aligné** avec les boutons adjacents dans les tableaux ; `.select-sm` calqué sur `.btn-sm` (statuts serveur/produit, affectation serveur, filtres journal) ; `<option>` teintés thème.
- **Contraste des bordures en thème clair** : uniquement `--border` `#e7eaf0 → #d5dce8` et `--border-soft` `#eef0f4 → #e1e6ef` (nuance gris-bleu identique, plus lisible sur blanc). **Dark et toutes les autres teintes inchangés**.
- **Espacement des messages inline** : `.alert` `margin-bottom: 12px` (plus jamais collé au contenu suivant) ; reset à 0 dans `.stack`/`.panel-body` (espacement par gap).
- **Toasts pop-up** (`apps/web/src/components/toast.tsx`, neuf) : `ToastProvider`/`useToast()` monté dans `layout.tsx` → disponible sur toutes les pages. Feedback d'action en pop-up **haut-droit** — message + icône de ton + **bouton OK** (ferme immédiatement), **auto-dismiss 5 s** (timers nettoyés au démontage), `role="status"`/`alert` + `aria-live` (polite/assertive), animation slide+fade ~0.18 s, responsive (pleine largeur < 600px). CSS `.toast-host`/`.toast`/`.toast-btn` dans `globals.css` (tokens `--card-bg`/`--border`/`--tint-*`/`--shadow`/`--radius-card`).
### Changed
- **8 pages converties** des états `message`/`error`/`testResult` (Alert inline) vers `useToast()` — logic/handlers **inchangés** : `/manager`, `/manager/utilisateurs`, `/manager/journal`, `/manager/invitations`, `/manager/mail` (résultat du mail de test aussi en toast), `/manager/subscriptions`, `/client`, `/auth`. Helpers `flash()` supprimés → `toast.ok()`.
- **Conservés inline volontairement** (contextes persistants, pas feedbacks d'action) : alerte diagnostic de `/` (santé API) et le panneau « invitation créée » de `/manager/invitations` (jeton + lien à copier).
- `docs/design/DESIGN_SYSTEM.md` : tokens light ajustés + chevron selects + composant Toast documentés.
- **Aucun changement API/DB** : pas de migration, suites API inchangées.
### Verified (2026-08-31)
- `npx tsc --noEmit` apps/web **PASS** (exit 0) ; `web build` **PASS** (10 routes intactes, après purge `.next` — leçon Phase 2) ; smoke :3000 **200** sur les 9 pages.
### Pending
- Validation visuelle propriétaire (toasts, chevrons, bordures light) ; commit + push (sur instruction).

## Phase 7 — DESIGN SYSTEM DE L'INTERFACE (ADR-023) — IMPLEMENTED 2026-08-31, committed `31af3e2`
Owner GO: « Ne copier que le style et couleurs complet (sidebar + topbar + cartes…) de la page html envoyée et oublier tout le reste. Le système ne doit absolument pas être lié à une brand et tout doit être modifiable. » — copied the reference dashboard's dark/light style EXACTLY, ignored all third-party content, everything stays brand-agnostic + editable via CSS vars.
### Added
- **Design tokens** (`apps/web/src/app/globals.css`, réécrit ~30 → ~1 100 lignes) : palette dark/light complète de la référence (bg/sidebar/header/card/border/text/active…), teintes badges/icônes (green/blue/violet/amber/cyan/pink/gray + **rouge** ajouté pour les erreurs), tokens marque `--brand-primary #00b377`/`--brand-primary-dark`/`--brand-accent`/gradient/glow, fonts, sidebar 280px / topbar 64px, rayons, ombres, breakpoints (<1100/<900/<600). Source : `docs/design/DESIGN_SYSTEM.md`.
- **Thème** : `data-theme` sur `<html>` (dark par défaut), persistance `localStorage 'ihp-theme'`, **script anti-FOUC** inline dans `layout.tsx` (avant peinture), `<html lang="fr">`, bascule `ThemeToggle` dans la topbar.
- **Composants partagés** (`apps/web/src/components/`) : `icons.tsx` (~20 icônes SVG inline, style référence, zéro dépendance), `ui.tsx` (Button/Badge/Alert/Panel/StatCard/Field/Input/Select/PageLoading/EmptyState/PageIntro/Denied/statusTone), `app-shell.tsx` (topbar + sidebar + nav active + logout + mode `bare`), `theme-toggle.tsx` ; `apps/web/src/config/brand.ts` (marque uniquement ici), `config/nav.ts` (ADMIN_NAV 6 entrées + Espace client), `lib/session.ts` (`useAdminSession` dédupliqué).
- **9 pages refactorées** (`/`, `/auth`, `/manager`, `/manager/utilisateurs`, `/manager/journal`, `/manager/invitations`, `/manager/mail`, `/manager/subscriptions`, `/client`) — **logique métier inchangée** (mêmes appels/états/handlers), aucun style inline métier.
### Changed
- DECISIONS.md : **ADR-023 APPROVED** (Phase 7 GO, 2026-08-31). `layout.tsx` (lang=fr + anti-FOUC), `globals.css` (tokens+classes), toutes les pages sous `src/app/`, nouveau `src/config/`, `src/components/`, `src/lib/session.ts`. `docs/design/DESIGN_SYSTEM.md` créé (spécification complète + règles d'écriture AI + section marque).
- **Aucun changement API/DB** : pas de migration, aucun test API modifié.
### Verified (2026-08-31)
- `npx tsc --noEmit` apps/web **PASS** (exit 0) ; `web build` **PASS** (10 routes) ; smoke HTTP :3000 **200** sur les 9 pages (HTML `lang="fr"` + script `ihp-theme`, CSS 29 Ko avec tokens `#00b377` dark/light).
### Pending
- Validation propriétaire du design (dark + light) ; commit + push Phases 6 + 7 (sur instruction).

## Phase 6 — COMPLETE and owner-validated (2026-08-31)
Owner picked scope « **Mail seul** » (AskUserQuestion) — SMTP config admin + test email + emails d'invitation automatiques — and password storage « **Chiffré au repos** » (AES-256-GCM). OAuth/MFA/Turnstile deferred.
### Added
- **Mail settings singleton (ADR-022)** — table `MailSetting` (migration `20260831120703_init_mail`) : `enabled` (gating de l'envoi AUTO sur invitations), `host`, `port` (587 STARTTLS défaut / 465 = `secure`), `secure` (TLS implicite), `user?`, `passwordEnc?`, `fromEmail`, `fromName?`.
- **Chiffrement au repos** — `CryptoService` (`apps/api/src/crypto/`, non-global) : AES-256-GCM, clé = sha256(`ENCRYPTION_KEY`), payload base64 `iv||tag||data` ; `ENCRYPTION_KEY` optionnelle au boot, **requise** à l'enregistrement d'un mdp (400 « Clé de chiffrement manquante ») ; **password jamais renvoyé par l'API** — le DTO masqué expose uniquement `hasPassword`. Valide un périmètre étroit d'ADR-008 ; ADR-008 complet reste PROPOSED.
- **Module mail (`apps/api/src/mail/`)** — `MailTransportFactory` (couture de test, overridée en e2e → aucun SMTP réel), `MailService` **sans état** (config passée en paramètre — évite le cycle de providers), `MailSettingsService` (get masqué, `update` PATCH-semantics : `enabled=true` requiert host+fromEmail → 400 ; password `''`/absent = inchangé, valeur = chiffrée ; user/fromName `''` = effacés ; `getMailConfig` déchiffre ; `test` → ok ou 400 avec message SMTP ; `sendInvitationMail` ; `isEnabled`). Routes ADMIN `GET|PUT /api/admin/mail` + `POST /api/admin/mail/test`. Audit `mail.settings.update` (masqué) / `mail.test` (ok/error).
- **Emails d'invitation best-effort** — `InvitationsService.create` après audit : si `enabled` → `sendInvitationMail` try/catch **never throw** ; retour enrichi `emailSent` ; **token one-shot conservé en fallback** (lien manuel toujours affiché dans `/manager/invitations`) ; audit `invite.email` `{email, emailSent, reason?}`. Lien `PUBLIC_BASE_URL + /auth?invite=<token>&email=<email>`.
- **Web `/manager/mail`** — formulaire SMTP (Activer, host, port 465/587/25, secure, user, password « inchangé si vide », fromEmail, fromName), badge **Configuré/Non configuré** + warning `hasPassword`, section **mail de test** avec l'erreur SMTP remontée. `/manager/invitations` : ✅ « Email envoyé à X » sinon ⚠️ bannière config absente/échec + lien manuel copiable. Nav `/manager`.
- Tests: `crypto.service.spec` (5), `mail.service.spec` (5), `mail-settings.service.spec` (14) ; `invitations.service.spec` étendu (+3, mock MailSettingsService) ; e2e `mail.e2e-spec` (10 : RBAC 401/403, defaults masqués, PUT store → `hasPassword` jamais raw, enabled sans host 400, test OK/400 message SMTP, invite email selon `enabled`, audit masqué).
### Changed
- DECISIONS.md : **ADR-022 APPROVED** (Phase 6 GO) + note périmètre étroit d'ADR-008. `configuration.ts` : `encryptionKey` + `publicBaseUrl` optionnels (set fail-early intact). `.env.example` + `.env` local (gitignored) : ENCRYPTION_KEY, PUBLIC_BASE_URL. `MailModule` importe `AuthModule` via `forwardRef` (cycle d'import Mail→Auth→Invitations→Mail). `package.json` : +nodemailer 9.1.0 (+@types).
### Verified (2026-08-31)
- Unit **90/90** (11 suites, +27); e2e **61/61, 8 suites** (+mail) — verts sur Postgres réel, aucun SMTP réel contacté (override MailTransportFactory).
- Builds API + web PASS (route `/manager/mail` incluse); typecheck web PASS; `prisma migrate status` up-to-date (5 migrations).
- Live smoke :3001: admin login → `GET /api/admin/mail` defaults masqués → `POST /api/admin/mail/test` sans config → 400 « Configuration mail non définie. ».
### Owner live validation (2026-08-31)
- **VALIDÉ par le propriétaire** avec SMTP **Brevo réel** : domaine **codediali.com** acheté et lié/validé dans Brevo, config SMTP `smtp-relay.brevo.com:587` + expéditeur `contact@codediali.com` depuis les résultats de test → **`delivered` confirmés dans Brevo Logs→SMTP** (mourad.moreno@gmail.com + mourad.errabii@gmail.com). Password jamais réaffiché (`hasPassword` only). « c'est validé pour la configuration de mail ».
- Incidents résolus pendant la validation (côté compte Brevo, le pipeline iCode a remonté chaque erreur correctement) : **525 Unauthorized IP** (autoriser l'IP publique — noter IP ADSL dynamique) et **sender non validé** → rejet ASYNCHRONE après 250 (l'API montrait `ok:true` ; visible dans Brevo Logs→SMTP event `error` « sender not valid »). Fix : expéditeur validé `contact@codediali.com`. Leçon : le test endpoint remonte les erreurs SMTP synchrones ; un rejet async se vérifie côté Brevo Logs.
- **Rebrand (note owner, différé)** : « iCode Host Pro » → **Code Diali** (`codediali.com`) une fois le projet terminé.
- **Pending**: push Phase 6 (on owner request) ; test live optionnel d'invitation avec email (envoyer une invite → réception + accept de bout en bout) ; proposition Phase 7.

## Phase 5 — COMPLETE and owner-validated (2026-08-31)
Owner picked direction « A puis B » (fermer l'inscription d'abord, puis l'espace client) and confirmed: « c'est l'admin qui doit ajouter et modifier et gérer les serveurs complètement mais le client ne manipule pas l'infra ».
### Added
- **Invitations (ADR-020)** — inscription libre fermée : `POST /api/auth/register` → **410 Gone**; `POST /api/auth/accept-invite` (token + email + password + name) crée le compte USER et émet les jetons. Table `Invitation` (migration `20260831084839_init_client_access`) : `tokenHash` sha256 unique (brut jamais persisté), `issuerId` FK User SetNull, `expiresAt`, `usedAt`/`revokedAt`. Routes ADMIN `GET/POST /api/invitations` + `POST /api/invitations/:id/revoke` (idempotent); jeton `randomBytes(32)` retourné une seule fois; TTL `INVITE_EXPIRES_IN_DAYS` (défaut 7). Web `/manager/invitations` : créer par email, lien d'invitation copiable (affiché une seule fois), liste statuts, révocation.
- **Espace client (ADR-021)** — tables `Subscription` + `Service` (client-owned, migration `init_client_access`). Routes client (tout authentifié): catalogue = `GET /api/products` existant; `GET/POST /api/client/subscriptions`, `PATCH /api/client/subscriptions/:id/cancel`, `GET/POST /api/client/services`. Routes admin: `GET /api/admin/subscriptions`, `PATCH /api/admin/subscriptions/:id` (whitelist approve/reject/suspend/activate), `GET /api/admin/services`, `PATCH /api/admin/services/:id` (affecter un serveur existant + REQUESTED→PROVISIONING→ACTIVE, **stub** — pas de déploiement réel). **Ownership par possession** (id d'un autre client → 404), aucune donnée serveur exposée au client (scalaire `serverId` exclu du listing client). Web `/client` (s'abonner, annuler, demander un service, statuts, zéro infra) + `/manager/subscriptions` (approbations + affectation serveur).
- **Audit (Phase 5)**: événements `invite.create/revoke/accept`, `subscription.create/cancel/approve/reject/suspend/activate`, `service.request/assign/remove/provision/activate`; journal web enrichi (labels + mots de ressource invitation/souscription/service).
- Tests: `invitations.service.spec` (11 unit), `subscriptions.service.spec` (16 unit); e2e `invitations.e2e-spec` + `client.e2e-spec` (boucle complète + isolation inter-clients + RBAC). **E2E existants reworkés** : create user direct via Prisma (register fermé) ; `auth.e2e-spec` réécrit sur le flux invite→accept→login + one-shot + email non-correspondant ; `audit.e2e-spec` attend `auth.login` (plus `auth.register`). `testTimeout` e2e 30s (loader 7 suites en parallèle).
### Changed
- DECISIONS.md: ADR-020 + ADR-021 APPROVED. Configuration: `inviteExpiresInDays` optionnel (`.env.example`). `AuthModule` ↔ `InvitationsModule` en `forwardRef` (accept-invite ↔ guards). `apps/web/src/lib/api.ts` : types + helpers Phase 5. `/auth` : onglet register **remplacé** par le formulaire d'acceptation (prérempli par `?invite=…&email=…`). Nav racine + `/manager`.
### Verified (2026-08-31)
- Unit **62/62** (8 suites, +34); e2e **51/51, 7 suites** (+2) — verts sur Postgres réel.
- Builds API + web PASS; typecheck web PASS; `prisma migrate status` up-to-date (4 migrations).
- Live smoke: `/api/health` ok; register → **410**; login admin → token; `GET /api/products` 200 ; `GET /api/invitations` (ADMIN) 200.

### Owner validation (2026-08-31)
- Owner confirmed live: « validé » — parcours complet (invitation → accept → login → `/client` (s'abonner) → approbation `/manager/subscriptions` → demande de service → affectation serveur → ACTIVE) ; register → 410 ; client sans aucune donnée serveur. Phase 5 closed.

### Pending (not yet done)
- Push of Phase 5 (on owner request).
- Proposition Phase 6.

## Phase 4 — COMPLETE and owner-validated (2026-08-31)
Owner gave GO for direction « Audit journal »; scope includes auth events (register/login/refresh/logout) alongside admin mutations (as proposed).
### Added
- **Audit journal (ADR-019)**: new table `AuditLog` (migration `20260831024151_init_audit`) — `actorId` nullable FK User (onDelete SetNull), `actorEmail` (denormalized), `action`, `resourceType`/`resourceId` (polymorphic strings), `details` Json, `createdAt`; indexes on createdAt/resourceType/action.
- **`GET /api/audit`** (ADMIN only): pagination (offset/limit) + filters `actorId`, `action`, `resourceType`, `from`, `to`. **Append-only** — no update/delete endpoints.
- **Emission côté service** (best-effort, ne casse jamais l'opération métier): `AuditService` (`@Global`) injecté dans users (promote/demote/activate/deactivate), products & servers (create/update/delete), auth (register/login/refresh/logout).
- **Web `/manager/journal`**: table admin paginée + filtres (type de ressource, action) + pavés précédent/suivant; lien depuis `/manager`. Helpers `lib/api` (`AuditEntry`, `AuditPage`, `listAudit`).
- Tests: `audit.service.spec` (5 unit), `audit.e2e-spec` (RBAC 403/USER, lecture+filtres+pagination ADMIN, une action promote produit une entrée visible).
### Changed
- DECISIONS.md: ADR-019 APPROVED (Phase 4 GO). Schema Prisma: model `AuditLog` + relation `User.auditLogs`.
- `AuditModule` est `@Global` et ré-enregistre localement JwtModule + RolesGuard pour éviter une dépendance circulaire avec AuthModule (AuthService injecte l'AuditService global).
- `UsersService.update` reçoit désormais l'acteur `{ sub, email }` (au lieu d'un simple `sub`) pour journaliser qui agit.
- PROJECT_STATUS.md, TASKS.md, docs/sql-commandes.txt updated.

### Fixed (2026-08-31, retour du propriétaire)
- **Colonne « Ressource » du journal** : affichait le payload brut (`JSON.stringify` de `details`) + id tronqué. Rendu remplacé par un **libellé lisible** — le nom de l'entité impactée (`.name` / `.to.name` / `.email`), le `hostname` pour les serveurs, fallback sur l'id court sinon. Le JSON complet est conservé en infobulle `title` (forensique intacte). `typecheck apps/web` PASS.

### Verified (2026-08-31)
- Unit **28/28** (6 suites, +5 audit); e2e **29/29, 5 suites** (+audit RBAC); builds API + web PASS (routes incl. `/manager/journal`).
- Live: `/api/audit` 401 unauth; admin login → 200 (16 entrées : auth.register/login, user.promote/demote, server.create/delete…). Web `/manager/journal` 200.
- Re-run de clôture (2026-08-31, avant commit) : unit **28/28**, e2e **29/29** — confirmés verts.

### Owner validation (2026-08-31)
- Owner confirmed live: journal `/manager/journal` (filtres, pagination) et la colonne « Ressource » lisible (nom + hostname serveur). « validé ». Phase 4 closed.

### Pending (not yet done)
- Push of Phase 4 (on owner request).
- Proposal for Phase 5.

## Phase 3 — COMPLETE and owner-validated (2026-08-31)
Owner gave GO for direction « Dashboard /manager + gestion admins »; explicitly kept closing registration / an invitation flow OUT of this phase.
### Added
- **Account management (ADR-018)**: `GET /api/users` (list, ADMIN only) + `PATCH /api/users/:id` (promote/demote `ADMIN↔USER`, activate/deactivate, ADMIN only). **Anti-lockout guards**: cannot change your own role, cannot demote/deactivate the last active ADMIN.
- **Dashboard (ADR-018)**: `GET /api/manager/summary` (product/server/user counts by status/role), ADMIN only.
- **`/manager` console**: dashboard summary cards; servers now with **status transition + editable hostname** inline; products with **status transition** (DRAFT/ACTIVE/SUSPENDED/DISABLED); new **`/manager/utilisateurs`** page (promote/demote, activate/deactivate, surfaces 403 guard messages). Web `lib/api` helpers (`apiJson`, `listUsers`, `updateUser`, `getManagerSummary`).
- Tests: `users.service.spec` (8 unit), `manager.service.spec` (2 unit), `admin.e2e-spec` (RBAC e2e).
### Changed
- DECISIONS.md: ADR-018 APPROVED. (Data model UNCHANGED — no migration.)
- TASKS.md: Phase 3 journal; OPEN ITEMS notes registration invitation flow deferred.
### Verified (2026-08-31)
- Unit **23/23**; e2e **24/24, 4 suites**; builds API + web PASS (routes `/`, `/auth`, `/manager`, `/manager/utilisateurs`).
- Live: `/api/users` & `/api/manager/summary` 401 unauth; admin list 9 users (no `passwordHash`); summary aggregates 1 product/1 server/9 users; **self-demote guard → 403** with clear message; web `/manager` + `/manager/utilisateurs` 200.

### Fixed (2026-08-31, bug reporté par le propriétaire)
- Anti-lockout over-guard : rétrograder/désactiver un admin DÉJÀ inactif était refusé à tort (le pool d'admins actifs n'était jamais réduit). Le garde-fou ne s'applique désormais que quand la modification retire un ADMIN **actif**. Regression tests unit (2) + e2e (1). Root cause : le compte promu était `role=ADMIN, isActive=false`.

### Owner validation (2026-08-31)
- Owner confirmed live: promotion/rétrogradation/activation/désactivation des comptes, dashboard `/manager`, catalogue enrichi et transitions de statut. Phase 3 closed.

### Pending (not yet done)
- Push of Phase 3 (on owner request).
- Proposal for Phase 4.

## Phase 2 — COMPLETE and owner-validated (2026-08-31)
Owner picked direction "Modèle cœur + dashboard" with the core architecture resolved: Product & Server are PLATFORM-GLOBAL reference data (NO ownerId), administration console `/manager` (ADMIN only), client-owned resources deferred.
### Added
- **Core model (ADR-017)** — tables `Product` (catalogue: name unique, kind string, status enum `ProductStatus`) and `Server` (infrastructure: name unique, hostname, status enum `ServerStatus`), migration `20260831000649_init_core`. Global, no ownerId.
- **RBAC**: Product read = any authenticated; Product mutation & all Server routes = ADMIN only (internal infra never exposed to clients). 401/403 via existing JwtAuthGuard + RolesGuard.
- **`/manager`** admin console (list + create + delete servers & products), ADMIN-gated, token minted from the httpOnly refresh cookie (no localStorage token).
- **Admin bootstrap**: idempotent `db:seed` (prisma/seed.ts) from gitignored `.env` credentials; placeholders only in `.env.example`.
- API `/api/products` + `/api/servers` (CRUD) with Swagger tags; DTO validation.

### Changed
- DECISIONS.md: ADR-017 APPROVED (Phase 2 GO). (ADR-015/016 already approved; ADR-006/007/008/009/010 remain PROPOSED.)
- Web: homepage links + `/manager` route; `.next` dev cache reset (HMR corruption) and manager page relocated under `src/app/`.
- PROJECT_STATUS.md, TASKS.md, docs/sql-commandes.txt updated.

### Verified (2026-08-31)
- Unit **11/11**; e2e **15/15, 3 suites** (health + auth + core RBAC); builds API + web pass (`/`, `/auth`, `/manager`).
- Live RBAC smoke: seeded admin OK; USER GET /products 200, POST /products 403, GET /servers 403, GET/POST servers blocked; no token 401; ADMIN create product+server 201; lists OK.
- Web: `/` 200, `/manager` 200, proxy `/api/health` 200.

### Owner validation (2026-08-31)
- Owner confirmed live: `/manager` admin console (admin login, create/list products & servers), `/api/docs` Swagger group with products/servers CRUD + RBAC, and the 401/403 behavior. Phase 2 closed.

### Pending (not yet done)
- Commit of Phase 2 (in progress).

## Phase 1 — COMPLETE and owner-validated (2026-08-31)
Owner gave GO for "Auth + 1res tables", then confirmed the browser validation ("validé"). Phase 1 closed.
### Added
- **Auth (ADR-015)**: `apps/api/src/auth/*` — JWT Bearer access token (short-lived, `15m`) + refresh token in httpOnly cookie (rotated, revocable, stored sha256-hashed), bcryptjs hashing, minimal RBAC `ADMIN | USER` + JWT/Roles guards. Endpoints: `POST /api/auth/register|login|refresh|logout`, `GET /api/users/me` (protected). Open registration (Phase 1 scope).
- **First business tables (ADR-016)**: Prisma `User` + `RefreshToken` + `Role` enum; migration `20260830053420_init_auth` (first migration baseline — `_prisma_migrations`, `users`, `refresh_tokens`). Config socle extended with `JWT_SECRET`, `JWT_EXPIRES_IN`, `REFRESH_EXPIRES_IN_DAYS`, `COOKIE_NAME` + fail-early validation.
- **Web auth page** `apps/web/src/app/auth/page.tsx` (login/register → /api with credentials:'include', GET /users/me with Bearer, logout) + same-origin `/api/*` rewrite in `next.config.mjs` so the httpOnly cookie survives in the browser.
- Swagger Bearer JWT security scheme.
- Tests: auth e2e suite (full flow).

### Changed
- DECISIONS.md: ADR-015 + ADR-016 APPROVED at Phase 1 GO (2026-08-30).
- `@nestjs/jwt` pinned `^11.0.2` (CJS dist) — fixes jest "Cannot use import statement outside a module" (v12 ships ESM-only dist).
- `auth.module.ts` registers the JWT secret via `JwtModule.registerAsync` so signing and the guard's verification share one config (fixed 401 on `/users/me` found by e2e).
- PROJECT_STATUS.md, TASKS.md, docs/sql-commandes.txt updated.

### Verified (2026-08-31)
- Unit 2/2; e2e **6/6 across 2 suites** (health + auth); builds API + web pass (incl. `/auth` route).
- Live smoke on `/api`: register→login→refresh→logout→revocation (401) all correct; httpOnly refresh cookie captured; `/users/me` returns profile without passwordHash.
- Swagger `/api/docs` 200 with `bearer`/`bearerFormat: JWT`.
- Web proxy `GET localhost:3000/api/health` 200; web `/auth` page 200.

### Verified (2026-08-31, owner browser validation)
- Owner opened the `/auth` page, created an account, retrieved `/api/users/me` (profile without passwordHash), re-logged in, and confirmed the Swagger Bearer scheme. Phase 1 closed.

## Phase 0 — COMPLETE and owner-validated (2026-08-30)
Owner confirmed the browser validation (health API, Swagger, web diagnostic page). Phase 0 closed.
### Added
- Monorepo foundation (pnpm workspaces + Turborepo): root `package.json`, `pnpm-workspace.yaml`, `turbo.json`.
- Development infrastructure `docker-compose.yml` (PostgreSQL 16 only; no Redis — ADR-012).
- Backend `apps/api` (NestJS 11): `GET /api/health`, validated startup config socle (ADR-011), global prefix, dev CORS, openPrisma wiring.
- Prisma schema with **no business models** (ADR-014); connectivity via real `SELECT 1`.
- Frontend `apps/web` (Next.js 15 App Router): diagnostic page calling the API.
- OpenAPI/Swagger setup served at `/api/docs`.
- Unit + e2e tests for the health endpoint (files authored).
- `.gitignore` strengthened; `.nvmrc`; `.env.example` for both apps (ADR-011); local `.env` (gitignored).
- `docs/sql-commandes.txt` pending update once migrations run.

### Changed
- DECISIONS.md: ADR-001..005 and ADR-011..014 marked APPROVED at owner's Phase 0 GO; ADR-006/007/008/009/010 remain PROPOSED.
- README.md: monorepo layout + quick-start.
- PROJECT_STATUS.md: reflected real Phase 0 state.

### Pending (not yet done)
- Owner browser validation of Phase 0.
- Commit of the Phase 0 baseline (on owner request).

### Verified (2026-08-30)
- Unit tests 2/2 PASS; e2e 1/1 PASS; monorepo build 2/2 PASS.
- Live: /api/health → ok/database ok; /api/docs (Swagger) 200; /api/docs-json 200 (path /api/health); web / 200 diagnostic page.
- Dev DB reset to a fresh Postgres volume (docker compose down -v && up) per owner request; no old iCodeHost build in Docker (verified).