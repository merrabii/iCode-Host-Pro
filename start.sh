#!/usr/bin/env bash
# =============================================================================
# iCode Host — lancement de la plateforme locale (Windows Git Bash / Linux/macOS)
# -----------------------------------------------------------------------------
#   after reboot, ever:  ./start.sh
#
#   Topologie :
#     PostgreSQL   port 5432  (Docker) — données dans le volume `icode_pg_data`
#     API  NestJS  port 3001  (cwd apps/api, node dist/src/main.js)
#     Web  NextJS  port 3000  (cwd apps/web, next dev)
#
#   Chaque app charge sa PROPRE .env (apps/api/.env, apps/web/.env) — gitignored.
#   Aucun .env racine : PAS de variables d'env à poser manuellement en shell.
#
#   AVANT TOUT : Docker Desktop doit être lancé (sinon Postgres ne démarre pas).
# =============================================================================
set -euo pipefail

# Chemin du repo (compatible lancement depuis n'importe quel dossier).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$ROOT/apps/api"
WEB_DIR="$ROOT/apps/web"
API_PORT=3001
WEB_PORT=3000
API_LOG=/tmp/api.log
WEB_LOG=/tmp/web.log

log() { printf '\n\033[1;36m[iCode]\033[0m %s\n' "$*"; }

# Tuer un lancement PRÉCÉDENT de notre stack encore accroché à un port.
# Ne supprime que ce qui collait déjà à notre app (marqueur), jamais un process tiers.
free_port() {
  local port="$1" marker="$2"
  if command -v netstat >/dev/null 2>&1; then
    local pid
    pid="$(netstat -ano 2>/dev/null | awk -v p=":$port " '$4==p {print $5; exit}')"
    if [ -n "${pid:-}" ]; then
      local cmd
      cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      case "$cmd" in
        *"$marker"*)
          kill -9 "$pid" 2>/dev/null || true
          log "port $port (@pid $pid) relancé."
          ;;
        *)
          log "❗ port $port occupé par un process externe (@pid $pid) — je n'y touche pas."
          ;;
      esac
    fi
  fi
}

# -----------------------------------------------------------------------------
# 1) Base de données — à démarrer EN PREMIER (l'API refuse de boot sans elle).
# -----------------------------------------------------------------------------
log "1/4 — PostgreSQL (docker compose up -d postgres)…"
docker compose -f "$ROOT/docker-compose.yml" up -d postgres
for i in $(seq 1 30); do
  if nc -z 127.0.0.1 5432 2>/dev/null; then log "PostgreSQL prêt (5432)."; break; fi
  [ "$i" -eq 30 ] && { echo "!! Postgres ne répond pas sur 5432 dans 30 s." >&2; exit 1; }
  sleep 1
done

# -----------------------------------------------------------------------------
# 2) Schéma de BDD à jour (idempotent — sans risque à chaque lancement).
# -----------------------------------------------------------------------------
log "2/4 — migrations Prisma (migrate deploy)…"
(cd "$API_DIR" && npx prisma migrate deploy >>"$API_LOG" 2>&1)
log "Schéma à jour."

# -----------------------------------------------------------------------------
# 3) API NestJS (compilée) sur 3001.
# -----------------------------------------------------------------------------
log "3/4 — API (port $API_PORT)…"
# S'assurer qu'un build compilé existe ; sinon le compiler.
if [ ! -f "$API_DIR/dist/src/main.js" ]; then
  log "fin build API introuvable — exécution de pnpm build…"
  (cd "$API_DIR" && pnpm build >>"$API_LOG" 2>&1)
fi
free_port "$API_PORT" "dist/src/main.js"
# Lancement en arrière-plan, log dédié. L'app charge apps/api/.env via son cwd.
(cd "$API_DIR" && nohup node dist/src/main.js >"$API_LOG" 2>&1 &)
for i in $(seq 1 30); do
  if grep -q "Nest application successfully started" "$API_LOG" 2>/dev/null; then log "API prête sur http://localhost:$API_PORT."; break; fi
  if grep -qE "Error:|ENOENT|ECONNREFUSED" "$API_LOG" 2>/dev/null; then echo "!! Erreur API :"; tail -n 15 "$API_LOG" >&2; exit 1; fi
  [ "$i" -eq 30 ] && { echo "!! API pas prête dans 30 s — voir $API_LOG." >&2; exit 1; }
  sleep 1
done

# -----------------------------------------------------------------------------
# 4) Web Next.js (dev) sur 3000.
# -----------------------------------------------------------------------------
log "4/4 — Web (port $WEB_PORT)…"
free_port "$WEB_PORT" "next/dist/bin/next"
(cd "$WEB_DIR" && nohup node node_modules/next/dist/bin/next dev >"$WEB_LOG" 2>&1 &)
for i in $(seq 1 60); do
  if grep -qE "Ready in|Local: +http://localhost" "$WEB_LOG" 2>/dev/null; then log "Web prêt sur http://localhost:$WEB_PORT."; break; fi
  if grep -qiE "EADDRINUSE|Failed to compile" "$WEB_LOG" 2>/dev/null; then echo "!! Erreur web :"; tail -n 15 "$WEB_LOG" >&2; exit 1; fi
  [ "$i" -eq 60 ] && { echo "!! Web pas prêt dans 60 s — voir $WEB_LOG." >&2; exit 1; }
  sleep 1
done

# -----------------------------------------------------------------------------
log "✓ Plateforme lancée :"
echo "   • Web   → http://localhost:3000   (log: $WEB_LOG)"
echo "   • API   → http://localhost:3001   (log: $API_LOG)"
echo "   • Admin → http://localhost:3000/manager   (admin@icodehost.local / AdminDev!2026)"
echo ""
echo "   Pour arrêter :  Ctrl+C  puis  docker compose -f \"$ROOT/docker-compose.yml\" down"