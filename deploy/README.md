# Code Diali — installation & déploiement (deux parcours)

Ce dossier contient le **packaging de premier déploiement** : images, orchestration,
migrations protégées, sauvegarde/restauration et contrôles de démarrage.

## Installation — deux parcours (V5)

**Version documentée** : commit `1200ad44593d2d3964d2ea37b6ce399b497a09c9`
(branche `feat/preprod-reproductible-v3`, dépôt `merrabii/iCode-Host-Pro`).
Pour installer un état donné : noter le SHA cible puis `git checkout <SHA>`
(puis suivre la section *Mise à jour* pour les états ultérieurs).

**Finitions 21/10 (GO « finitions limitées du livrable V5 »)** : ce guide +
`scripts/ops.sh` (reconstruction explicite `--build` des jobs),
`scripts/gen-preprod-cert.sh` (cible obligatoire, SAN IP/DNS),
`docker-compose.proxy.yml` (réseau/chemins obligatoires, plus aucun repli) et
`.env.example` (clés proxy) portent les corrections de portabilité/version —
livrées via l'archive V5 (delta) et **non committées** (arbitrage au dernier
arrêt, branche dédiée uniquement).

**Principe de configuration** : aucune adresse IP, aucun identifiant Coolify,
aucun chemin Windows ni emplacement particulier d'une machine n'est
**obligatoire** — toutes les valeurs (URLs publiques, UUID de projet, réseaux,
dossiers hôte, identifiants) sont **par installation** et se renseignent dans
`deploy/.env` (copie de `deploy/.env.example`, mode `0600`, **jamais committé**)
ou dans les variables d'environnement de l'orchestrateur (Coolify). Les valeurs
écrites dans `.env.example` sont des **exemples** (VM de test LAN) à remplacer.
Mêmes images, mêmes scripts et mêmes règles de configuration dans les **deux**
parcours — seul l'**orchestrateur de démarrage** diffère (compose direct ou
Coolify). Aucun installateur web n'est requis (feature future, CLAUDE.md §5).

### Parcours A — serveur Ubuntu vierge → Docker Compose → opérationnel

Prérequis : Ubuntu 22.04/24.04, Docker Engine + plugin `docker compose`, `git`,
accès réseau sortant (installation Docker : documentation officielle Docker).

> **Honnêteté (21/10) — *Ubuntu vierge : parcours final non encore exécuté*** :
> la séquence complète du parcours A n'a **pas** été exécutée de bout en bout sur
> un serveur Ubuntu vierge neuf. Elle est **documentée** et ses étapes ont été
> exercées partiellement sur la VM de test (voir le tableau
> *État d'exécution* ci-dessous) — jamais présentée comme validée de bout en bout.

```bash
git clone https://github.com/merrabii/iCode-Host-Pro.git <clone>  # auth jeton HTTPS ou SSH = prérequis opérateur
cd <clone>/deploy
cp .env.example .env && chmod 600 .env
# 1) Éditer .env (valeurs par installation) :
#    PG_USER/PG_PASSWORD/PG_DB, JWT_SECRET (>=32 aléatoires),
#    ENCRYPTION_KEY (clé maître conservée HORS serveur), URLs publiques,
#    COMPOSE_PROJECT_NAME=code-diali (défaut), OPS_NETWORK=code-diali_default,
#    DATABASE_URL_OPS + EXPECTED_DB_* + BACKUP_HOST_DIR + RESTORE_* + RESTORE_MANIFEST.
# 2) Créer les dossiers ops AVANT toute commande ops (preflight refuse un
#    chemin absent) :
mkdir -p /var/backups/code-diali /var/backups/code-diali-restore
chmod 700 /var/backups/code-diali /var/backups/code-diali-restore
# 3) Démarrage — le service one-shot `preflight` s'exécute en PREMIER ;
#    variable runtime manquante = aucun service ne démarre :
docker compose up -d --build
#    Validation LAN uniquement (ports 3111/3112/5433, egress ouvert) :
#    docker compose -f docker-compose.yml -f docker-compose.lan.yml up -d
# 4) Suite ops (explicite — JAMAIS au démarrage) :
./scripts/ops.sh preflight
./scripts/ops.sh migrate
./scripts/ops.sh seed-admin -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=...
./scripts/ops.sh check-gates --first-boot
./scripts/ops.sh backup
# 5) Vérifications :
docker compose ps
curl -fsS http://<IP-du-serveur>:3111/api/health   # mode LAN : 200 + "database ok"
```

- **`OPS_NETWORK` sans Coolify** = réseau par défaut du projet compose
  (`<COMPOSE_PROJECT_NAME>_default`, ici `code-diali_default`) : réseau créé par
  le démarrage runtime, déclaré `external: true` côté jobs ops (ils ne le créent
  ni le renomment) et sur lequel `db` porte déjà l'alias `db` (alias de service
  compose). `COMPOSE_PROJECT_NAME` et `OPS_NETWORK` se dérivent donc l'un de
  l'autre — aucune valeur en dur.
