#!/usr/bin/env bash
# Code Diali — migration protégée (GO §4 + revue V2).
# - DATABASE_URL EXPLICITE obligatoire (argument ou variable d'environnement).
#   AUCUN repli silencieux vers un .env de développement.
# - Identité SQL vérifiée AVANT toute mutation : base + hôte (résolu DNS) + port.
# HONNÊTETÉ (limite) : le contrôle ouvre sa PROPRE connexion Prisma, se
# déconnecte, puis `prisma migrate deploy` et pg_dump ouvrent d'autres
# connexions (pool). Il n'y a PAS de « session unique » : la garantie est la
# COHÉRENCE DE LA CIBLE CONFIGURÉE — même DATABASE_URL, mêmes EXPECTED_* ;
# les refus couvrent base/hôte/port inattendus. Un bascule de DNS entre le
# contrôle et la migration n'est pas détectable par ce script (limite
# documentée, jamais présentée comme verrou de session).
# - Sauvegarde préalable VÉRIFIÉE si la base contient déjà des tables
#   (umask 077, mode 0600, nom unique <ts>-<pid>).
# - Conversion Prisma → outils PostgreSQL explicite (pg-conn.sh) : aucune
#   option de connexion modifiée silencieusement.
# - Exit : 2=usage/config, 3=identité refusée, 4=sauvegarde préalable,
# 5=migration échouée, 0=succès.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pg-conn.sh
. "$SCRIPT_DIR/pg-conn.sh"

log() { echo "[migrate-guarded] $*"; }
die() { echo "[migrate-guarded][ERREUR] $*" >&2; exit "${2:-2}"; }

# 1) URL obligatoire, aucun repli.
URL="${1:-${DATABASE_URL:-}}"
[ -n "$URL" ] || die "DATABASE_URL obligatoire (argument ou variable). Aucun repli .env." 2
case "$URL" in
  *"://"*) : ;;
  *) die "DATABASE_URL invalide (format postgresql:// attendu)." 2 ;;
esac
export DATABASE_URL="$URL"

# 2) Cible attendue obligatoire (serveur/port/base).
: "${EXPECTED_DB_HOST:?EXPECTED_DB_HOST obligatoire}" || die "EXPECTED_DB_HOST manquant." 2
: "${EXPECTED_DB_PORT:=5432}"
: "${EXPECTED_DB_NAME:?EXPECTED_DB_NAME obligatoire}" || die "EXPECTED_DB_NAME manquant." 2

log "cible masquée: $(pg_conn_mask "$URL")"
log "attendu: host=$EXPECTED_DB_HOST port=$EXPECTED_DB_PORT db=$EXPECTED_DB_NAME"

# 3) Identité SQL (propre connexion Prisma — voir limite « session » ci-dessus).
log "vérification de l'identité SQL (current_database + inet_server_addr + port)..."
IDENT_OUT="$(node <<'EOF'
const { PrismaClient } = require('@prisma/client');
const dns = require('node:dns').promises;
(async () => {
  const expHost = process.env.EXPECTED_DB_HOST;
  const expPort = String(process.env.EXPECTED_DB_PORT || '5432');
  const expName = process.env.EXPECTED_DB_NAME;
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(
      "SELECT current_database() AS db, inet_server_addr()::text AS addr, inet_server_port() AS port, current_user AS usr"
    );
    const r = rows[0];
    const addr = String(r.addr || '').split('/')[0];
    let resolved = null;
    try { resolved = await dns.lookup(expHost); } catch { resolved = null; }
    const problems = [];
    if (r.db !== expName) problems.push(`base '${r.db}' != attendu '${expName}'`);
    if (String(r.port) !== expPort) problems.push(`port '${r.port}' != attendu '${expPort}'`);
    if (!resolved) problems.push(`hôte attendu '${expHost}' non résoluble`);
    else if (addr !== resolved.address) problems.push(`serveur '${addr}' != résolu '${expHost}' -> '${resolved.address}'`);
    console.log(JSON.stringify({ db: r.db, addr, port: r.port, user: r.usr }));
    if (problems.length) {
      console.error('REFUS IDENTITE: ' + problems.join(' ; '));
      process.exit(3);
    }
    console.log('IDENTITE_OK');
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => { console.error('ERREUR_VERIF: ' + e.message); process.exit(1); });
EOF
)" || die "échec de la vérification d'identité (voir ci-dessus)." 3
echo "$IDENT_OUT"
echo "$IDENT_OUT" | grep -q 'IDENTITE_OK' || die "identité SQL refusée — aucune migration exécutée." 3
log "identité confirmée (cible configurée — pas une session unique, cf. limite documentée)."

# 4) Sauvegarde préalable si la base contient déjà des tables (GO §4).
TABLES="$(node <<'EOF'
const { PrismaClient } = require('@prisma/client');
(async () => {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'"
    );
    console.log(String(rows[0].n));
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
EOF
)" || die "impossible de compter les tables existantes." 2
log "tables publiques présentes: $TABLES"

if [ "$TABLES" -gt 0 ]; then
  BACKUP_DIR="${BACKUP_DIR:-/backups}"
  mkdir -p "$BACKUP_DIR"
  PRE="$BACKUP_DIR/pre-migrate-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
  log "base existante -> sauvegarde préalable obligatoire: $(basename "$PRE")"
  TOOL_URL="$(pg_conn_convert "$DATABASE_URL")" || die "conversion Prisma -> outils PostgreSQL refusée." 2
  pg_dump -Fc -f "$PRE" "$TOOL_URL" || die "pg_dump préalable échoué — migration refusée." 4
  [ -s "$PRE" ] || die "sauvegarde préalable vide — migration refusée." 4
  pg_restore --list "$PRE" >/dev/null || die "sauvegarde préalable illisible (pg_restore --list) — migration refusée." 4
  chmod 600 "$PRE" || die "chmod 600 de la sauvegarde préalable impossible."
  log "sauvegarde préalable vérifiée ($(wc -c <"$PRE") octets, mode 0600)."
else
  log "base vierge : aucune sauvegarde préalable nécessaire."
fi

# 5) Migration (même URL configurée — pools distincts, cf. limite documentée).
log "prisma migrate deploy..."
if ! npx prisma migrate deploy; then
  die "prisma migrate deploy a échoué (voir sorties ci-dessus)." 5
fi

log "MIGRATION_OK ($TABLES tables avant)"
exit 0
