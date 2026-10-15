#!/usr/bin/env bash
# Code Diali — contrôle préalable des variables obligatoires (GO V3, durci GO V4).
#
# OÙ CE CONTRÔLE S'EXÉCUTE RÉELLEMENT (GO V4) :
# 1. Démarrage (runtime) : service one-shot `preflight` du docker-compose.yml —
#    db dépend de lui (condition: service_completed_successfully), api dépend de
#    db, web dépend de api. Il reçoit les MÊMES valeurs interpolées ${VAR:-} que
#    db/api/web (même fichier compose) : une variable runtime manquante =
#    exit 1 = docker compose up échoue = AUCUN service ne démarre. C'est le
#    chemin emprunté par un déploiement/redémarrage Coolify officiel.
# 2. Jobs ops : deploy/scripts/ops.sh exécute ce script AVANT tout
#    `docker compose run` (mode --ops pour migrate/backup/restore).
#
# RÈGLES DE VALEURS (identiques à docker compose, aucun repli silencieux) :
# - Priorité : variable d'environnement du processus > deploy/.env (chargé
#   explicitement ci-dessous) > rien.
# - Une variable DÉFINIE mais VIDE reste vide (compose ferait de même avec
#   ${VAR:-}) => c'est un échec, pas un motif de repli sur .env.
#
# MODE --ops (jobs ops) ajoute, en plus du runtime :
# - Variables ops : DATABASE_URL_OPS, EXPECTED_DB_HOST, EXPECTED_DB_NAME,
#   BACKUP_HOST_DIR ;
# - Variables restauration : DATABASE_URL_RESTORE, EXPECTED_DB_NAME_RESTORE,
#   RESTORE_HOST_DIR, RESTORE_MANIFEST (la revue V4 exigeait leur présence
#   dans --ops : toute la suite ops est refusée tant qu'elle est incomplète) ;
# - Validité des chemins hôte BACKUP_HOST_DIR / RESTORE_HOST_DIR : absolu,
#   existant, répertoire, ni « / » ni « /nonexistent ». Un chemin absent ou
#   invalide = refus AVANT tout conteneur — docker ne crée jamais de dossier
#   parasite (pas de ${VAR:-/nonexistent} dans les fichiers compose).
# - EXPECTED_DB_PORT reste facultatif (défaut 5432 côté compose et script).
#
# Usage :
#   ./deploy/scripts/preflight.sh            # vars runtime (db, api, web)
#   ./deploy/scripts/preflight.sh --ops      # vars runtime + TOUTES les vars ops
#
# Exit : 0 = prêt ; 1 = variable/chemin invalide ; 2 = usage invalide.
# Ce script ne fait AUCUNE écriture : contrôle seul, aucune opération lancée.

set -euo pipefail

MODE="${1:-runtime}"
case "$MODE" in
  runtime|--ops) ;;
  *)
    echo "[preflight][ERREUR] mode inconnu : $MODE (attendu : rien = runtime, ou --ops)" >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"

# Chargement EXPLICITE de deploy/.env avec les règles EXACTES de docker compose
# (env du processus gagne ; dernière ligne du fichier gagne en cas de doublon ;
# variable définie mais vide = échec, aucun repli silencieux). Implémentation
# partagée avec ops.sh : scripts/envrc.sh (un seul code, deux usages).
# shellcheck source=envrc.sh
. "$SCRIPT_DIR/envrc.sh"

# Variables obligatoires — runtime (services db/api/web, ancre x-api-env).
RUNTIME_VARS=(
  PG_USER
  PG_PASSWORD
  PG_DB
  JWT_SECRET
  ENCRYPTION_KEY
  PUBLIC_BASE_URL
  WEB_ORIGIN
  NEXT_PUBLIC_API_URL
)

# Variables obligatoires — suite ops complète (migrate, backup, restore).
OPS_VARS=(
  DATABASE_URL_OPS
  EXPECTED_DB_HOST
  EXPECTED_DB_NAME
  BACKUP_HOST_DIR
  DATABASE_URL_RESTORE
  EXPECTED_DB_NAME_RESTORE
  RESTORE_HOST_DIR
  RESTORE_MANIFEST
)

# Chemins hôte devant exister AVANT tout montage docker (jamais /nonexistent).
HOST_DIR_VARS=(
  BACKUP_HOST_DIR
  RESTORE_HOST_DIR
)

PROBLEMS=()

check_var() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    PROBLEMS+=("variable absente ou vide : $name")
  fi
}

check_host_dir() {
  local name="$1"
  local v="${!name:-}"
  [ -n "$v" ] || return 0 # déjà signalé par check_var
  if [ "${v#/}" = "$v" ]; then
    PROBLEMS+=("$name = '$v' : chemin hôte ABSOLU attendu")
    return 0
  fi
  case "$v" in
    / | /nonexistent)
      PROBLEMS+=("$name = '$v' : chemin refusé ('/' ni '/nonexistent' ne sont jamais montés)")
      return 0
      ;;
  esac
  if [ ! -e "$v" ]; then
    PROBLEMS+=("$name = '$v' : introuvable — créez-le d'abord (mkdir -p '$v' && chmod 700 '$v')")
    return 0
  fi
  if [ ! -d "$v" ]; then
    PROBLEMS+=("$name = '$v' : existe mais n'est pas un répertoire")
  fi
}

echo "[preflight] mode=$MODE — vérification des variables obligatoires..."

for v in "${RUNTIME_VARS[@]}"; do
  check_var "$v"
done

if [ "$MODE" = "--ops" ]; then
  for v in "${OPS_VARS[@]}"; do
    check_var "$v"
  done
  for v in "${HOST_DIR_VARS[@]}"; do
    check_host_dir "$v"
  done
fi

if [ ${#PROBLEMS[@]} -gt 0 ]; then
  echo "[preflight][ERREUR] Configuration invalide — refus avant toute opération :" >&2
  for p in "${PROBLEMS[@]}"; do
    echo "  - $p" >&2
  done
  echo "[preflight] Source : environnement du processus, sinon $ENV_FILE (si présent)." >&2
  echo "[preflight] Aucun conteneur lancé, aucune écriture effectuée." >&2
  exit 1
fi

echo "[preflight] OK — configuration $MODE complète. Aucune opération exécutée (contrôle seul)."
exit 0
