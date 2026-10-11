# DOSSIER D'INCIDENT — Migrations appliquées par erreur sur `icode_host_pro`

> **Statut :** incident **déclaré** et documenté. Une inversion SQL est déclarée
> avoir été exécutée le 11/10 (chronologie §3). Aucune écriture supplémentaire
> n'a été effectuée sur `icode_host_pro` à l'issue de ce dossier. Le retour
> arrière n'efface pas l'incident : chaque affirmation y est distinguée en
> **démontrée** (preuve conservée) / **déclarée** (fait allégué, sans journal
> complet conservé) / **non vérifiable** (fait impossible à certifier a
> posteriori). La garde ajoutée (§6) protège **les chemins de migration qui
> l'appellent** ; ce n'est **pas** un verrou contre toute commande Prisma
> lancée manuellement hors de ces scripts.

## 1. Contexte

La plateforme (branche `feat/stripe-test`, travail GO) exécutait ses migrations
via `prisma migrate deploy`. Le déploiement des migrations du lot Stripe se
fait **uniquement** sur des bases isolées de recette/e2e. La base de
développement `icode_host_pro` (celle du `.env` local, servie par le conteneur
`icode-host-postgres` / `icode-postgres`) n'est **jamais** une cible de
migration pendant ces chantiers.

Lors d'une séance de travail, un `prisma migrate deploy` a été lancé **sans
`DATABASE_URL` en override** : Prisma a alors lu le `.env` local, dont
`DATABASE_URL` pointe sur `icode_host_pro`. Les migrations du lot ont donc été
appliquées sur la mauvaise base.

## 2. Migrations concernées (6)

Ordre d'application tel que retrouvé dans `_prisma_migrations` :

| # | Migration | Nature |
|---|-----------|--------|
| 1 | `20261007000001_stripe_card_payments` | tables `PaymentProviderSetting`, `CardPayment`, `PaymentWebhookEvent` ; enums ; colonnes `Customer.walletCurrency`, `Refund.cardPaymentId`, `WalletTransaction.disputedAt` |
| 2 | `20261007000002_refund_card_payment_index` | index unique `Refund_cardPaymentId_key` |
| 3 | `20261007000003_go_p1_p8_corrections` | colonnes `providerCallState`, `dispatchedAt`, `pendingRefundCents`, `reconcileAt`, `reconciledAt`, index associés |
| 4 | `20261008000001_payment_settings_order_card` | table `PaymentSettings`, colonne `CardPayment.orderId`, index |
| 5 | `20261010000001_refund_observation_union` | table `RefundObservation` |
| 6 | `20261011000001_dispatch_identity` | colonnes `dispatchOwner`, `dispatchClaimedAt` sur `CardPayment` et `Refund` ; colonnes `merchantAccount`, `sourceSettingId`, `sourceConfigVersion` sur `PaymentWebhookEvent` |

Toutes ces migrations sont **additives** (aucune modification destructive de
données préexistantes).

## 3. Chronologie et commandes réelles

| Quand | Quoi | Commentaire |
|-------|------|-------------|
| ~11/10, matin | `prisma migrate deploy` lancé sans override `DATABASE_URL` | **erreur** : lit le `.env` → base `icode_host_pro`. Les 6 migrations sont appliquées (déclaré). |
| 11/10, ~04:19 | Contrôle de l'état déclaré exécuté : `check-dev-db.sql` (compte `CardPayment`, `PaymentWebhookEvent`, `PaymentProviderSetting`, `RefundObservation`, `PaymentSettings`, `Refund`, `_prisma_migrations`) | **script** (requêtes `COUNT`) : à lui seul il ne prouve **pas** son résultat d'exécution. Le résultat allégué (tables créées vides, `Refund` vide, 0 `orderId` NULL) est **déclaré** — le script est conservé **sans sa sortie**. |
| 11/10, ~04:20 | **Inversion SQL** déclarée exécutée : `revert-dev-db.sql` via `psql` avec `ON_ERROR_STOP=1` | ordre inverse d'application : drop colonnes (identité, reconcile, orderId, providerCallState…), drop tables (`RefundObservation`, `PaymentSettings`, `PaymentWebhookEvent`, `CardPayment`, `PaymentProviderSetting`), restauration `Refund.orderId NOT NULL`, drop des enums, purge des 6 lignes `_prisma_migrations`. |
| 11/10, après | Vérification résiduelle **déclarée** : 60 migrations restantes dans `_prisma_migrations`, zéro artefact du lot résiduel | ce relevé est **déclaré** ; sans instantané antérieur (§4), on ne peut **pas** certifier un état strictement identique à l'état d'avant le deploy erroné. |
| 11/10, après | Déploiement **correct** de `20261011000001_dispatch_identity` sur `icode_host_pro_socle` et `icode_host_pro_recette` uniquement (override `DATABASE_URL` explicite) | les bases isolées cibles sont bien à jour. |

**Note sur la date :** le fichier `revert-dev-db.sql` porte un en-tête
« incident 12/10 ». Les horodatages des fichiers de contrôle
(`check-dev-db.sql` 04:19, `revert-dev-db.sql` 04:20) placent l'inversion le
**11/10** tôt le matin ; l'application erronée l'a précédée dans la même
séance. La mention « 12/10 » de l'en-tête est une coquille de saisie, sans
incidence sur les faits : le jour exact de l'application erronée n'est pas
fiablement reconstituable au-delà de « avant le contrôle du 11/10 04:19 ».

## 4. État de la base après inversion

