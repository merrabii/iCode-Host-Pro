# PLAN DE DÉPLOIEMENT — CODE DIALI (plateforme)

**Date :** 11/10/2026 — **révision « fiabilisation »** (corrections sourcées sur le code)
**Statut :** préparation documentaire — **AUCUN déploiement exécuté, aucune migration exécutée, aucun secret révélé**
**Marque publique :** Code Diali · **Entité juridique :** Code Diali LLC
**Version applicative de référence :** commit `463f0146afebeb21757d9c1035bfc731f31fc351` (intégré à `main`, poussé, CI SUCCESS run `38145740652`)

> **Convention de lecture (fiabilisation 11/10)** : chaque élément est étiqueté
> **[V]** fait vérifié (source : fichier:ligne du commit `463f0146`) ·
> **[P]** proposition · **[D]** décision à prendre · **[NT]** non testé.
> Une ancienne consigne n'est jamais présentée comme architecture prouvée.

---

## 0. Résumé exécutif

Monorepo TypeScript (turbo/pnpm) :

| Composant | Technologie | Rôle |
|---|---|---|
| **API** | NestJS + Prisma + PostgreSQL | Backend REST, auth, audit, paiements |
| **Web** | Next.js 15 (React 19) | Interface client/manager/admin |
| **PostgreSQL** | 16 | Base de données unique |

**Pas de Redis, pas de worker** — monolithe volontaire (ADR-007) **[V]** `docker-compose.yml` (PostgreSQL seul).

**Topologie de production (décision durable)** : VPS dédié **séparé** des serveurs d'apps
clients, Postgres locale (`CLAUDE.md` §3) **[V]**. Les opérations sur les apps **clients**
passent par `PanelTransport` (Coolify aujourd'hui, invisible côté client) **[V]**
`apps/api/src/servers/panel-transport.factory.ts`.

**⚠️ Ce plan n'est PAS une autorisation de production.**

---

## 0bis. Packaging de premier déploiement — LIVRÉ et VALIDÉ (GO 12/10/2026)

Le GO « préparation technique du premier déploiement » a livré, dans `deploy/` (branche
`prep/premier-deploiement`, aucun commit), le packaging du parcours retenu (VPS dédié +
projet Coolify isolé) **et l'a validé sur une VM de test locale dédiée** (172.20.116.6,
Ubuntu 22.04, Docker 29.9.0 — **pas la production**) :

| Livrable | Rôle | Validation VM |
|---|---|---|
| `deploy/docker/api.Dockerfile` | Image API multi-stage (node 22, pnpm 9.15.0, prisma CLI, pg_dump 16) | **PASS** build + démarrage |
| `deploy/docker/web.Dockerfile` | Image Web (next build avec `API_UPSTREAM`/`NEXT_PUBLIC_API_URL`) | **PASS** build + 200 |
| `deploy/docker-compose.yml` | Stack `code-diali` (volumes `cdiali_*`, gates OFF, jobs `ops` profilés) | **PASS** up/stop/up |
| `deploy/.env.example` | Configuration **sans aucun secret** (placeholders) | — |
| `deploy/scripts/migrate-guarded.sh` | Migration protégée : URL obligatoire, identité SQL (base + hôte résolu + port), backup préalable vérifié, refus avant mutation | **PASS** (66 migrations) + **refus exit 3** (cible fausse) |
| `deploy/scripts/backup.sh` | pg_dump + fichiers + SHA-256 + `pg_restore --list`, mode 0600, exit bruyant | **PASS** (177 717 o + 1 fichier) |
| `deploy/scripts/restore.sh` | Base vierge exigée (refus exit 3 sinon), empreintes revérifiées, rapprochement lecture seule | **PASS** (RESTORE_OK) |
| `deploy/scripts/bootstrap-check.mjs` | Contrôle des gates base + env (`--first-boot`) | **PASS** (exit 1 → désactivation → exit 0) |
| `deploy/README.md` | Séquencement, autorité HTTPS=Coolify, build vs runtime, mise à jour, catégories de preuve | — |

**Corrections apportées au passage** (anomalies réelles trouvées par la validation) :
`start:prod` corrigé en `node dist/src/main.js` (`apps/api/package.json` — le chemin
`dist/main` n'existe pas) · `pnpm --filter pkg exec prisma generate` exigé (sans `exec`,
le generate **ne tourne pas** — 355 erreurs TS) · `openssl` requis dans l'image builder ·
`postgresql-client-16` (PGDG) exigé (le client 15 **refuse** un serveur 16) · URL Prisma
`?schema=public` **strippée** pour pg_dump/pg_restore · scripts **sans BOM** UTF-8 ·
seed admin exige le `package.json` copié dans l'image runtime.

**Séquencement explicite** : ce packaging est le **premier déploiement contrôlé**. Les
fonctionnalités futures « installateur web » et « commande serveur vierge » (CLAUDE.md §5)
**ne sont pas nécessaires** pour ce parcours et **ne sont pas développées** ici.

**NON TESTÉ sur la VM** : intégration Coolify réelle (Coolify non installée — la stack
prouve le packaging Docker, pas le reverse proxy/TLS/Coolify) · TLS/HTTPS (aucune autorité
proxy dans la stack de validation) · simulateur en production (refus dur vérifié dans le
code, `payment-provider.service.ts:404-406`, non exercé runtime car gates OFF) · tout
appel Stripe/SMTP/DNS/panel (interdit, aucun configure).

**⚠️ Validation Docker ≠ validation d'intégration Coolify** (catégories de preuve
distinctes — voir `deploy/README.md`).

---

## 0ter. Préproduction réelle — EXÉCUTÉE et VALIDÉE (GO 13/10 + GO V2 14/10 + GO V3 15/10/2026) **[V]**

