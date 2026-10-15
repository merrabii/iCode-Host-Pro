#!/usr/bin/env bash
# Code Diali — commandes ops OFFICIELLES (GO V4).
#
# Ce wrapper est le chemin de commande DOCUMENTÉ pour les jobs ops : il exécute
# TOUJOURS deploy/scripts/preflight.sh AVANT tout docker compose run. Un
# paramètre absent ou un chemin invalide = refus avec code retour, sans
# conteneur lancé, sans écriture hôte, sans base touchée.
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
# - COMPOSE_PROJECT_NAME : projet cible (refus si absent — jamais de pile
#   par défaut devinée). En preprod = UUID du projet Coolify ; en stack
#   locale = nom du projet (ex. code-diali).
# - Variables : environnement du processus, sinon <dossier compose>/.env
#   (mêmes règles que docker compose, appliquées par preflight.sh).
# - OPS_EXTRA_COMPOSE_FILES (optionnel) : fichiers compose supplémentaires
#   séparés par des espaces, relatifs au dossier compose ou absolus (ex. :
#   pins d'images/réseau preprod : ops-override.yml).
#
# Effets des gardes ${VAR:?} du docker-compose.ops.yml (chargé pour
# migrate/backup/restore) : toute variable ops manquante = refus au CHARGEMENT
# de la configuration, avant tout conteneur. preflight.sh refuse en amont avec
# un message listant chaque manque.
#
# Exit : codes de preflight.sh (1 = config invalide, 2 = usage) puis codes de
# docker compose / du script ops exécuté.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_COMPOSE="$DEPLOY_DIR/docker-compose.yml"
OPS_COMPOSE="$DEPLOY_DIR/docker-compose.ops.yml"

# Mêmes règles .env que docker compose (partagé avec preflight.sh) — exigé
# AVANT tout contrôle : COMPOSE_PROJECT_NAME / OPS_EXTRA_COMPOSE_FILES peuvent
# venir du .env du dossier compose.
# shellcheck source=envrc.sh
. "$SCRIPT_DIR/envrc.sh"

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

# Sépare les drapeaux -e k=v (à placer AVANT le nom du service) des arguments
# passés au conteneur.
ENV_FLAGS=()
CONTAINER_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -e)
      [ $# -ge 2 ] || die "-e requiert KEY=VALUE."
      ENV_FLAGS+=(-e "$2")
      shift 2
      ;;
    *)
      CONTAINER_ARGS+=("$1")
      shift
      ;;
  esac
done

# 1) Contrôle préalable (toujours exécuté, avant tout docker compose).
case "$JOB" in
  preflight) PREFLIGHT_MODE="--ops" ;;
  migrate | backup | restore) PREFLIGHT_MODE="--ops" ;;
  check-gates | seed-admin) PREFLIGHT_MODE="runtime" ;;
esac

if [ "$JOB" = "preflight" ]; then
  exec bash "$SCRIPT_DIR/preflight.sh" "$PREFLIGHT_MODE"
fi

bash "$SCRIPT_DIR/preflight.sh" "$PREFLIGHT_MODE"

# 2) Commande compose (runtime seul, ou runtime + fichier ops protégé).
COMPOSE=(docker compose --project-directory "$DEPLOY_DIR" -f "$RUNTIME_COMPOSE")
case "$JOB" in
  migrate | backup | restore) COMPOSE+=(-f "$OPS_COMPOSE") ;;
esac
for f in ${OPS_EXTRA_COMPOSE_FILES:-}; do
  case "$f" in
    /*) COMPOSE+=(-f "$f") ;;
    *) COMPOSE+=(-f "$DEPLOY_DIR/$f") ;;
  esac
done

echo "[ops] $JOB : préflight $PREFLIGHT_MODE OK — lancement (COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME})."
exec "${COMPOSE[@]}" run --rm "${ENV_FLAGS[@]+"${ENV_FLAGS[@]}"}" "$JOB" \
  "${CONTAINER_ARGS[@]+"${CONTAINER_ARGS[@]}"}"
