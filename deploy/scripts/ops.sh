#!/usr/bin/env bash
# Code Diali — commandes ops OFFICIELLES (GO V4, durci GO V5).
#
# CHEMIN OPS NON RÉCONCILIANT (GO V5 §2) — garanties structurelles :
# 1. TOUJOURS `docker compose run --no-deps` : compose ne crée, ne recrée ni
#    ne redémarre JAMAIS les conteneurs gérés par le panel/db/api/web/
#    preflight — l'incident N2 (recréation db/preflight par réconciliation de
#    labels) est impossible par construction, quel que soit le propriétaire
#    des conteneurs live (Coolify ou ops).
# 2. Réseau EXTERNE unique `OPS_NETWORK` (docker-compose.ops.yml) : le
#    conteneur ops rejoint le réseau OÙ VIT db réellement ; compose ne crée
#    ni ne valide aucun réseau (external: true) — pas de bascule de projet.
# 3. Vérification LIVE lecture seule AVANT compose (scripts/ops-live-check.sh)
#    : projet, réseau, volumes et identité db vérifiés — refus avant mutation
#    si absents/ambigus/incompatibles.
# 4. preflight --ops AVANT TOUT (variables + chemins hôte canonicalisés via
#    paths.sh — la valeur exportée EST le chemin validé).
# 5. envrc.sh : parité compose vérifiée sur le .env, refus explicite des
#    syntaxes non reproduites ; le .env n'est jamais exécuté ; aucun secret
#    journalisé (noms de variables seulement).
#
# Usage :
#   ./scripts/ops.sh preflight                    # readiness complète (--ops)
#   ./scripts/ops.sh check-gates [--first-boot]   # contrôles premiers démarrages
#   ./scripts/ops.sh seed-admin -e ADMIN_EMAIL=.. -e ADMIN_PASSWORD=..
#   ./scripts/ops.sh migrate                      # migrations protégées
#   ./scripts/ops.sh backup                       # sauvegarde
#   ./scripts/ops.sh restore <dump> ENV <files|-> <dest>   # restauration isolée
#
# Exigences :
# - COMPOSE_PROJECT_NAME : projet cible (refus si absent).
# - OPS_NETWORK : réseau docker EXTERNE où vit la base (ex. réseau du panel
#   Coolify `6qnkc…`, ou réseau dédié pour tests isolés) — refus si absent.
# - Variables : processus, sinon <dossier compose>/.env (envrc.sh, parité
#   compose). Surcharges `-e KEY=VALUE` : format exigé, appliquées AVANT le
#   preflight (validées ensemble) puis transmises au conteneur (parité
#   validation/injection).
# - OPS_EXTRA_COMPOSE_FILES (optionnel) : fichiers compose supplémentaires
#   (séparés par espaces), vérifiés existants avant tout lancement — ils sont
#   interprétés par docker compose lui-même (mêmes règles compose).
#
# Exit : codes de preflight.sh (1 config, 2 usage), codes ops-live-check (1),
# puis codes docker compose / du script ops exécuté.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_COMPOSE="$DEPLOY_DIR/docker-compose.yml"
OPS_COMPOSE="$DEPLOY_DIR/docker-compose.ops.yml"

# Mêmes règles .env que docker compose (parité vérifiée) — refus explicite de
# toute syntaxe non reproduite, AVANT tout contrôle.
# shellcheck source=envrc.sh
. "$SCRIPT_DIR/envrc.sh" || {
  echo "[ops][ERREUR] chargement .env refusé (voir envrc ci-dessus) — aucune opération." >&2
  exit 1
}
# shellcheck source=paths.sh
. "$SCRIPT_DIR/paths.sh" || {
  echo "[ops][ERREUR] impossible de charger paths.sh — aucune opération." >&2
  exit 1
}

die() {
  echo "[ops][ERREUR] $*" >&2
  exit 1
}

[ $# -ge 1 ] || {
  echo "Usage : ops.sh <preflight|check-gates|seed-admin|migrate|backup|restore> [args...]" >&2
  exit 2
}
JOB="$1"
shift

case "$JOB" in
  preflight | check-gates | seed-admin | migrate | backup | restore) ;;
  *)
    echo "[ops][ERREUR] job inconnu : $JOB" >&2
    echo "Usage : ops.sh <preflight|check-gates|seed-admin|migrate|backup|restore> [args...]" >&2
    exit 2
    ;;