Le GO « PRÉPRODUCTION CODE DIALI » (13/10) a déployé **via Coolify 4.4.6** (projet isolé sur la VM
172.31.47.238, app `uawjvxk573pyx13v6o8bgxpp`, SHA épinglé `dc747bcda9f8…`) l'intégralité du
parcours du §0bis **sur une vraie instance Coolify** ; le **GO V2** (14/10) a établi l'**accès
direct durable sans tunnel** et documenté les **interventions Coolify internes**.

| Étape | Verdict | Preuve |
|---|---|---|
| Déploiement dockercompose+git (clone @SHA, images `*_api/_web:dc747bc…`) | **[V] PASS** | deploys #5/#6/#8 DONE (Coolify API) |
| `migrate-guarded.sh` — 66 migrations sur base vierge | **[V] PASS** | `MIGRATE_EXIT=0` |
| `check-gates --first-boot` — paiements OFF | **[V] PASS** | 1er passage NON CONFORME (`cardTopupEnabled`) → PATCH admin (voie sanctionnée) → CONFORME |
| `seed-admin` (ADR-017, credentials hors fixture) | **[V] PASS** | `Admin ensured (role=ADMIN)` |
| Santé web/API/DB + marque + catalogue + capacités paiement | **[V] PASS** | health 200/ok, web 200, `cardAvailable:false` |
| Redémarrage contrôlé de la stack | **[V] PASS** | 3 conteneurs → health/login/web OK |
| Sauvegarde + restauration (base isolée neuve, source préservée) | **[V] PASS** | dump 178 123 o ; `cd_preprod_restore` 59/59 tables |
| **Consultation navigateur via TUNNEL SSH (127.0.0.1:13000)** — V1 | **[V] PASS 15/15** | `recette/tunnel/verify.json` + 4 captures |
| **Accès LAN direct 3211/3212** — V1 | **[V] BLOQUÉ** | limitation Coolify 4.4.6 : `ports_mappings` non appliqué pour app dockercompose+git sans commit (jamais PASS) |
| **Accès direct HTTPS sans tunnel** (reverse proxy Caddy hors Coolify) — V2 | **[V] PASS 14/14** | `recette/direct/verify.json` + 6 captures ; `https://172.31.47.238:3443` |
| **Interventions Coolify internes documentées** — V2 | **[V] PASS** | parsers.php patch (non retiré) + psql remplacé par DELETE+POST API ; ETAT-REPRISE §GO V2 |
| **Redéploiement contrôlé post-V2** (sans tunnel, sans réapplication parsers.php) | **[V] PASS** | `force_rebuild` → nouvelles conteneurs, accès revérifié 14/14 |
| **Gates paiements préservés après V2** | **[V] PASS** | `payment-methods` = `[]` ; `simulate-payment` = 400 |
| **Fix SSR durable (`API_UPSTREAM` split) — V3** | **[V] PASS** | commit `4b18d83` ; bundle résout `http://api:3001`, aucun patch conteneur |
| **Compose Coolify-compatible (plus aucun `${VAR:?}`) — V3** | **[V] PASS** | `${VAR:-…}` partout ; refus dans `preflight.sh` + scripts ops |
| **Redéploiement SANS parsers.php patch — V3** | **[V] PASS** | parsers.php original, `POST start` → finished, conteneurs `…20261015T032516` |
| **Branche dédiée poussée (V3)** | **[V] PASS** | `feat/preprod-reproductible-v3` = `4b18d83`, 0/0 ; `main` inchangée |
| Branding SSR réel (pas de repli silencieux) — V2 | **[V] PASS** (workaround) | patch bundle temporaire → `http://api:3001` ; **fix définitif = git push delta `brand-data.ts`** |

**Implication pour le plan** : la **validation d'intégration Coolify annoncée manquante** au
§0bis est désormais **acquise sur préproduction** (catégorie « VM de test dédiée »), la
production (VPS + domaine + secrets) restant entièrement à faire (§8.1). L'**accès direct
HTTPS** (`https://172.31.47.238:3443`) remplace le tunnel SSH comme voie principale de
consultation ; le tunnel reste en secours. Le **fix SSR définitif** a été **committé et poussé
dans le GO V3** (branche `feat/preprod-reproductible-v3`, `4b18d83`) avec le compose
Coolify-compatible — la préproduction se déploie **sans parsers.php patch ni patch bundle**.
Rapport unique : `recette/RAPPORT-GO-PREPRODUCTION.md` ; journal complet :
`recette/ETAT-REPRISE.md` (blocs « GO V2 » et « GO V3 »). Branche dédiée poussée (V3) ;
`main` ni merge ni poussée de nouvelle valeur.

---

## 1. Inventaire vérifié (source = commit `463f0146`)

### 1.1 Composants et mécanismes réellement présents

| Élément | État | Source exacte |
|---|---|---|
| API NestJS | **[V]** | `apps/api/` ; build `nest build` ; lancement réel : `node apps/api/dist/src/main.js` (**[V]** `recette/up.ps1`) |
| Web Next.js 15 | **[V]** | `apps/web/` ; build `next build` ; lancement `next start -p <port>` ; rewrite `/api/*` → `API_UPSTREAM` **figé au build** (**[V]** `apps/web/next.config.mjs:8-12`, défaut `http://localhost:3001`) |
| PostgreSQL 16 | **[V]** | `docker-compose.yml` (dev : conteneur `icode-postgres`) |
| Prisma — **66 migrations** | **[V]** | `apps/api/prisma/migrations/` = **66 dossiers** au commit `463f0146` (harmoniser tous les documents sur 66) |
| Node / pnpm | **[V]** | `.nvmrc` = **22** ; `package.json` racine : `engines.node >= 22`, `packageManager = pnpm@9.15.0` |
| CI GitHub | **[V]** | `.github/workflows/ci.yml` : unit + e2e sur Postgres isolé ; **ne produit AUCUN artefact de déploiement** (builds exécutés pour contrôle, non publiés) |
| Dockerfile / compose de prod / unités systemd / config PM2 / nixpacks | **[ABSENT du dépôt]** | aucun fichier trouvé à la racine ni dans `apps/` — **[D]** ou **[à développer]** (§8) |
| Redis / workers | **[V] absent** | ADR-007, compose dev PostgreSQL seul |

