#!/usr/bin/env bash
# Code Diali — vérification LIVE des ressources réellement déployées (GO V5 §2).
# HÔTE uniquement (docker CLI) — appelé par ops.sh APRÈS preflight --ops et
# AVANT tout docker compose. LECTURE SEULE stricte : aucun conteneur créé,
# redémarré, recréé ; aucune écriture réseau/volume ; aucune SQL.
#
# Modes :
#   --db      jobs atteignant la base LIVE (migrate, backup, check-gates,
#             seed-admin) : projet + réseau + volumes + identité db exigés.
#   --net     jobs indépendants de la base live (restore) : réseau exigé.
#
# Refus AVANT MUTATION (exit 1) si un élément est absent, ambigu ou
# incompatible : daemon docker indisponible, COMPOSE_PROJECT_NAME/OPS_NETWORK
# absents, réseau OPS_NETWORK inexistant, conteneur db :
#   0 absent / ≥2 ambigus / non démarré / non sain / non rattaché à
#   OPS_NETWORK / sans alias « db » / sans volume projet monté.
#
# Sortie : uniquement des NOMS d'identifiants (ids, noms, alias) — jamais de
# valeurs d'environnement ni de secrets.
set -euo pipefail

MODE="${1:-}"
case "$MODE" in --db | --net) : ;;
*)
  echo "[live-check][ERREUR] mode attendu --db ou --net (reçu: '${MODE}')." >&2
  exit 2
  ;;
esac

fail() { echo "[live-check][ERREUR] $* — aucun conteneur lancé, aucune écriture effectuée." >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker CLI absent sur l'hôte"
docker info >/dev/null 2>&1 || fail "daemon docker injoignable"

PROJECT="${COMPOSE_PROJECT_NAME:-}"
[ -n "$PROJECT" ] || fail "COMPOSE_PROJECT_NAME absent"
NETWORK="${OPS_NETWORK:-}"
[ -n "$NETWORK" ] || fail "OPS_NETWORK absent (nom du réseau docker à rejoindre)"

docker network inspect "$NETWORK" >/dev/null 2>&1 || fail "réseau '$NETWORK' introuvable (réseau externe requis — jamais créé ici)"

# Conteneurs du projet (label compose officiel, lecture seule).
mapfile -t _ids < <(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")
[ "${#_ids[@]}" -gt 0 ] || fail "aucun conteneur du projet '$PROJECT' (déploiement absent ?)"

if [ "$MODE" = "--net" ]; then
  echo "[live-check] OK --net : projet '$PROJECT' présent (${#_ids[@]} conteneur(s)), réseau '$NETWORK' existe."
  exit 0
fi

# --- Mode --db : identité db stricte ---------------------------------------
mapfile -t _dbids < <(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=db")
N="${#_dbids[@]}"
[ "$N" -gt 0 ] || fail "aucun conteneur db en cours pour le projet '$PROJECT' (service db absent ou arrêté)"
[ "$N" -eq 1 ] || fail "conteneurs db AMBIGUS pour '$PROJECT' : $N en cours (intervention manuelle requise)"

DB="${_dbids[0]}"
DB_FULL="$(docker inspect -f '{{.Id}}' "$DB")"
STATE="$(docker inspect -f '{{.State.Status}}' "$DB")"
HEALTH="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}sans-healthcheck{{end}}' "$DB")"
[ "$STATE" = "running" ] || fail "db '$DB' dans l'état '$STATE' (running attendu)"
[ "$HEALTH" = "healthy" ] || fail "db '$DB' health '$HEALTH' (healthy attendu)"

# Rattachement au réseau + IDENTITÉ compose de résolution « db » :
# - attachement : l'id complet du conteneur doit figurer dans le réseau ;
# - résolution « db » : sur ce moteur (Docker 29), les endpoints réseau ne
#   portent PAS de champ Aliases (constat GO V5 — aucun conteneur n'en a) ;
#   le DNS intégré lit les labels compose du conteneur (projet + service=db).
#   Preuve empirique GO V5 (journal diag A3) :
#     docker exec <api> getent hosts db → 10.0.2.3 (IP du conteneur db).
docker network inspect "$NETWORK" -f '{{range $k,$v := .Containers}}{{println $k}}{{end}}' \
  | grep -q "^$DB_FULL\$" || fail "db '$DB' NON rattaché au réseau '$NETWORK'"
_lbl_p="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$DB" 2>/dev/null || true)"
[ "$_lbl_p" = "$PROJECT" ] ||
  fail "db '$DB' sans label compose project='$PROJECT' (résolution 'db' via DNS compose impossible)"
_lbl_s="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$DB" 2>/dev/null || true)"
[ "$_lbl_s" = "db" ] ||
  fail "db '$DB' sans label compose service='db' (résolution 'db' via DNS compose impossible)"

# Volume projet monté par db (identité de stockage — au moins un volume
# préfixé <project>_).
MOUNTS="$(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Name}} {{end}}' "$DB")"
case "$MOUNTS" in
  *volume:"${PROJECT}_"*) : ;;
  *) fail "db '$DB' sans volume projet '${PROJECT}_*' monté (montages: ${MOUNTS:-aucun})" ;;
esac

# État informationnel des autres services (jamais bloquant ici — les snapshots
# AVANT/APRÈS des tests prouvent l'absence de recréation).
for svc in api web preflight; do
  id="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$svc" | head -1)"
  if [ -n "$id" ]; then
    st="$(docker inspect -f '{{.State.Status}}' "$id")"
    echo "[live-check] info: service $svc = $id ($st)"
  else
    echo "[live-check] info: service $svc absent"
  fi
done

echo "[live-check] OK --db : projet '$PROJECT', réseau '$NETWORK', db=$DB (running/healthy, rattachée, labels compose projet+service db, volume projet). Lecture seule effectuée."
exit 0