- **Scripts conservés** (`check-dev-db.sql`, `revert-dev-db.sql`) : ce sont des
  **scripts** (requêtes `COUNT` / commandes SQL). À eux seuls, ils ne prouvent
  **pas** leurs résultats d'exécution — aucune sortie horodatée n'est conservée
  à côté d'eux dans ce dossier.

- **Déclaré** (exécutions alléguées, sans journal complet conservé) :
  - le contrôle `check-dev-db.sql` aurait relevé les tables/colonnes du lot
    **vides** (aucune ligne inscrite, `Refund` vide, 0 `orderId` NULL) ;
  - l'inversion `revert-dev-db.sql` aurait retiré chaque artefact (colonnes,
    tables, index, enums) et purgé les 6 entrées `_prisma_migrations` ;
  - la vérification résiduelle déclarée est « 60 migrations, zéro artefact du
    lot », cohérente avec l'état antérieur au deploy erroné ;
  - le moment exact du `prisma migrate deploy` fautif (avant 04:19 du 11/10,
    dans la même séance de travail) ;
  - l'absence de contrainte violée pendant l'application (les migrations sont
    additives et les tables déclarées vides, donc aucun rejet n'était attendu —
    mais le journal complet de Prisma n'a pas été conservé).

- **Non vérifiable faute d'état antérieur** :
  - un instantané de `icode_host_pro` **avant** le deploy erroné n'a pas été
    pris ; on ne peut donc pas priser a posteriori, ligne à ligne, que
    l'inversion a rendu un état **strictement** identique (seuls les objets
    du lot et le compteur `_prisma_migrations` sont concernés par la déclaration
    de vérification) ;
  - le contenu exact du `_prisma_migrations` avant l'incident (hors 6 lignes
    purgées) n'a pas été sauvegardé séparément.

## 5. Impact métier (limité aux preuves disponibles)

Les 6 migrations sont **additives** (aucune modification destructive de données
préexistantes — démontré par le contenu des scripts de migration). Les
tables/colonnes créées sur `icode_host_pro` sont **déclarées** avoir été
vides (aucune ligne inscrite, `Refund` vide, 0 `orderId` NULL) — résultat
**déclaré** du contrôle `check-dev-db.sql`, dont la sortie n'est **pas**
conservée de façon indépendante (§3, §4). L'inversion est **déclarée** avoir
retiré chaque artefact sans perte de données déclarée.

Ce qui **n'est pas** certifiable ici :
- l'état de `icode_host_pro` **avant** le deploy erroné (aucun instantané
  pris) : on ne peut donc pas prouver, ligne à ligne, que la base est revenue
  à un état strictement identique ;
- l'impact sur des données **hors** objets du lot (non inspectées).

Les bases de production (clients hébergés) sont sur des serveurs distincts et
ne font pas partie du périmètre de cet incident **local** (constat
d'architecture, pas un résultat de contrôle exécuté sur ces bases).

## 6. Garde ajoutée — périmètre limité (GO V5 §3)

Deux garde ont été ajoutées **dans les scripts de migration de recette**
(`recette/db-url.ps1` et `recette/db-guard.mjs`). **Périmètre :** elles
protègent **les chemins de migration qui les appellent** ; elles ne sont **pas**
un verrou contre toute commande Prisma lancée manuellement (un
`prisma migrate deploy` lancé à la main, sans passer par ces scripts, n'est
pas intercepté par cette garde).

1. **Liste blanche des bases isolées** : seules `icode_host_pro_socle`,
   `icode_host_pro_recette`, `icode_host_pro_c3premig`, `icode_host_pro_c4premig`
   et `icode_host_pro_c4test` sont acceptées comme cible. `icode_host_pro`
   (base dev) en est **exclue par construction** : toute tentative de
   construction d'URL ou de garde vers cette base échoue avant toute
   connexion.
2. **Aucun repli implicite sur le `.env`** : le mode « base attendue » de
   `db-guard.mjs` exige une `DATABASE_URL` positionnée par l'appelant ; si
   elle est absente, la garde refuse (exit 1) au lieu de lire le `.env`.
   `db-url.ps1` exige également une URL d'entrée explicite.

### Tests de refus exécutés (sans migration)

| Test | Commande | Résultat |
|------|----------|----------|
| Garde refuse la base dev | `node recette/db-guard.mjs icode_host_pro` | **exit 1** — message « hors liste blanche des bases isolées » |
| Construction d'URL refuse la base dev | `Get-TargetDbUrl <url> 'icode_host_pro'` | **exception** — « Base cible REFUSEE par la liste blanche » |
| Garde refuse sans `DATABASE_URL` (pas de repli .env) | `node recette/db-guard.mjs icode_host_pro_recette` (URL unset) | **exit 1** — « aucun repli sur le .env » |
| Garde accepte une base isolée avec URL explicite | `node recette/db-guard.mjs icode_host_pro_recette` (URL pointant sur la recette) | **exit 0** — `current_database()=icode_host_pro_recette` |

Aucune migration n'a été exécutée lors de ces tests : ils ne font que
**constater le refus** avant toute opération.

## 7. Leçons

- Une migration **ne doit jamais** reposer sur la présence (ou l'absence) d'un
  `DATABASE_URL` hérité du `.env` : la cible doit être **décidée à
  l'appelation**, pas déduite de l'environnement.
- Une base de développement partagée par l'API locale n'est pas une base de
  recette : elle vit dans le même conteneur Postgres, mais ses données sont
  celles du dev, pas des tests isolés. La confusion est coûteuse (inversion
  manuelle) même lorsque l'impact déclaré est faible et non certifiable ligne
  à ligne.
- Documenter un incident **avant** de le « réparer » (ou au plus vite) évite
  de devoir reconstituer a posteriori des faits non vérifiables (instantané
  manquant).
