# Code Diali — déploiement (parcours VPS dédié + projet Coolify isolé)

Ce dossier contient le **packaging de premier déploiement** : images, orchestration,
migrations protégées, sauvegarde/restauration et contrôles de démarrage.

## Séquencement (décision explicite du GO 11/10/2026)

1. **Premier déploiement contrôlé et documenté** (ce dossier) : VPS dédié, projet
   Coolify isolé, base neuve, migration protégée, admin seed explicite, gates OFF.
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

## Premiers démarrages (gates OFF — GO §5)

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
  `/backups` **et** les volumes `cdiali_storage`/`cdiali_branding` (avec
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

1. `docker compose stop api web`
2. `docker compose build api web` (depuis l'arbre du SHA autorisé)
3. `docker compose up -d` (+ override LAN le cas échéant) — le service
   `preflight` s'exécute **avant** db/api/web : une variable runtime manquante
   bloque la mise à jour **avant** toute recréation de conteneur (exit 1,
   message listant les manques).
4. Vérifier : `docker compose ps`, `GET /api/health` (200 + `database ok`)

**Jamais** de `git checkout`/rebuild dans le répertoire d'un service actif.
**Retour arrière applicatif** = image du SHA précédent (sans restauration de
données) ; la **restauration de données** est distincte, réservée à une
corruption avérée.

## Validation Docker, intégration Coolify, production

Cette stack prouve le packaging, les migrations protégées, la persistance et la
sauvegarde/restauration **isolée**. L'intégration Coolify est **réalisée et
démontrée sur la préproduction** (déploiement officiel sans retouche manuelle,
garde `preflight` exécutée à chaque déploiement — preuves GO V3/V4 : HTTPS,
health, gates OFF). Le reverse proxy/TLS côté préproduction = proxy Caddy
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