> **Anomalie de packaging signalée (non corrigée ici — changement applicatif interdit)** :
> `apps/api/package.json` → `start:prod = "node dist/main"` alors que le build produit
> `dist/src/main.js` (`nest-cli.json` `sourceRoot: "src"` ; chemin réellement exécuté en
> recette et en CI). Le démarrage documenté dans ce plan utilise
> **`node apps/api/dist/src/main.js`** (chemin prouvé).

### 1.2 Services tiers — où la configuration vit VRAIMENT

| Service | Configuration | État | Source |
|---|---|---|---|
| **Stripe** | **En base** (`PaymentProviderSetting`, chiffrée), via `/manager/paiements-carte` — **aucune variable `STRIPE_*` dans le code** | **[V]** | recherche `STRIPE_*` : 0 hit hors specs mocks ; écritures via `payment-provider.service.ts` |
| **SMTP** | **En base** (`MailSettings`, mot de passe chiffré), via `/manager/mail` — **aucune variable `SMTP_*`** | **[V]** | `apps/api/src/mail/mail-settings.service.ts` |
| **DNS Cloudflare** | **En base** (token chiffré, jamais exposé), via `/manager/dns` — **aucune variable `CLOUDFLARE_*`** | **[V]** | `apps/api/src/cloudflare/cloudflare.service.ts` |
| **Turnstile** | **Env API** : `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` ; site key exposée au web via `/api/public/auth-config` **uniquement si activée par l'admin** | **[V]** | `config/configuration.ts:168-169` ; `apps/api/src/auth/public-config.controller.ts` + spec (« flag OFF → site key not exposed ») |
| Chiffrement de tous les secrets en base | **`ENCRYPTION_KEY`** (env API, AES-256-GCM, format libre → sha256 → 32 octets) | **[V]** | `apps/api/src/crypto/crypto.service.ts:14-16` ; utilisée par mail/cloudflare/payments/servers/oauth/mfa |

### 1.3 Informations manquantes (bloquants)

| Information | État |
|---|---|
| **VPS cible** (host, accès SSH) | **[D]** — aucune identification ; **ne jamais fournir de mot de passe dans le chat** : configuration locale sécurisée sur le VPS (fichier `.env` `umask 077`, ou mécanisme de secrets du superviseur choisi) |
| **Domaine public final** | **[D]** |
| **Parcours d'installation initiale (bootstrap)** | **[D]** — `CLAUDE.md` §5 : deux voies à fournir (interface web d'installation + commande serveur vierge), **ni l'une ni l'autre n'est encore développée** ; test d'installation réel volontairement reporté en fin de projet (CLAUDE.md §Rappel) |
| **Compte Stripe test** | **[D]** — non créé → catégorie B bloquée |
| **Origine des artefacts de prod** | **[D]** — CI ne publie pas d'artefact (§2.2) |
| **Stratégie de sauvegarde (RPO/RTO)** | **[D]** — §4.6 |

---

## 2. Architecture cible et parcours principal

### 2.1 Résolution de la contradiction « plateforme via Coolify » / « Coolify réservé aux apps clients »