esac

# Projet compose cible : jamais de valeur devinée.
[ -n "${COMPOSE_PROJECT_NAME:-}" ] ||
  die "COMPOSE_PROJECT_NAME absent (UUID projet Coolify, ou nom de projet local) — aucun conteneur lancé."
[ -n "${OPS_NETWORK:-}" ] ||
  die "OPS_NETWORK absent (réseau docker externe où vit la base) — aucun conteneur lancé."
# Exportés pour les processus enfants (ops-live-check.sh) et pour que docker
# compose interpole avec les mêmes valeurs que celles validées ci-dessus.
export COMPOSE_PROJECT_NAME OPS_NETWORK

# Sépare les drapeaux -e k=v des arguments passés au conteneur.
# Les -e sont EXPORTÉS avant preflight : ce qui est validé EST ce qui est
# injecté (parité stricte), et la valeur devient prioritaire sur le .env
# (règle compose : processus > fichier).
ENV_FLAGS=()
CONTAINER_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -e)
      [ $# -ge 2 ] || die "-e requiert KEY=VALUE."
      case "$2" in
        [A-Za-z_][A-Za-z0-9_]*=*) : ;;
        *) die "-e format invalide (KEY=VALUE attendu) : clé refusée." ;;
      esac
      _k="${2%%=*}"
      _v="${2#*=}"
      export "$_k=$_v"
      ENV_FLAGS+=(-e "$2")
      shift 2
      ;;
    *)
      CONTAINER_ARGS+=("$1")
      shift
      ;;
  esac
done

# 1) Contrôle préalable variable/chemins — TOUJOURS --ops (suite complète),
#    exécuté AVANT toute commande docker compose.
if [ "$JOB" = "preflight" ]; then
  bash "$SCRIPT_DIR/preflight.sh" --ops
  exit $?
fi
bash "$SCRIPT_DIR/preflight.sh" --ops

# 2) Canonicalisation DES CHEMINS puis export — docker compose montera les
#    chemins VÉRIFIÉS (jamais la forme d'origine avec .., // ou liens).
for _p in BACKUP_HOST_DIR RESTORE_HOST_DIR; do
  ih_paths_canon "$_p" || die "chemin hôte invalide pour $_p — aucune opération."
  export "$_p"
done

# 3) Vérification LIVE des ressources réellement déployées (lecture seule).
case "$JOB" in
  restore) bash "$SCRIPT_DIR/ops-live-check.sh" --net ;;
  migrate | backup | check-gates | seed-admin) bash "$SCRIPT_DIR/ops-live-check.sh" --db ;;
esac

# 4) Fichiers compose supplémentaires (surcharges ops.sh) : existence exigée
#    AVANT lancement (interprétation = docker compose lui-même).
EXTRA_FILES=()
for f in ${OPS_EXTRA_COMPOSE_FILES:-}; do
  case "$f" in
    /*)
      [ -f "$f" ] || die "OPS_EXTRA_COMPOSE_FILES: introuvable $f"
      EXTRA_FILES+=(-f "$f")
      ;;
    *)
      [ -f "$DEPLOY_DIR/$f" ] || die "OPS_EXTRA_COMPOSE_FILES: introuvable $DEPLOY_DIR/$f"
      EXTRA_FILES+=(-f "$DEPLOY_DIR/$f")
      ;;
  esac
done

# 5) Commande compose : runtime + ops (réseau externe + jobs protégés) —
#    JAMAIS de dépendance lancée (--no-deps), jamais de réconciliation.
COMPOSE=(docker compose --project-directory "$DEPLOY_DIR" -f "$RUNTIME_COMPOSE" -f "$OPS_COMPOSE")
COMPOSE+=("${EXTRA_FILES[@]+"${EXTRA_FILES[@]}"}")

echo "[ops] $JOB : preflight --ops + live-check OK — lancement --no-deps (COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}, OPS_NETWORK=${OPS_NETWORK})."
exec "${COMPOSE[@]}" run --rm --no-deps "${ENV_FLAGS[@]+"${ENV_FLAGS[@]}"}" "$JOB" \
  "${CONTAINER_ARGS[@]+"${CONTAINER_ARGS[@]}"}"