- **HTTPS public (parcours A)** : la stack de production ne publie **aucun**
  port — un reverse proxy devant `web` est à fournir. Alternative déjà
  conditionnée : `docker-compose.proxy.yml` (Caddy, ports 3212/3443) — deux clés
  **obligatoires** dans `deploy/.env` (**config absente = refus compose avec
  message clair**, aucun UUID ni chemin en dur, aucun repli) :
  `PREPROD_NETWORK=<réseau de la stack>` + `PREPROD_PROXY_DIR=<dossier hôte
  proxy>` ; certificat — **le script ne lit pas `deploy/.env`** : transmettre la
  valeur explicitement, depuis `deploy/` :
  `PREPROD_PROXY_DIR="<dossier hôte proxy>" bash ./scripts/gen-preprod-cert.sh <IP-ou-domaine>`
  (**argument obligatoire** — sans argument : usage error, jamais de cible de
  repli ; SAN `IP:`/`DNS:` auto ; sortie `CERT_DIR` ou `$PREPROD_PROXY_DIR/certs`) ;
  la valeur doit être **identique à `PREPROD_PROXY_DIR` de `deploy/.env`**, car
  Compose monte ensuite `$PREPROD_PROXY_DIR/certs` ( `/certs` du proxy)
  (**documenté, non exécuté** en parcours A — cf. tableau d'exécution ci-dessous ;
  commande vérifiée le 22/10 avec un dossier temporaire personnalisé, certificat actif
  non touché : preuve `recette/logs/v5-batteries/cert-env-explicit-20261022.txt`).

### Parcours B — serveur existant avec Coolify → même code → même résultat

Prérequis : Coolify opérationnel (v4), droits de création de projet, accès SSH
au serveur pour les jobs ops. **Aucun composant interne de Coolify n'est modifié
ni étendu** : déploiement = ressource Git officielle ; mise à jour = bouton
**Redeploy** de l'interface ; opérations = `deploy/scripts/ops.sh`. Coolify
reste un détail d'implémentation interne (jamais exposé aux clients finaux).