- **[V] Décision durable (`CLAUDE.md` §1-§6)** : Coolify (aujourd'hui) est le **panel des
  apps clients**, abstraction `PanelTransport` — jamais exposé aux clients ; les **opérations
  d'hébergement des apps clients** passent par le chemin de code API du panneau, jamais l'UI
  ni Docker à la main.
- **[V] Décision durable (`CLAUDE.md` §3 + §Rappel)** : la **plateforme** vit sur un **VPS
  dédié, distinct** des serveurs d'apps clients ; le test final d'installation prévoit un
  **projet Coolify isolé** sur ce VPS séparé et un déploiement « via son propre chemin de
  code API ».
- **[V] Limite assumée (`CLAUDE.md` §5 + §Rappel)** : les deux **voies d'installation**
  (interface web d'installation ; commande serveur vierge) sont **à développer** et le test
  d'installation réel est **reporté en fin de projet**. Aucun chemin de bootstrap de la
  plateforme n'est aujourd'hui **exécutable**.
- **Conséquence (la version antérieure de ce plan était erronée)** : le §2 précédent
  affirmait « Coolify n'est pas pour la plateforme » puis le §0 affirmait l'inverse.
  **Résolution** : la topologie cible (VPS séparé + projet Coolify isolé) est **décidée**
  (CLAUDE.md) ; le **mécanisme de premier démarrage** reste **[D]** (voir §2.3).

### 2.2 Origine des artefacts — état réel

- **[V]** La CI (`ci.yml`) exécute unit + e2e (+ contrôles de build) mais **ne publie
  aucun artefact** (`dist`, `.next`) déployable.
- **[D] Décision requise** (exclusive) :
  1. **[P] Construction contrôlée sur cible** (parcours principal proposé, aligné avec
     l'état actuel) : `git checkout <SHA autorisé>` + `pnpm install --frozen-lockfile` +
     `prisma generate` + `nest build` + `next build` **directement sur le VPS** ; ou
  2. **Étendre la CI** pour publier des artefacts signés (travail à développer, hors
     périmètre actuel).
- Le plan et la checklist utilisent désormais la **même** origine : tant que (2) n'existe
  pas, l'artefact vient d'une **construction contrôlée sur cible** au SHA figé — pas
  d'une « machine dev » non maîtrisée, et pas d'une CI qui ne produit rien.

### 2.3 Parcours principal proposé [P] — à valider

**VPS dédié Ubuntu 22.04/24.04, séparé des apps clients** :
1. Prérequis : Docker + compose (PostgreSQL locale), Node 22 (`.nvmrc`), pnpm 9.15.0
   (`packageManager`), reverse proxy HTTPS (Caddy ou nginx — **[D]** au choix, aucun
   fichier fourni dans le dépôt).
2. Construction contrôlée sur cible (§2.2-1) au SHA autorisé.
3. Exécution des deux services via les **commandes npm réelles** (§6.1) sous le
   superviseur **[D]** : systemd est **recommandé [P]** pour un VPS Linux, mais **aucune
   unité n'existe dans le dépôt** — les fichiers sont à développer (§8). PM2 et Compose
   d'app ne sont **pas** préparés et ne sont pas présentés comme options opérationnelles.
4. Bootstrap de l'instance (installateur web ou one-liner) : **[D]** + **[à développer]**
   (CLAUDE.md §5) — **non simulé** dans ce plan.

> Aucune promesse de rolling update : le déploiement réel est un **arrêt/reconstruction/
> redémarrage** (§6.3), décrit comme tel.

---

## 3. Construction et démarrage (commandes sourcées)

### 3.1 Construction contrôlée

```bash
git clone https://github.com/merrabii/iCode-Host-Pro.git
cd iCode-Host-Pro
git checkout <SHA_AUTORISE>            # 463f0146 est la version de référence actuelle
pnpm install --frozen-lockfile         # [V] lockfile pnpm@9.15.0
pnpm -C apps/api exec prisma generate  # [V] OBLIGATOIRE avant build (119 erreurs TS sinon)
pnpm -C apps/api exec nest build       # [V] produit apps/api/dist/src/main.js
API_UPSTREAM=http://localhost:<PORT_API> pnpm -C apps/web exec next build
# [V] next.config.mjs : API_UPSTREAM est figé AU BUILD (rewrite /api/*)
```

### 3.2 Variables minimales de démarrage (détail §5)

```bash
# Fichier .env local au VPS — JAMAIS dans Git, JAMAIS affiché dans le chat
NODE_ENV=production
DATABASE_URL=postgresql://<USER>:<PASS>@127.0.0.1:5432/<NOM_BASE_PROD>   # base neuve
JWT_SECRET=<neuve, forte>              # [V] requise au boot (configuration.ts:145-153)
PORT=<PORT_API>                        # [V] requise au boot
ENCRYPTION_KEY=<neuve, forte, CONSERVÉE>  # [V] requise pour lire/écrire les secrets en base
PUBLIC_BASE_URL=https://<DOMAINE>      # liens d'invitation email
WEB_ORIGIN=https://<DOMAINE>           # retour des tunnels de paiement hébergé
NEXT_PUBLIC_API_URL=https://<DOMAINE>  # brand-provider (navigateur)
```

### 3.3 Migrations — garde bloquante sur la cible EFFECTIVE

Le simple affichage de `current_database()` **n'empêche rien** (incident documenté :
`docs/DOSSIER-INCIDENT-MIGRATIONS.md`). La procédure de prod doit utiliser une **garde
bloquante** :

1. **[V] Modèle existant** : `recette/db-guard.mjs` lit `current_database()` et **exit 1**
   si la base n'est pas dans une liste blanche (appelé par les scripts **avant** toute
   opération ; testé : refus base hors liste).
2. **[P] Pour la prod** : wrapper obligatoire « migrate deploy » qui (a) exige
   `DATABASE_URL` explicite, (b) interroge `current_database()` **via une connexion
   dédiée**, (c) compare à la liste blanche `{ <NOM_BASE_PROD> }`, (d) **exit 1 sans
   rien exécuter** en cas de mismatch, (e) exécute ensuite `prisma migrate deploy` avec
   la MÊME URL. À développer (§8) — **aucune migration n'est exécutée dans ce GO**.
3. Sauvegarde **pré-migration obligatoire** (§4).
4. Compte attendu sur `463f0146` : **66 migrations** **[V]**.

### 3.4 Contrôles de santé

```bash
curl -s http://localhost:<PORT_API>/api/health
# [V] {"status":"ok","database":"ok",...}
curl -s -o /dev/null -w "%{http_code}" http://localhost:<PORT_WEB>/
# [V] 200
```

Pas de « login admin avec fixture » en prod : le compte administrateur de production se
crée par le **mécanisme réellement existant** — le seed ADR-017
(`pnpm -C apps/api db:seed`, **[V]** `prisma/seed.ts` : idempotent, lit
`ADMIN_EMAIL`/`ADMIN_PASSWORD` **uniquement au moment du seed**, ne réinitialise jamais un
mot de passe existant). **Jamais de fixture de recette en production.**

---

## 4. Sauvegarde, restauration, retour arrière

### 4.1 Ce qui doit être sauvegardé

| Élément | Méthode | Note |
|---|---|---|
| Base PostgreSQL | `pg_dump` gzip horodaté | **stockage hors VPS** |
| `ENCRYPTION_KEY` | copie chiffrée hors VPS, coffre | **[V] sans elle, les secrets chiffrés en base (SMTP, DNS Cloudflare, Stripe, serveurs) sont illisibles après restauration** (`crypto.service.ts`) |
| Fichier `.env` prod | copie chiffrée hors VPS | contient JWT_SECRET, DATABASE_URL… |
| Certificats HTTPS + config reverse proxy | `rsync` | |
| Code source | Git (`main` + tags autorisés) | |
| Clés Stripe | Dashboard Stripe (rotation documentées) ; la config chiffrée en base dépend d'`ENCRYPTION_KEY` | |

### 4.2 Sauvegarde automatisée — procédure à fiabiliser [P]

- Cron `pg_dump` quotidien + **détection d'échec** (code retour, taille > seuil,
  `pg_isready` préalable, alerte en cas d'échec) — **aucune automatisation n'existe
  aujourd'hui** **[V]** (aucun fichier dans le dépôt) ;
- **[D] RPO/RTO proposés** (à valider par le propriétaire, jamais marqués PASS sans
  preuve) : RPO 24 h (dump quotidien) / RTO ~2 h (restauration + rapprochement). Une
  réduction du RPO exige des dumps plus fréquents ou de la réplication (**[à développer]**).

### 4.3 Exercice de restauration — sans destruction automatique

```bash
# 1. Base isolée dédiée
psql -h 127.0.0.1 -U <ADMIN_PG> -c "CREATE DATABASE icode_host_pro_restore_test;"
# 2. Restaurer la sauvegarde dedans
gunzip -c backup_YYYYMMDD.sql.gz | psql -h 127.0.0.1 -U <ADMIN_PG> -d icode_host_pro_restore_test
# 3. Vérifier (migrations, comptages clés)
psql ... -d icode_host_pro_restore_test -c "SELECT count(*) FROM _prisma_migrations;"
# 4. Vérifier la lisibilité des secrets avec la Clé de chiffrement de PRODUCTION
#    (sinon : les données restaurées sont inutilisables — constat explicite)
# 5. LAISSER la base de test sur place pour revue — suppression UNIQUEMENT sur
#    instruction explicite et tracée (aucune suppression automatique).
```

### 4.4 Retour arrière APPLICATIF ≠ restauration de DONNÉES

- **Retour arrière applicatif** : redéployer le tag/SHA précédent (arrêt des services,
  reconstruction du SHA antérieur, redémarrage). **Neutre pour les données** si le
  schéma est compatible.
- **Restauration de données** : décision **séparée**, **jamais systématique**, réservée
  à une corruption/perte avérée ; elle déclenche la procédure §4.5.
- **Compatibilité ancien code ↔ schéma** : les migrations du lot sont **additives**
  **[V]** (noms et contenu vérifiés), mais **on ne conclut jamais « l'ancien code tourne
  sur le nouveau schéma » sur cette seule base** : toute rétrocompatibilité se vérifie
  par un déploiement du SHA antérieur sur copie (exercice **[à faire]**, jamais réalisé).

### 4.5 Suspension contrôlée avant restauration, rapprochement avant réouverture

Avant toute restauration de prod :
1. **Suspendre les écritures** : retirer le domaine du reverse proxy (ou le mettre en
   maintenance), **arrêter les services API/Web** (les timers de sweep sont dans le
   processus API : `ORDER_SWEEP_ENABLED`/`RENEWAL_SWEEP_ENABLED`/`RECONCILE_*` — l'arrêt
   du processus les stoppe **[V]**), couper tout autre processus écrivant.
2. **Conserver l'état courant** : exporter les tables financières **de l'état d'AVANT
   restauration** : `CardPayment`, `Refund`, `RefundObservation`, `WalletTransaction`,
   `PaymentWebhookEvent`, `Order` (+ export CSV horodaté hors VPS).
3. Restaurer.
4. **Rapprochement avant réouverture** : confronter les exports et le **journal du
   provider** (Dashboard Stripe : paiements/remboursements/events) aux tables restaurées ;
   rejouer/importer les événements manquants ; pour tout écart → **intervention admin**
   ouverte et tracée (`/manager/paiements-carte`) ; revérifier soldes wallet et effets
   provider (sous-domaines, déploiements) avant de remettre le domaine public.
5. Rouvrir, journaliser l'incident.

> Une restauration n'annule **jamais** une opération déjà effectuée chez le provider.

### 4.6 Sauvegarde — état honnête

**[V] Aucune** sauvegarde automatisée, exercice de restauration, ou mesure RPO/RTO
n'existe aujourd'hui pour la production (tout est à mettre en place sur la cible).
Aucune case de sauvegarde ne peut être marquée PASS avant une exécution tracée sur
l'environnement cible.

---

## 5. Table de configuration — REFAITE DEPUIS LE CODE (`463f0146`)

### 5.1 API — variables d'environnement réellement lues

| Variable | Rôle | Requise | Défaut | Source |
|---|---|---|---|---|
| `DATABASE_URL` | Connexion base | **[V] OUI au boot** | — | `config/configuration.ts:145-153` (fail-early) |
| `PORT` | Port API | **[V] OUI au boot** | — | idem |
| `JWT_SECRET` | Signature JWT | **[V] OUI au boot** | — | idem |
| `ENCRYPTION_KEY` | Clé maître AES-256-GCM de TOUS les secrets en base (SMTP, DNS Cloudflare, Stripe, serveurs, OAuth, MFA) — format libre (sha256→32 o) | **[V] au boot : non** (optionnelle) ; **[V] OUI dès qu'un secret doit être lu/écrit** | `''` | `configuration.ts:166` ; `crypto/service.ts:14-16,23-27` |
| `NODE_ENV` | Mode | non | `development` | `configuration.ts:159` |
| `API_PREFIX` | Préfixe routes | non | `api` | `configuration.ts:157` |
| `JWT_EXPIRES_IN` | TTL access token | non | **`15m`** | `configuration.ts:161` (l'ancien plan disait « 3600 » : erroné) |
| `REFRESH_EXPIRES_IN_DAYS` | TTL refresh cookie | non | **`30`** | `configuration.ts:162` (l'ancien plan disait « 7 » : erroné) |
| `COOKIE_NAME` | Cookie refresh | non | `ihp_refresh` | `configuration.ts:163` |
| `PUBLIC_BASE_URL` | URL publique pour liens d'invitation email | non | `http://localhost:3000` | `configuration.ts:167` |
| `WEB_ORIGIN` | Origine de retour des **tunnels de paiement hébergés** (checkout success, portefeuille) | non | `http://localhost:3000` | `card-payments.service.ts:640` ; `simulated-payment.controller.ts:69,145` |
| `PUBLIC_API_BASE` | URL publique de l'API (paiements/provider) | non | `http://localhost:3001` | `payment-provider.service.ts:116` |
| `TURNSTILE_SITE_KEY` | Site key Turnstile (exposée via `/api/public/auth-config` si activée par admin) | non | `''` (Turnstile off) | `configuration.ts:169` |
| `TURNSTILE_SECRET_KEY` | Secret Turnstile (vérification serveur) | non | `''` | `configuration.ts:168` |
| `TRUST_PROXY` | Proxies de confiance (XFF) — **`true` REFUSÉ** ; presets/IP/CIDR | non | `false` | `configuration.ts:50-83,179` (ADR-041) |
| `INVITE_EXPIRES_IN_DAYS` | TTL invitation | non | `7` | `configuration.ts:164` |
| `PASSWORD_RESET_EXPIRES_IN_MINUTES` | TTL reset | non | `30` (clamp 5..1440) | `configuration.ts:165` |
| `SUPPORT_CODE_PEPPER` / `SUPPORT_CODE_TTL_MINUTES` | Codes support HMAC | non | `''` / `60` | `configuration.ts:174-175` |
| `MFA_OTP_TTL_SECONDS` | TTL OTP MFA | non | `300` | `configuration.ts:176` |
| `IMPERSONATION_EXPIRES_IN` | TTL impersonation | non | `60m` | `configuration.ts:177` |
| `OAUTH_STATE_TTL_SECONDS` | TTL state OAuth | non | `600` | `configuration.ts:178` |
| `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` | OAuth (ADR-027) | non | `''` (désactivé) | `configuration.ts:170-173` |
| `HOSTING_C2_ENABLED` | Flag hébergement C2 — doit valoir **exactement** `'true'` | non | off | `hosting/c2-flag.ts:6` |
| `HOSTING_C3_ENABLED` | Flag hébergement C3 (provisioning) — exactement `'true'` | non | off | `hosting/c3-flag.ts:6` |
| `HOSTING_C4_ENABLED` | Flag hébergement C4 (nettoyage/récupération) — exactement `'true'` | non | off | `hosting/c4-flag.ts:6` |
| `ORDER_SWEEP_ENABLED` | **Sweep des commandes** (cycle de vie) — actif **uniquement** si `'true'` exact | non | **OFF** | `store/order-lifecycle.service.ts:16,65` |
| `RENEWAL_SWEEP_ENABLED` | **Sweep des renouvellements** — actif **uniquement** si `'true'` exact | non | **OFF** | `store/renewal.service.ts:39,123` |
| `RECONCILE_ENABLED` | **Réconciliateur des DÉPLOIEMENTS panel** (Phase 17B) — défaut **false** | non | `false` | `store/reconcile-settings.ts:31-39,66` |
| `RECONCILE_SCAN_INTERVAL_MS` / `_BATCH_SIZE` / `_LEASE_MS` / `_ATTEMPT_ALERT_THRESHOLD` / `_BACKOFF_INITIAL_MS` / `_MAX_BACKOFF_MS` | Bornes du réconciliateur (30 000 / 10 / 120 000 / 12 / 30 000 / 3 600 000 ; valeurs hors bornes → défaut + warn) | non | défauts ci-contre | `reconcile-settings.ts:44-51,65-73` ; priorité **base (overrides admin) → env → défauts** **[V]** |
| `PAYMENT_SIMULATOR_ENABLED` | Simulateur de paiements — actif **seulement** si `'true'` **ET** `NODE_ENV !== 'production'` ; **en production l'accès simulateur est REFUSÉ même si l'env est `true`** | non | **coupé** | `payment-provider.service.ts:271,404-406,437` ; `config/payment-simulator.ts:5` |

**Variables supprimées de l'ancien plan (inexistantes dans le code — vérifié 454 fichiers) :**
`RECOMMANDED_ENABLED` **[V] ABSENTE** — aucune lecture nulle part ; `HOSTING_C3_ENABLED`
existait bien (l'ancien plan l'avait par chance) mais `RECONCILE_ENABLED=true (défaut)`,
`ORDER_SWEEP_ENABLED=true`, `RENEWAL_SWEEP_ENABLED=true` étaient **faux** (défauts OFF) ;
`TURNSTILE_SITEKEY` (mauvais nom → `TURNSTILE_SITE_KEY`) ; `JWT_EXPIRES_IN=3600` /
`REFRESH_EXPIRES_IN_DAYS=7` (défauts réels : `15m` / `30`).

**Variables NON existantes (ne pas les créer) :** `STRIPE_API_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `SMTP_HOST/PORT/USER/PASS/FROM`, `CLOUDFLARE_API_TOKEN` —
**[V]** ces services se configurent **en base via l'interface admin**, chiffrés avec
`ENCRYPTION_KEY` (§1.2). `ADMIN_EMAIL`/`ADMIN_PASSWORD` : **[V]** lues **uniquement par
le seed** ADR-017 (`prisma/seed.ts`), pas par l'API au démarrage.

### 5.2 Web — variables réellement lues

| Variable | Rôle | Portée | Source |
|---|---|---|---|
| `API_UPSTREAM` | Rewrite serveur `/api/*` → API — **figé au build** (défaut `http://localhost:3001`) | **build** | `apps/web/next.config.mjs:8-12` **[V]** |
| `NEXT_PUBLIC_API_URL` | URL que le **navigateur** utilise pour `/api/brand` (refresh du branding) — défaut `http://localhost:3001` ; **doit être accessible depuis le navigateur** (en prod derrière un domaine unique : l'URL publique `https://<DOMAINE>`) | **build** | `components/brand-provider.tsx:54` ; `lib/brand-data.ts:3` **[V]** |

Le reste du web appelle l'API en **relatif** `/api/*` (même origine, cookies httpOnly —
ADR-015) **[V]** `apps/web/src/lib/api.ts`. **`PUBLIC_API_BASE`/`WEB_ORIGIN` ne sont pas
des variables du web** (elles sont côté API).

### 5.3 Ordre de priorité (API)

1. Variables **requises au boot** : `DATABASE_URL`, `PORT`, `JWT_SECRET` (fail-early).
2. `ENCRYPTION_KEY` : indispensable dès que des secrets en base doivent être lus/écrits.
3. Variables d'adressage public : `PUBLIC_BASE_URL`, `WEB_ORIGIN`, `PUBLIC_API_BASE`
   (+ `API_UPSTREAM`/`NEXT_PUBLIC_API_URL` au build web).
4. Flags fonctionnels (hébergement C2/C3/C4, sweeps, réconciliateur) — tous **OFF** par
   défaut ; activation **explicite et décidée** (§7).
5. Sécurité optionnelle (Turnstile, OAuth, TRUST_PROXY, TTL) — hors activation, tout
   dégrade en « désactivé » **[V]** `configuration.ts:113-115`.

### 5.4 Réglages paiements (base, pas env) — gates vérifiés séparément

**Singleton `PaymentSettings`** **[V]** `prisma/schema.prisma` (modèle) :

| Flag (base) | Parcours | Défaut migration | Gate serveur |
|---|---|---|---|
| `walletPaymentEnabled` | Règlement d'une commande **par solde** | `true` | `assertEnabled()` → 409 `PAYMENT_METHOD_DISABLED` avant tout débit (`store/payment-settings.service.ts:78,128`) |
| `cardOrderPaymentEnabled` | **Carte directe** (règlement commande, page hébergée) | **`false`** | idem + `cardProviderStatus()` : sans Stripe configuré ni simulateur → indisponible |
| `cardTopupEnabled` | **Recharge carte** du portefeuille | `true` | idem + `cardProviderStatus()` |

**Protections production effectives (vérifiées)** :
- Simulateur : `PAYMENT_SIMULATOR_ENABLED=true` **ET** `NODE_ENV !== 'production'` ;
  en production, **refus dur** même si l'env est `true` **[V]**
  `payment-provider.service.ts:404-406` (« Simulateur de paiement interdit en production »).
- Tant que **Stripe n'est pas validé** (catégorie B) : **laisser
  `cardOrderPaymentEnabled=false`** (défaut) et **ne configurer aucune clé Stripe** dans
  `/manager/moyens-paiement` → les parcours carte restent indisponibles côté serveur
  (`methodState` = disabled/incomplete) ; le portefeuille/solde reste le seul chemin
  activable. **Ne rien activer pendant la préparation.**

### 5.5 Parcours VIREMENT — correction d'une erreur du plan précédent

**[V] Le virement EXISTE** (l'ancien plan écrivait « non implémenté — pas de virement
dans CardPayment » : raisonnement erroné, le virement n'a jamais eu vocation à passer
par `CardPayment`) :
- **Modèle** : `WalletTransaction.proofPath` = « preuve de paiement uploadée
  (virement/transfert), lisible admin + client » ; `reference` = référence humaine
  **[V]** `schema.prisma` (modèle `WalletTransaction`) ;
- **Services** : `apps/api/src/wallet/wallet.service.ts` + `admin-wallet.controller.ts`
  (validation admin du justificatif) **[V]** ;
- **UI** : portefeuille client (« Rechargez par virement : chaque dépôt est crédité après
  contrôle du justificatif ») + `/manager/recharges` (validation) **[V]**
  `apps/web/src/app/client/portefeuille/page.tsx`, `app/manager/recharges/page.tsx`.

**Statut honnête** : implémenté (code + UI) ; **exercice complet en recette non revendiqué
dans ce GO → [NT]** dans la matrice §7. Il ne dépend **pas** de Stripe et n'est pas
bloqué par la catégorie B.

---

## 6. Procédures opérationnelles (une voie, sans mélange)

### 6.1 Démarrage (commandes réelles du dépôt)

```bash
# API — chemin prouvé [V] (recette/up.ps1). CORRIGÉ le 12/10 (GO packaging) :
# start:prod = « node dist/src/main.js » (l'ancien « node dist/main » ne
# correspondait pas au chemin de build — anomalie confirmée puis résolue).
# Conteneurs : CMD image = ["node","dist/src/main.js"] (deploy/docker/api.Dockerfile)
node apps/api/dist/src/main.js

# Web — script réel [V] (apps/web/package.json «start: next start»)
node_modules/next/dist/bin/next start -p <PORT_WEB>
```

**[D] Superviseur** : systemd recommandé **[P]** (aucune unité fournie — §8). Tant que
les unités n'existent pas, le démarrage manuel documenté est le seul « officiel » ;
PM2 et docker-compose d'app **ne sont pas préparés** et ne sont pas mentionnés comme
options déployées.

### 6.2 Arrêt

```bash
# Arrêt des deux processus (SIGTERM) — les timers de sweep s'arrêtent avec le processus
kill <PID_API> <PID_WEB>   # ou l'arrêt via le superviseur une fois choisi [D]
```

### 6.3 Mise à jour (pas un rolling update)

1. Sauvegarde DB (§4).
2. `git checkout <SHA suivant autorisé>`.
3. `pnpm install --frozen-lockfile` + `prisma generate` + rebuild API + rebuild Web
   (**avec `API_UPSTREAM` correct** — rebuild obligatoire si l'adresse API change).
4. `prisma migrate deploy` **derrière la garde bloquante** (§3.3) si de nouvelles
   migrations.
5. **Arrêt** puis **démarrage** des services (reconstruction complète — **pas** de
   rolling update : le dépôt ne contient ni mécanisme de bascule ni health-gate
   d'orchestration **[V]**).
6. Vérifications (§3.4).

### 6.4 Retour arrière

- Applicatif : §4.4 (redeploy du SHA antérieur).
- Données : §4.4-4.5 (décision séparée, jamais systématique, rapprochement obligatoire).

---

## 7. Capacités — matrice honnête

| Capacité | Simulation | Stripe test réel (B) | Activation commerciale (D) |
|---|---|---|---|
| Auth/rôles/MFA | **[V] PASS** (unit+e2e+parcours) | N/A | **[D]** |
| Commandes/consentement | **[V] PASS** | N/A | **[D]** |
| Solde wallet (recharge simulée, règlement, remboursement) | **[V] PASS** | N/A | **[D]** |
| **Virement** (justificatif → validation admin) | **[V] implémenté** (code+UI) ; exercice complet **[NT]** | N/A (indépendant de Stripe) | **[D]** |
| Carte directe (règlement commande) | **[V] PASS** (transport factice loopback) | **[D] BLOQUÉ** (aucun compte) | **[D]** |
| Recharge carte | **[V] PASS** (transport factice) | **[D] BLOQUÉ** | **[D]** |
| Factures/remboursements | **[V] PASS** (refund-accounting) | **[D] BLOQUÉ** | **[D]** |
| Provisioning/quotas hébergement | **[V] PASS** (simulateur panel) | N/A | **[D]** (serveur réel **[NT]**) |
| DNS Cloudflare | **[V] simulateur** | token réel **[NT]** | **[D]** |
| SMTP | **[V] mail trap** | SMTP réel **[NT]** | **[D]** |
| HTTPS/reverse proxy | **[NT]** | — | **[D]** |
| Sauvegarde/restauration | **[NT] en prod** (§4.6) | — | **[D]** |

**Catégories** : **B** = Stripe réel **mode test** (argent réel impossible) ; **D** =
activation commerciale (GO distinct). **Simulation ≠ B ≠ D.** Prestataire : **Stripe déjà
choisi** ; **PaymentCloud éventuellement ultérieur** (option, jamais présenté comme acquis).

---

## 8. Blocages et fichiers à développer (non inventés, chantiers NON ouverts)

### 8.1 Décisions minimales attendues du propriétaire [D]

1. **VPS cible** + accès (configuration locale sécurisée, jamais dans le chat).
2. **Domaine public** final.
3. **Parcours d'installation initiale** (installateur web vs one-liner — CLAUDE.md §5,
   à développer ; test d'installation réel reporté en fin de projet).
4. **Origine des artefacts** (construction contrôlée sur cible **[P]** vs CI publish).
5. **Superviseur** (systemd **[P]** vs autre).
6. **Compte Stripe test** (débloque la catégorie B).
7. **SMTP + token Cloudflare + Turnstile** production (configuration en base après
   démarrage — prévoir les valeurs, **jamais** les coller dans le chat).
8. **RPO/RTO** (§4.6) et politique de rétention des sauvegardes.
9. Flags fonctionnels au premier démarrage : **recommandation [P]** tout laisser OFF
   (C2/C3/C4, sweeps, réconciliateur) sauf décision explicite — **aucune activation par
   défaut prescrite**.

### 8.2 Fichiers/opérations À DÉVELOPPER (listés, non ouverts)

- **Installateur web** (host/user/password PG) + **commande serveur vierge** (CLAUDE.md §5).
- **Wrapper de garde bloquante « migrate deploy »** prod (§3.3) — modèle : `recette/db-guard.mjs`.
- **Unités de superviseur** (systemd si choix [P]) — API + Web.
- **Automatisation de sauvegarde** avec détection d'échec + stockage hors cible (§4.2).
- **(Option)** publication d'artefacts par la CI (§2.2-2).
- **Anomalie à corriger** (applicatif, hors ce GO) : script `start:prod` API
  (`node dist/main` → devrait viser `dist/src/main.js`).

---

## 9. Références (sources vérifiées 11/10/2026)

- `CLAUDE.md` — décisions durables d'architecture (§1-§6, §Rappel)
- `apps/api/src/config/configuration.ts` — chargeur de configuration (fail-early, défauts)
- `apps/api/src/store/reconcile-settings.ts` — clés/défauts/bornes réconciliateur
- `apps/api/src/crypto/crypto.service.ts` — ENCRYPTION_KEY (format, dérivation)
- `apps/api/src/payments/payment-provider.service.ts` — simulateur + refus production
- `apps/api/src/store/payment-settings.service.ts` + `prisma/schema.prisma` — gates paiements
- `apps/web/next.config.mjs` — API_UPSTREAM figé au build
- `apps/api/prisma/seed.ts` — seed admin ADR-017 (mécanisme réel d'admin)
- `.github/workflows/ci.yml` — CI (tests uniquement, aucun artefact publié)
- `docs/DOSSIER-INCIDENT-MIGRATIONS.md` — incident (garde bloquante motivée)
- `recette/db-guard.mjs` — modèle de garde vérifié (base isolée, exit 1)
