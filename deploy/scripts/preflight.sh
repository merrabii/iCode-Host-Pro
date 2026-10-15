#!/usr/bin/env bash
# Code Diali — contrôle préalable des variables obligatoires (GO V3).
#
# Ce script remplace les gardes ${VAR:?} du compose (non supportées par le
# validateur Coolify 4.4.6). Il vérifie TOUTES les variables obligatoires
# AVANT tout docker compose up/run et refuse avec un message explicite.
#
# Usage :
#   ./deploy/scripts/preflight.sh            # vérifie les vars runtime
#   ./deploy/scripts/preflight.sh --ops      # vérifie aussi les vars ops
#
# Exit : 0 = toutes les variables présentes ; 1 = au moins une variable manquante.

set -euo pipefail

MODE="${1:-runtime}"

# Variables obligatoires pour le runtime (db, api, web).
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

# Variables obligatoires pour les jobs ops (migrate, backup, restore).
OPS_VARS=(
  DATABASE_URL_OPS
  EXPECTED_DB_HOST
  EXPECTED_DB_NAME
  BACKUP_HOST_DIR
)

MISSING=()

check_var() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    MISSING+=("$name")
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
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "[preflight][ERREUR] Variables obligatoires absentes :" >&2
  for v in "${MISSING[@]}"; do
    echo "  - $v" >&2
  done
  echo "[preflight] Définissez ces variables puis relancez. Aucune opération exécutée." >&2
  exit 1
fi

echo "[preflight] OK — toutes les variables obligatoires sont présentes."
exit 0