1. **Créer un projet dédié** dans Coolify (isolation : un projet par instance,
   jamais partagé avec d'autres apps).
2. **Nouvelle ressource → Git** : dépôt, **branche = celle du SHA cible**,
   *Build pack* **Docker Compose**, chemin du fichier : `deploy/docker-compose.yml`
   (Coolify ne charge **que** ce fichier — jamais `docker-compose.ops.yml`,
   ni les overrides LAN/proxy). **Choix de la version** : si l'interface propose un
   champ **« Commit SHA »**, le renseigner sur le SHA cible — **un SHA explicitement
   choisi est acceptable, à condition de correspondre exactement à la version
   demandée** (l'installer/déployer une révision ≠ version livrée n'est **pas** un
   résultat conforme). Le vérifier **avant** de cliquer Déployer (ou le laisser vide
   uniquement si aucun pin résiduel existe, cf. §Limites).
3. **Variables d'environnement de la ressource** : reprendre les valeurs
   runtime de `deploy/.env.example` (PG_*, JWT_SECRET, ENCRYPTION_KEY, URLs,
   TRUST_PROXY). `COMPOSE_PROJECT_NAME` = UUID de la ressource Coolify.
   **Identification des conteneurs par LABELS, jamais par nom** : chaque
   conteneur compose porte `com.docker.compose.project=<UUID>` et
   `com.docker.compose.service=<service>` (filtres `docker ps --filter
   label=…` / `docker inspect --format '{{index .Config.Labels …}}'`) — les
   noms générés (`<prefixe>-…`) ne sont **pas** une convention fiable. Les
   variables **ops**
   (`OPS_NETWORK`, `DATABASE_URL_OPS`, `BACKUP_HOST_DIR`, `RESTORE_*`) ne sont
   lues que par les scripts sur l'hôte → elles se renseignent dans
   `deploy/.env` **côté serveur** (étape 5), après le premier déploiement.
4. **Déployer** (bouton officiel) : le service `preflight` s'exécute en premier
   à chaque déploiement (variable manquante = refus avant tout démarrage).
5. **Après premier déploiement, en SSH** :
   ```bash
   cd <clone>/deploy
   mkdir -p <BACKUP_HOST_DIR> <RESTORE_HOST_DIR> && chmod 700 <BACKUP_HOST_DIR> <RESTORE_HOST_DIR>
   # Identification de db et du projet PAR LABELS (aucune hypothèse de nom) :
   docker ps --filter label=com.docker.compose.service=db \
     --format '{{.Names}} | {{.Label "com.docker.compose.project"}}'
   #   -> <nom-db> | <UUID projet>  => COMPOSE_PROJECT_NAME=<UUID projet>
   docker inspect <nom-db> -f '{{range $k,$v := .NetworkSettings.Networks}}net={{$k}} aliases={{$v.Aliases}}{{"\n"}}{{end}}'
   #   -> retenir le réseau portant l'alias [db] (réseau projet Coolify),
   #      puis OPS_NETWORK=<ce réseau> dans deploy/.env (aucun UUID en dur).
   ./scripts/ops.sh preflight
   ./scripts/ops.sh migrate
   ./scripts/ops.sh seed-admin -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=...
   ./scripts/ops.sh check-gates --first-boot
   ./scripts/ops.sh backup
   ```
   Les jobs tournent dans le conteneur éphémère `ops`
   (`docker compose run --rm --no-deps`, réseau externe `OPS_NETWORK`) — **jamais**
   dans les conteneurs de l'app, **jamais** via l'interface web du panel.
6. **HTTPS direct** (optionnel — utilisé en préproduction) : deux clés
   **obligatoires** dans `deploy/.env` (**config absente = refus compose clair**,
   aucun chemin en dur — chemins proxy/certificats configurables) :
   `PREPROD_NETWORK` (réseau du projet cible, dérivé via ses labels — étape 5)
   et `PREPROD_PROXY_DIR` (dossier hôte proxy). Puis, **depuis `deploy/`, en
   transmettant la valeur (le script ne lit pas `deploy/.env`)** :
   `PREPROD_PROXY_DIR="<dossier hôte proxy>" bash ./scripts/gen-preprod-cert.sh <IP>`
   (**argument obligatoire** ; valeur **identique à `PREPROD_PROXY_DIR` de
   `deploy/.env`** — Compose monte `$PREPROD_PROXY_DIR/certs` dans `/certs` du proxy)
   + `Caddyfile` à `$PREPROD_PROXY_DIR/Caddyfile` (modèle : recette
   `preprod-proxy-Caddyfile.txt`) puis
   `docker compose -f docker-compose.proxy.yml up -d`. Ports : 3212→80, 3443→443
   (certificat auto-signé, empreinte à vérifier côté client).
7. **Mise à jour** : pousser le SHA sur la branche déployée → **dans la ressource
   Git (section *Git Source*), vérifier que le champ « Commit SHA » pointe ce SHA**
   — Coolify conserve un pin **hors dépôt** : un Redeploy reconstruit le SHA
   épinglé, pas le HEAD de branche (constat V5 20/10, **corrigé/validé 21/10**) ;
   corriger si besoin (champ → **Save**) → **re-vérifier après Save que
   « Commit SHA » = version demandée** → bouton **Redeploy** (interface officielle)
   → vérifier `docker compose ps`, `GET /api/health` **et le SHA réellement servi**
   (`docker ps --format '{{.Image}}'` doit afficher `…:<SHA40 cible>`) — un
   Redeploy « Success » sur un SHA ≠ version demandée **ne conclut rien**.

## État d'exécution (21/10/2026) — exécuté vs seulement documenté

| Étape | Parcours A (Ubuntu → Compose) | Parcours B (Coolify → même code) |
|---|---|---|
| Installation Docker + transfert + build images | **Exécuté** — VM de test, GO 11/10 (build api+web, SHA-256 du transfert vérifié) | **Exécuté** — préproduction (chaque déploiement/Redeploy) |
| Migrations (66) + seed admin | **Exécuté** — VM de test, GO 11/10 (`Admin ensured`, login 201) | **Exécuté** — préproduction (initiale + no-ops V4/V5 : 0 migration en attente) |
| `check-gates --first-boot` | **Documenté** (gates **env** par défaut `false` posés par le compose ; script exécuté sur parcours B — états observés : §*Premiers démarrages*) | **Exécuté** — préproduction |
| `ops.sh` complet (`OPS_NETWORK`, GO V5) | **Documenté** — jamais exercé hors Coolify | **Exécuté** — préproduction : preflight à chaque ops, sauvegarde 20/10 (SHA-256 + `pg_restore --list`), **restauration isolée 20/10 `RESTORE_OK`** (59 tables = 59, 66 migrations = 66, base neuve `code_diali_restore`) |
| Validation LAN (override 3111/3112/5433) | **Exécuté** — VM de test | **Applicable** (même fichier ; exécution sur VM de test — accès préproduction via HTTPS Caddy) |
| HTTPS direct | **Documenté, non exécuté** (reverse proxy à fournir) | **Exécuté** — préproduction : Caddy `docker-compose.proxy.yml`, ports 3212/3443, cert auto-signé CN=IP |
| Redeploy via interface officielle | s.o. | **Exécuté** — préproduction GO V3/V4 (Source *API*, déploiements des 16–18/10) ; **V5 20/10 10:27:54Z** (Manual, Success 24m54s) mais **build = `b0c39626…`, ≠ `1200ad4`** (pin « Commit SHA » non aligné → échec ref, §Limites) ; **tentative 21/10 00:16:44Z Cancelled** (pin encore `b0c3962`) puis **V5 finale 21/10 00:17:38Z : Manual, Success 00m58s, build = `1200ad44593…`** (pin aligné) = **Redeploy conforme à la version demandée** |
| Installateur web / commande serveur vierge | **Non développé** (futur, CLAUDE.md §5) | Non pertinent (ressource Git) |
| Copie backup vers stockage externe | **Non testée** (voir limites) | Idem |

## Limites connues de l'installation

- **Pin « Commit SHA » panel-side (constaté V5 20/10, corrigé et validé 21/10)** :
  la ressource Git de Coolify conserve un SHA épinglé indépendamment du dépôt —
  le Redeploy du 20/10 a reconstruit `b0c39626…` alors que le HEAD livré était
  `1200ad4` (**échec de reproductibilité du ref**). **Règle de versionnage** :
  l'épinglage explicite d'un SHA **est acceptable**, mais il **doit correspondre à
  la version demandée** — vérifier/aligner le champ dans l'UI **après Save et avant
  Redeploy**, puis confirmer le SHA réellement servi (étape 7). Le pin vit
  **hors Git** → il appartient à la **procédure versionnée (étape 7)**, jamais à une
  étape de réparation manuelle courante. Preuve : déploiement `0ahbmg0pu…`
  21/10 00:17:38Z = Success sur `1200ad44593…`.

- **Prérequis commerciaux distincts NON validés** : domaine réel, SMTP d'envoi,
  clés Stripe (mode test), activation commerciale. **États de gates réellement
  observés en préproduction le 21/10** (`ops.sh check-gates` = CONFORME RC=0 +
  mesures curl) : `walletPaymentEnabled=true`, `cardOrderPaymentEnabled=false`,
  `cardTopupEnabled=true` (1 avertissement déjà connu), réconciliateur
  `enabled=false` (env) — `payment-methods` = `[]`, `simulate-payment` = 400.
  Validation commerciale séparée (docs/GUIDE-STRIPE-TEST.md,
  docs/CHECKLIST-PRODUCTION.md) — jamais présentée comme « tout OFF ».
- **Production non autorisée** par ce lot (CLAUDE.md §Rappel : déploiement réel
  de la plateforme en fin de projet, VPS dédié séparé des apps clients, base
  neuve).
- **Sauvegarde** : persistance sur hôte prouvée ; **copie vers stockage externe
  (autre machine, objet, bande) = non testée** — à planifier.
- **Restauration** = contrôle technique (compteurs de tables) uniquement ;
  rapprochement financier (paiements/remboursements/portefeuille/effets
  provider) avant réouverture = **procédure manuelle obligatoire**.
- **Validation LAN** : egress **ouvert** (aucune isolation réseau) — la preuve
  de non-appel provider exige le mode `docker-compose.lan-internal.yml`.
- **Certificat auto-signé** (parcours B, préproduction) : import manuel dans le
  magasin de confiance ; empreinte SHA-256 à conserver pour vérification.
- **`NEXT_PUBLIC_API_URL` est figée au build** du service web : tout changement
  exige un rebuild (arrêt → reconstruction → démarrage).
- **Aucun secret** dans le dépôt, les images ni les journaux ; `.env` hors Git
  (mode 0600) ; jetons/identifiants = interface officielle du panel uniquement.

## Séquencement (décision explicite du GO 11/10/2026)

1. **Premier déploiement contrôlé et documenté** (ce dossier) : VPS dédié, projet
   Coolify isolé, base neuve, migration protégée, admin seed explicite, gates
   env par défaut + contrôle `check-gates` explicite.
2. **Installateur web** et **commande d'installation sur serveur vierge** : features
   **futures** (CLAUDE.md §5 / §Rappel) — **ne sont PAS nécessaires** pour valider ce
   premier parcours et ne sont **pas développés** dans ce lot.

## Production par défaut : aucun port publié

`docker-compose.yml` **seul** = configuration **production** : aucun `ports:`
(ni PostgreSQL, ni API, ni Web). Coolify est l'autorité unique reverse
proxy/HTTPS (projet isolé) et publie via ses propres routes. Coolify ne charge
**que** ce fichier : `docker-compose.ops.yml` (gardes `${VAR:?}` strictes) et
les overrides LAN ne sont **jamais** lus lors d'un déploiement Coolify.

**Validation LAN uniquement** (VM de test) : charger l'override dédié —

```bash
docker compose -f docker-compose.yml -f docker-compose.lan.yml up -d
```

L'override publie API `3111`, Web `3112`, PG `5433` pour la **consultation
depuis l'hôte**. **HONNÊTETÉ RÉSEAU** : cette override **ne fournit AUCUNE
isolation réseau** — les conteneurs ont une route Internet sortante normale.
Un réseau `internal: true` bloquerait l'egress, mais avec Docker 29 il
**supprime aussi la publication des ports** (impossible de combiner
consultation LAN et isolation dans la même stack). Deux modes explicites :

| Mode | Fichier(s) | Ports | Egress | Usage |
|---|---|---|---|---|
| **LAN consultation** | `docker-compose.yml` + `lan.yml` | 3111/3112/5433 | **OUVERT** (pas d'isolation) | Validation UI, tests fonctionnels |
| **Isolation egress** | `docker-compose.yml` + `lan-internal.yml` | **aucun** | **BLOQUÉ** (`internal: true`) | Campagnes de test blocage provider |

La preuve réseau de non-appel provider exige le **mode isolation** (ou une
topologie dédiée) — des flags OFF seuls ne sont **pas** une telle preuve.
Les appels **réels** Stripe/panel/DNS/SMTP ne sont jamais exercés (interdits GO).

**Pas de seconde installation systemd/PM2** : Coolify gère le redémarrage des
conteneurs. Aucune unité systemd ni process PM2 n'est fourni ni requis.

## Variables : build vs runtime

| Variable | Moment | Portée | Secret ? |
|---|---|---|---|
| `API_UPSTREAM` (web) | **build** (figé dans routes-manifest) | conteneur web → API (`http://api:3001`) | non (URL interne) |
| `NEXT_PUBLIC_API_URL` | **build uniquement** (inlinée bundle Next) | navigateur → API | non (URL publique) |
| `PUBLIC_API_BASE` | runtime (API) | pages de paiement hébergées | non |
| `PUBLIC_BASE_URL`, `WEB_ORIGIN` | runtime (API) | liens/CORS | non |
| `TRUST_PROXY` | runtime (API) | confiance X-Forwarded-For (derrière Coolify : `uniquelocal`) | non |
| `DATABASE_URL` | runtime | API → PostgreSQL | **oui** (mot de passe) |
| `JWT_SECRET`, `ENCRYPTION_KEY` | runtime | API | **oui** |
| `PG_USER`/`PG_PASSWORD`/`PG_DB` | runtime | compose → PostgreSQL | mot de passe = **oui** |

**`NEXT_PUBLIC_API_URL` n'est PAS modifiable au runtime** : elle est inlinée au
build dans le bundle navigateur ; tout changement exige un **rebuild** du
service web (arrêt → reconstruction → redémarrage). Ne jamais la présenter
comme un réglage runtime.

`localhost` **n'existe pas entre conteneurs** : `API_UPSTREAM` doit être le
nom de service compose (`http://api:3001`).

Aucun secret dans les images, arguments de build, dépôt ou journaux : voir
`deploy/.env.example`. Copier vers `deploy/.env` (mode `0600`) hors Git, ou
injecter via Coolify.

## Contrôles préalables — exécution réelle, pas déclarative (GO V4)

Deux garde-fous, deux chemins d'exécution **démontrés** (tests V4) :

| Quand | Mécanisme | Refus |
|---|---|---|
| Tout démarrage / redéploiement (`docker compose up`, y compris **déploiement Coolify officiel**) | service one-shot `preflight` du `docker-compose.yml` : `db` en dépend (`service_completed_successfully`), `api` de `db`, `web` de `api` — il reçoit les **mêmes** `${VAR:-}` interpolés que les services | variable runtime manquante ou vide = exit 1 = `docker compose up` échoue = **aucun service ne démarre** (stack existante laissée en l'état) |
| Chaque commande ops (`scripts/ops.sh`) | `preflight.sh --ops` exécuté **avant** tout `docker compose run` | vars ops/restauration manquantes ou chemins hôte invalides = refus = **aucun conteneur lancé, aucune écriture, aucune base touchée** |

- **Runtime exigé** : `PG_USER`, `PG_PASSWORD`, `PG_DB`, `JWT_SECRET`,
  `ENCRYPTION_KEY`, `PUBLIC_BASE_URL`, `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL`.
- **`--ops` exige en plus** (toute la suite ops est refusée si incomplète) :
  `DATABASE_URL_OPS`, `EXPECTED_DB_HOST`, `EXPECTED_DB_NAME`, `BACKUP_HOST_DIR`,
  `DATABASE_URL_RESTORE`, `EXPECTED_DB_NAME_RESTORE`, `RESTORE_HOST_DIR`,
  `RESTORE_MANIFEST`, **plus la validité des chemins hôte**
  `BACKUP_HOST_DIR` / `RESTORE_HOST_DIR` : absolu, **existant**, répertoire,
  ni `/` ni `/nonexistent` — les créer d'abord
  (`mkdir -p ... && chmod 700 ...`). docker **ne crée jamais** de dossier
  parasite (aucun `${VAR:-/nonexistent}` dans les fichiers compose).
- **Source des valeurs** : environnement du processus, sinon `deploy/.env`
  (chargé explicitement par `preflight.sh`, mêmes règles que docker compose :
  l'env gagne ; doublons dans le fichier = **dernière ligne** ; une variable
  **définie mais vide** reste un échec — aucun repli silencieux).
- **Codes retour** : `0` conforme, `1` configuration invalide (aucune opération
  exécutée), `2` usage invalide.
- **`scripts/ops.sh`** est la commande officielle des jobs : exige
  `COMPOSE_PROJECT_NAME` (projet cible : UUID Coolify en preprod,
  `code-diali` en local — **jamais deviné**), charge le compose ops avec les
  gardes `${VAR:?}`, accepte `OPS_EXTRA_COMPOSE_FILES` (fichiers compose
  supplémentaires, ex. pins d'images d'un arbre préprod).

```bash
./scripts/ops.sh preflight      # readiness complète de la suite ops, sans rien lancer
```

## Premiers démarrages (gates par défaut + états observés — GO §5)

Le compose pose d'emblée (ancre `x-api-env`, **partagée avec check-gates**) :
`PAYMENT_SIMULATOR_ENABLED=false`, `HOSTING_C2/C3/C4_ENABLED=false`,
`ORDER_SWEEP_ENABLED=false`, `RENEWAL_SWEEP_ENABLED=false`,
`RECONCILE_ENABLED=false`.

Les gates **paiement** vivent en **base** (`PaymentSettings`) : au premier
démarrage, la **recharge carte doit être désactivée explicitement** (défaut
schéma `cardTopupEnabled=true`). Les **deux** gates carte sont contrôlées
(`cardTopupEnabled` **et** `cardOrderPaymentEnabled`), de même que les
**overrides DB du réconciliateur** (`ReconcileSetting`, singleton, priorité
DB → env → défauts, identique au code).

**États observés en préproduction (21/10, valeurs réelles — pas un simple
« OFF » générique)** : `walletPaymentEnabled=true`, `cardOrderPaymentEnabled=false`,
`cardTopupEnabled=true` (avertissement connu), réconciliateur `enabled=false`
— source : `ops.sh check-gates` **CONFORME RC=0** (journal
`recette/logs/v5-batteries/…`/`v6-final`) + mesures curl
(`payment-methods=[]`, `simulate-payment=400`).

```bash
./scripts/ops.sh check-gates                    # contrôle courant
./scripts/ops.sh check-gates --first-boot       # premier démarrage
```

**Honnêteté du contrôle** : le checker lit **son** environnement de processus
— dans cette stack, l'ancre `x-api-env` rend l'env du checker
**constructuellement identique** à celui du service `api` (même YAML). Une
divergence d'env introduite hors de ce partagement n'est pas détectable par le
script (limite documentée). Toute **lecture base impossible = exit 2** (jamais
conforme).

## Migration (jamais au démarrage)

```bash
./scripts/ops.sh migrate
```

Le script exige `DATABASE_URL_OPS` + `EXPECTED_DB_HOST/PORT/NAME`, vérifie
l'identité SQL (base + hôte résolu + port), prend une sauvegarde préalable
vérifiée si tables présentes, puis `prisma migrate deploy`.

**Honnêteté (« même connexion »)** : le contrôle d'identité ouvre sa **propre**
connexion Prisma puis se déconnecte ; la migration et pg_dump ouvrent d'autres
connexions (pools). La garantie est la **cohérence de la cible configurée**
(mêmes URL/attendus), **pas** une session unique ; les refus couvrent
base/hôte/port inattendus. Limite documentée, jamais présentée comme verrou.

## Admin initial (seed ADR-017)

```bash
./scripts/ops.sh seed-admin -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=...
```

Le seed est **idempotent** : crée l'ADMIN si absent ; sinon le **promeut**
(ADMIN + actif) sans jamais réinitialiser le mot de passe. Effet secondaire
connu : `name` écrasé en « Platform Admin ». Aucune fixture importée.

## Sauvegarde (job ops dédié, destination persistante)

```bash
./scripts/ops.sh backup
```

- Job `backup` **explicite** (profil `ops`) : monte `BACKUP_HOST_DIR` (hôte) en
  `/backups` **et** les volumes `cdiali-storage`/`cdiali-branding` (avec
  `REQUIRE_VOLUME_MOUNTS=1` : un volume absent/non monté = **erreur**, jamais
  une « sauvegarde complète » ; dossiers **présents et vides** = cas normal).
- **Persistance** : les dumps survivent à la suppression du conteneur
  éphémère du job (destination = dossier hôte monté). **Démontré** dans les
  tests du GO V2 (rm du conteneur, dumps toujours là).
- `umask 077` **avant toute écriture** (dumps pré-migration/pré-restauration
  inclus) + re-`chmod 600` vérifié (aucun échec de permission masqué).
- Noms uniques `<ts>-<pid>` : aucun écrasement, aucune collision.
- Sortie : `db-<ts>.dump` (+ `files-<ts>.tar.gz` si fichiers) +
  **`SHA256SUMS-<ts>.txt` = manifeste à basenames**, utilisable **directement**
  par `restore.sh`.
- Inclus : base (`pg_dump -Fc` + `pg_restore --list`) **et** fichiers
  persistants (`storage/`, `public/branding/` — chemins **relatifs** dans
  l'archive).
- Conversion Prisma → outils PG **explicite** (`pg-conn.sh`) : seules les
  options Prisma connues sont retirées ; options libpq préservées ; option
  inconnue = **refus** (jamais de modification silencieuse de la connexion) ;
  l'URL complète n'est jamais affichée.

**⚠️ Honnêteté stockage** : `BACKUP_HOST_DIR` sur l'hôte d'une VM locale =
**hors conteneur mais PAS hors VPS**. La **copie vers un stockage externe**
(autre machine, objet, bande) est une étape **séparée**, **NON TESTÉE** dans ce
lot — à planifier (checklist production, catégorie infrastructure réelle).

## Restauration (job ops isolé, bornée)

### Commande canonique

La commande ci-dessous est **utilisable telle quelle** — aucune URL ni secret
dans les arguments visibles (URL via env, `ENV` = repli sur `DATABASE_URL`) :

```bash
# 1. Préparer le dossier source (RESTORE_HOST_DIR) sur l'hôte :
#    - db-XXX.dump         (dump pg_dump -Fc)
#    - files-XXX.tar.gz    (archive fichiers, optionnelle)
#    - SHA256SUMS-XXX.txt  (manifeste à basenames, produit par backup.sh)
#    - target/             (sous-dossier VIDE — destination des fichiers)
#
# 2. Exécuter (URL cible = DATABASE_URL_RESTORE via env, jamais en argument) :
RESTORE_MANIFEST=/restore/SHA256SUMS-XXX.txt \
./scripts/ops.sh restore \
  /restore/db-XXX.dump ENV /restore/files-XXX.tar.gz /restore-out/target
```

**Anatomie de la commande** :

| Argument | Rôle |
|---|---|
| `RESTORE_MANIFEST=...` | Env obligatoire — transmis au conteneur, chemin vers le manifeste SHA-256 |
| `/restore/db-XXX.dump` | 1er arg : dump source (monté en `:ro` via `RESTORE_HOST_DIR`) |
| `ENV` | 2e arg : `ENV` = utiliser `DATABASE_URL` de l'environnement (`DATABASE_URL_RESTORE` injecté par le job) — le secret n'apparaît jamais dans les arguments |
| `/restore/files-XXX.tar.gz` | 3e arg : archive fichiers (ou `-` pour base seule) |
| `/restore-out/target` | 4e arg : destination dédiée des fichiers restaurés (mount `:rw`, persistante) |

> **Note** : le placeholder `ENV` (et non `-`) est requis car `docker compose run`
> interprète `-` comme un flag et ne le transmet pas au conteneur.

> **Garde-fou (GO V4)** : `ops.sh` exécute `preflight.sh --ops` **avant**
> `docker compose` (vars restauration + existence de `RESTORE_HOST_DIR`) ;
> `restore.sh` recontrôle lui-même manifeste, cible et base vierge **avant
> toute écriture**. Refus = code retour, sans conteneur et sans effet.

### Garanties du job

- Le job **ne monte PAS les volumes de l'app courante** : les fichiers vont
  dans `RESTORE_HOST_DIR` monté en `/restore` (lecture seule) et `/restore-out`
  (écriture) — impossibilité structurelle d'écraser l'app live. La recopie
  vers les volumes = procédure **manuelle** documentée (hors du script).
- **Persistance** : dumps pré-restauration (`/restore-out/pre-restore-*.dump`)
  et fichiers restaurés (`/restore-out/target/`) **survivent** à la suppression
  du conteneur éphémère (`--rm`) — ils restent sur l'hôte via le bind mount.
- **Base cible** : `DATABASE_URL_RESTORE` + `EXPECTED_DB_NAME_RESTORE` — base
  **neuve** exigée (exit 3 sinon, aucune suppression).
- **Manifeste strict** (`RESTORE_MANIFEST` obligatoire) : chaque fichier fourni
  doit y avoir sa ligne d'empreinte **exacte** ; empreinte manquante ou
  incorrecte = **refus avant toute écriture DB** ; aucune recherche d'autres
  copies, aucun `--ignore-missing`, aucun glob `SHA256SUMS-*`.
- **Archive bornée — TOUS les contrôles avant toute écriture DB** :
  - Lisibilité gzip (`tar -tzf`) — code retour capturé explicitement ;
  - Types d'entrées : **fichiers réguliers et répertoires seuls** — liens
    symboliques, liens physiques, fichiers spéciaux = **refus** ;
  - Chemins relatifs uniquement, préfixes `storage/` et `public/branding/` ;
  - Entrée absolue ou `..` = refus ;
  - Destination déjà occupée = refus (exit 7).
- **Contrôle technique final** (compteurs de tables) = **contrôle technique**,
  **PAS** un rapprochement financier : le rapprochement paiements/
  remboursements/portefeuille/effets provider avant réouverture reste une
  **procédure manuelle obligatoire** (plan §4).

## Permissions

Les scripts imposent `umask 077` dès leur démarrage (avant toute écriture) et
re-vérifient le mode `0600` des artefacts ; un échec de permission n'est jamais
masqué (`|| true` absent sur les chmod critiques).

## Mise à jour (arrêt → reconstruction → démarrage)

**Parcours B (Coolify)** : pousser le SHA sur la branche déployée, puis bouton
**Redeploy** de l'interface officielle — le service `preflight` s'exécute à
chaque déploiement ; **jamais** de recréation manuelle de conteneur, **jamais**
de commande Docker « à la main » sur les services du panel, **jamais** de
retouche de conteneur existant.

**Parcours A (compose direct)** : séquence arrêt → reconstruction → démarrage :

1. `docker compose stop api web`
2. `docker compose build api web` (depuis l'arbre du SHA autorisé)
3. `docker compose up -d` (+ override LAN le cas échéant) — le service
   `preflight` s'exécute **avant** db/api/web : une variable runtime manquante
   bloque la mise jour **avant** toute recréation de conteneur (exit 1,
   message listant les manques).
4. Vérifier : `docker compose ps`, `GET /api/health` (200 + `database ok`)

Après toute mise à jour contenant des migrations : `./scripts/ops.sh migrate`
(explicitement — jamais au démarrage), puis `./scripts/ops.sh backup`.

**Jamais** de `git checkout`/rebuild dans le répertoire d'un service actif.
**Retour arrière applicatif** = image du SHA précédent (sans restauration de
données) ; la **restauration de données** est distincte, réservée à une
corruption avérée.

## Version des jobs ops — reconstruction explicite (finition V5, 21/10)

**Problème réglé** : `docker compose run` réutilise une image déjà présente —
après une mise à jour de clone, un job pourrait donc exécuter les **scripts
d'une version antérieure** (image périmée).

**Mécanisme livré (simple et documenté)** : `scripts/ops.sh` exécute désormais
**`docker compose run --rm --build --no-deps`** — l'image du job est
(re)construite depuis **l'arbre courant du clone** avant chaque job, et la
commande affiche `version=<SHA git court>` de cet arbre :

- les scripts embarqués (`/opt/code-diali/scripts`, `COPY deploy/scripts` de
  `api.Dockerfile`) correspondent **toujours à la version choisie**, même après
  `git checkout <SHA>`/mise à jour du clone — **aucune étape manuelle** ;
- reconstruction **maîtrisée** : BuildKit (couche intacte si rien n'a changé =
  coût nul ; script modifié = couche reconstruite), bornée à **l'image du
  job** : `--no-deps` ne lance que le conteneur éphémère — **aucun service
  db/api/web/preflight ni réseau créé, recréé ni redémarré** ;
- les images applicatives (runtime `api`/`web`) restent du ressort de
  l'orchestrateur (parcours B : build Coolify du SHA épinglé, étape 7) — ce
  mécanisme ne concerne que les **jobs ops**.

**Preuve ciblée exécutée (21/10, VM préprod, clone = `1200ad4`, sans recréer
aucun service)** — `recette/logs/v5-batteries/version-jobs-proof-20261021.txt` :

- digest SHA-256 des **11 scripts embarqués** dans l'image reconstruite
  (`run --build … --entrypoint bash … sha256sum`) = digest des **11 sources**
  du clone → `DIGEST_IDENTIQUE_OK` ;
- snapshots `docker ps -a` AVANT → APRÈS : `PS_DIFF_VIDE_OK` (11 conteneurs
  inchangés) ; réseaux projet **et** `_default` inchangés ;
- image job reconstruite (`…-migrate` : `89fefa500ce6` → `46104d8dc825`,
  tous les couches CACHED = coût quasi nul) ; services live toujours
  `Up 4 hours (healthy)` après la preuve ;
- `docker compose v5.6.0` : flag `--build` supporté (vérifié `run --help`).

## Validation Docker, intégration Coolify, production

Cette stack prouve le packaging, les migrations protégées, la persistance et la
sauvegarde/restauration **isolée**. L'intégration Coolify est **réalisée et
démontrée sur la préproduction** (déploiement officiel sans retouche manuelle,
garde `preflight` exécutée à chaque déploiement — preuves GO V3/V4 : HTTPS,
health, gates mesurés (valeurs observées §*Limites connues*). Le reverse
proxy/TLS côté préproduction = proxy Caddy
dédié de la recette (jamais ce fichier). **Production non autorisée** par ce
lot : le déploiement réel de la plateforme suit la checklist de production
(catégorie infrastructure réelle, CLAUDE.md §Rappel).

## Commandes de référence (depuis `deploy/`)

`ops.sh` exige `COMPOSE_PROJECT_NAME` (env ou `.env`) — projet cible. Chaque
commande ops exécute d'abord `preflight.sh` (refus = exit 1, sans conteneur).

| Action | Commande |
|---|---|
| Démarrer (LAN) | `docker compose -f docker-compose.yml -f docker-compose.lan.yml up -d` |
| Démarrer (prod) | `docker compose up -d` (aucun port publié ; `preflight` exécuté en premier) |
| Démarrer (isolation egress) | `docker compose -f docker-compose.yml -f docker-compose.lan-internal.yml up -d` (aucun port, egress bloqué) |
| État | `docker compose ps` |
| Arrêter | `docker compose down` (**sans** `-v`) |
| Préflight (suite ops) | `./scripts/ops.sh preflight` |
| Migrer | `./scripts/ops.sh migrate` |
| Seed admin | `./scripts/ops.sh seed-admin -e ADMIN_EMAIL=.. -e ADMIN_PASSWORD=..` |
| Gates | `./scripts/ops.sh check-gates --first-boot` |
| Sauvegarder | `./scripts/ops.sh backup` |
| Restaurer | `RESTORE_MANIFEST=/restore/SHA256SUMS-XXX.txt ./scripts/ops.sh restore /restore/db-XXX.dump ENV /restore/files-XXX.tar.gz /restore-out/target` |
| Certificat proxy HTTPS | `PREPROD_PROXY_DIR="<dossier hôte proxy>" bash ./scripts/gen-preprod-cert.sh <IP-ou-domaine>` (depuis `deploy/` ; **le script ne lit pas `deploy/.env`** — valeur identique à celle de `deploy/.env`, que Compose monte en `$PREPROD_PROXY_DIR/certs` ; argument obligatoire ; `CERT_DIR` ou `$PREPROD_PROXY_DIR/certs`) |
| Proxy HTTPS direct | `docker compose -f docker-compose.proxy.yml up -d` (exige `PREPROD_NETWORK` + `PREPROD_PROXY_DIR` dans `deploy/.env`) |
