#!/usr/bin/env bash
# Code Diali — restauration contrôlée (GO §3 + revue V2 + V3). NE SUPPRIME RIEN.
#
# Usage :
#   RESTORE_MANIFEST=/restore/SHA256SUMS-<ts>.txt \
#   EXPECTED_DB_NAME=... [EXPECTED_DB_HOST=...] [EXPECTED_DB_PORT=...] \
#   [DATABASE_URL=...] \
#   restore.sh <db.dump> <DATABASE_URL_cible|ENV> <files.tar.gz|-> <RESTORE_FILES_ROOT|->
#
# - URL cible : 2e argument. "ENV" = utiliser DATABASE_URL de l'environnement
#   (recommandé pour les secrets — jamais dans les arguments visibles).
#   (Le placeholder "-" n'est PAS utilisable avec docker compose run, qui
#   l'interprète comme un flag ; "ENV" est le placeholder canonique.)
# - Manifeste OBLIGATOIRE (RESTORE_MANIFEST) : fichier SHA256SUMS produit par
#   backup.sh (lignes « <sha256>  <basename> »). CHAQUE fichier fourni doit y
#   avoir une ligne exacte dont l'empreinte correspond ; une ligne en trop ou
#   manquante = refus. Aucune sélection opportuniste (pas de glob
#   SHA256SUMS-*, pas de --ignore-missing), aucune recherche d'autres copies.
# - Archive fichiers : TOUS les contrôles sont exécutés AVANT toute écriture
#   DB — lisibilité gzip, chemins bornés, types d'entrées (réguliers +
#   répertoires seuls ; liens symboliques/physiques/fichiers spéciaux refusés).
# - Cible attendue (EXPECTED_DB_*) contrôlée AVANT toute écriture ; base
#   cible VIERGE exigée (exit 3) ; aucune suppression automatique.
# - Restauration fichiers BORNÉE : destination OBLIGATOIRE et DÉDIÉE
#   (RESTORE_FILES_ROOT) — jamais « / ». Destination déjà occupée = refus
#   (exit 7). Le job compose restore ne monte PAS les volumes de
#   l'application courante : impossibilité structurelle d'écraser l'app live.
# - Contrôle technique final (compteurs de tables) : CE N'EST PAS un
#   rapprochement financier — le rapprochement paiements/remboursements/
#   portefeuille/provider avant réouverture reste une procédure manuelle
#   (plan §4) et n'est pas automatisé ici.
#
# Exit : 2=usage/config/manifeste, 3=base non vierge, 4=pré-restauration,
# 5=restauration DB, 6=restauration fichiers/archive, 7=destination occupée,
# 8=empreinte/manifeste incohérent, 9=cible inattendue, 0=succès.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pg-conn.sh
. "$SCRIPT_DIR/pg-conn.sh"

log() { echo "[restore] $*"; }
die() { echo "[restore][ERREUR] $*" >&2; exit "${2:-2}"; }

DUMP="${1:-}"
URL_ARG="${2:-}"
FILES="${3:-}"
ROOT="${4:-}"

[ -n "$DUMP" ] || die "fichier .dump obligatoire." 2
[ -f "$DUMP" ] || die "fichier .dump introuvable: $DUMP" 2

# URL cible : 2e argument, "ENV" = repli sur DATABASE_URL env (jamais de secret
# dans les arguments visibles si une variable d'environnement convient).
if [ "$URL_ARG" = "ENV" ] || [ -z "$URL_ARG" ]; then
  URL="${DATABASE_URL:-}"
else
  URL="$URL_ARG"
fi
[ -n "$URL" ] || die "DATABASE_URL cible obligatoire (2e argument ou variable d'environnement — aucun repli silencieux)." 2

MANIFEST="${RESTORE_MANIFEST:-}"
[ -n "$MANIFEST" ] || die "RESTORE_MANIFEST obligatoire (fichier SHA256SUMS de backup.sh) — aucune vérification opportuniste." 2
[ -f "$MANIFEST" ] || die "RESTORE_MANIFEST introuvable: $MANIFEST" 2

DUMP_BASE="$(basename "$DUMP")"
FILES_BASE=""
if [ -n "$FILES" ] && [ "$FILES" != "-" ]; then
  [ -f "$FILES" ] || die "archive fichiers introuvable: $FILES" 2
  FILES_BASE="$(basename "$FILES")"
fi

TOOL_URL="$(pg_conn_convert "$URL")" || die "conversion Prisma -> outils PostgreSQL refusée." 2
export DATABASE_URL="$URL"

log "base cible: $(pg_conn_mask "$URL")"
log "dump source: $DUMP_BASE ($(wc -c <"$DUMP") octets)"
log "manifeste: $(basename "$MANIFEST")"

# ── 1. Manifeste STRICT : chaque fichier fourni, empreinte exacte ───────────
# Format attendu : lignes « <sha256><espaces><basename> » ; le manifeste ne
# doit contenir QUE les basenames des fichiers de CETTE sauvegarde.
declare -A MAN_HASH
MAN_COUNT=0
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  case "$line" in
    *'  '*)
      h="${line%%  *}"
      b="${line#*  }"
      ;;
    *)
      die "manifeste mal formé (format « <sha256>  <basename> » attendu)." 8
      ;;
  esac
  if ! printf '%s' "$h" | grep -Eq '^[0-9a-f]{64}$'; then
    die "manifeste : empreinte non hexadécimale sur '$b' — refus." 8
  fi
  case "$b" in
    */*|*'..'*)
      die "manifeste : basename attendu (chemin détecté sur '$b') — refus." 8
      ;;
  esac
  [ -z "${MAN_HASH[$b]:-}" ] || die "manifeste : doublon pour '$b' — refus." 8
  MAN_HASH[$b]="$h"
  MAN_COUNT=$((MAN_COUNT + 1))
done <"$MANIFEST"
[ "$MAN_COUNT" -gt 0 ] || die "manifeste vide — refus." 8

check_one() {
  local file="$1" base="$2"
  local expected="${MAN_HASH[$base]:-}"
  [ -n "$expected" ] || die "empreinte MANQUANTE au manifeste pour '$base' — refus (aucune recherche d'autres copies)." 8
  local actual
  actual="$(sha256sum "$file" | awk '{print $1}')" || die "calcul SHA-256 impossible pour '$base'." 8
  [ "$actual" = "$expected" ] || die "empreinte INCORRECTE pour '$base' — fichier altéré ? Refus avant toute écriture." 8
  log "empreinte OK: $base"
}

check_one "$DUMP" "$DUMP_BASE"
if [ -n "$FILES_BASE" ]; then
  check_one "$FILES" "$FILES_BASE"
fi

# Le manifeste ne doit contenir QUE les fichiers fournis (incohérence = refus) :
# lignes en trop = manifeste d'une autre sauvegarde ou fichier omis.
EXPECTED_COUNT=1
[ -n "$FILES_BASE" ] && EXPECTED_COUNT=2
[ "$MAN_COUNT" -eq "$EXPECTED_COUNT" ] \
  || die "manifeste incohérent ($MAN_COUNT lignes pour $EXPECTED_COUNT fichier(s) fourni(s)) — refus." 8

# ── 2. Contrôles DB (cible attendue, lisibilité, vierge) — avant écriture ──
export EXPECTED_DB_NAME="${EXPECTED_DB_NAME:?EXPECTED_DB_NAME obligatoire (cible attendue)}"
export EXPECTED_DB_HOST="${EXPECTED_DB_HOST:-db}"
export EXPECTED_DB_PORT="${EXPECTED_DB_PORT:-5432}"

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
      "SELECT current_database() AS db, inet_server_addr()::text AS addr, inet_server_port() AS port"
    );
    const r = rows[0];
    const addr = String(r.addr || '').split('/')[0];
    let resolved = null;
    try { resolved = await dns.lookup(expHost); } catch { resolved = null; }
    const problems = [];
    if (r.db !== expName) problems.push(`base '${r.db}' != attendu '${expName}'`);
    if (String(r.port) !== expPort) problems.push(`port '${r.port}' != attendu '${expPort}'`);
    if (!resolved) problems.push(`hôte attendu '${expHost}' non résoluble`);
    else if (addr !== resolved.address) problems.push(`serveur '${addr}' != résolu '${resolved.address}'`);
    if (problems.length) {
      console.error('REFUS CIBLE: ' + problems.join(' ; '));
      process.exit(9);
    }
    console.log('CIBLE_OK');
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error('ERREUR_VERIF: ' + e.message); process.exit(1); });
EOF
)" || die "vérification de la cible échouée (voir ci-dessus) — aucune écriture." 9
echo "$IDENT_OUT" | grep -q 'CIBLE_OK' || die "cible refusée — aucune écriture." 9

# pg_restore --list : capture explicite du code retour (jamais perdu dans une
# substitution de processus). Un dump corrompu/tronqué = refus AVANT toute
# écriture DB.
PG_LIST_ERR="$(mktemp)"
if ! pg_restore --list "$DUMP" >/dev/null 2>"$PG_LIST_ERR"; then
  PG_LIST_MSG="$(cat "$PG_LIST_ERR" 2>/dev/null || echo 'détail indisponible')"
  rm -f "$PG_LIST_ERR"
  die "dump illisible ou corrompu (pg_restore --list) : $PG_LIST_MSG — aucune écriture." 8
fi
rm -f "$PG_LIST_ERR"
log "dump lisible (pg_restore --list OK)."

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
)" || die "impossible de compter les tables de la base cible." 2

if [ "$TABLES" -gt 0 ]; then
  die "base cible NON vierge ($TABLES tables) — refus (aucune suppression automatique). Utiliser une base neuve." 3
fi

# ── 3. Contrôle COMPLET de l'archive fichiers (si fournie) — avant écriture DB
# TOUS les contrôles ci-dessous s'exécutent AVANT la moindre écriture DB.
if [ -n "$FILES_BASE" ]; then
  [ -n "$ROOT" ] && [ "$ROOT" != "-" ] || die "RESTORE_FILES_ROOT obligatoire si archive fournie (destination dédiée, jamais '/')." 2
  case "$ROOT" in
    /|'') die "RESTORE_FILES_ROOT ne peut pas être la racine du système — destination dédiée obligatoire." 2 ;;
  esac

  # 3a. Lisibilité gzip : capture explicite du code retour (jamais perdu dans
  # une substitution de processus). Une archive non-gzip ou tronquée = refus
  # IMMÉDIAT, avant toute inspection d'entrée.
  TAR_LIST_ERR="$(mktemp)"
  TAR_LIST_OUT="$(mktemp)"
  if ! tar -tzf "$FILES" >"$TAR_LIST_OUT" 2>"$TAR_LIST_ERR"; then
    TAR_LIST_MSG="$(cat "$TAR_LIST_ERR" 2>/dev/null || echo 'détail indisponible')"
    rm -f "$TAR_LIST_ERR" "$TAR_LIST_OUT"
    die "archive illisible ou non-gzip (tar -tzf) : $TAR_LIST_MSG — aucune écriture DB ni fichiers." 6
  fi
  rm -f "$TAR_LIST_ERR"

  # 3b. Inspection des types d'entrées : tar -tvzf expose le premier caractère
  # du mode GNU — seul le type « - » (fichier régulier) et « d » (répertoire)
  # sont autorisés pour ce format de sauvegarde. Liens symboliques (« l »),
  # liens physiques (« h ») et fichiers spéciaux (b/c/p/s) = refus.
  TAR_VOUT="$(mktemp)"
  if ! tar -tvzf "$FILES" >"$TAR_VOUT" 2>/dev/null; then
    rm -f "$TAR_VOUT" "$TAR_LIST_OUT"
    die "lecture verbose de l'archive impossible (tar -tvzf) — aucune écriture DB ni fichiers." 6
  fi

  ENTRY_ERR=0
  ENTRY_ERR_MSG=""
  while IFS= read -r vline; do
    [ -n "$vline" ] || continue
    # Premier caractère du mode GNU : type d'entrée.
    entry_type="${vline:0:1}"
    case "$entry_type" in
      -|d) : ;;  # fichier régulier ou répertoire — autorisé
      l)
        ENTRY_ERR=1
        ENTRY_ERR_MSG="lien symbolique détecté dans l'archive — refus (format de sauvegarde : fichiers/répertoires seuls)."
        break
        ;;
      h)
        ENTRY_ERR=1
        ENTRY_ERR_MSG="lien physique (hardlink) détecté dans l'archive — refus."
        break
        ;;
      b|c|p|s)
        ENTRY_ERR=1
        ENTRY_ERR_MSG="fichier spécial détecté dans l'archive (type '$entry_type') — refus."
        break
        ;;
      *)
        ENTRY_ERR=1
        ENTRY_ERR_MSG="type d'entrée inconnu '$entry_type' dans l'archive — refus."
        break
        ;;
    esac
    # Nom d'entrée : 6e champ (après mode, owner, size, date, heure) — extraire
    # via sed pour robustesse. Contrôle chemins : absolus, '..', préfixes.
    entry_name="$(printf '%s\n' "$vline" | sed -E 's/^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +//')"
    # Retirer la cible éventuelle d'un lien (« -> chemin ») si présente —
    # déjà refusé ci-dessus, mais on ne contrôle jamais que le nom seul.
    entry_name="${entry_name%% -> *}"
    case "$entry_name" in
      /*|*..*)
        ENTRY_ERR=1
        ENTRY_ERR_MSG="entrée hors destination détectée (absolue ou '..'): '$entry_name' — refus."
        break
        ;;
      storage/*|public/branding/*) : ;;
      *)
        ENTRY_ERR=1
        ENTRY_ERR_MSG="préfixe d'entrée non autorisé: '$entry_name' (storage/ ou public/branding/ uniquement) — refus."
        break
        ;;
    esac
  done <"$TAR_VOUT"
  rm -f "$TAR_VOUT" "$TAR_LIST_OUT"
  [ "$ENTRY_ERR" -eq 0 ] || die "archive fichiers refusnée : $ENTRY_ERR_MSG — aucune écriture DB ni fichiers." 6
  log "archive contrôlée : types d'entrées valides (fichiers/répertoires seuls), chemins bornés."

  # 3c. Destination dédiée et non occupée.
  mkdir -p "$ROOT" || die "création de la destination impossible: $ROOT" 6
  ROOT_ABS="$(cd "$ROOT" && pwd)"
  case "$ROOT_ABS" in
    /) die "destination résolue = racine — refus." 6 ;;
  esac
  # Destination déjà occupée ? (procédure retenue : jamais d'écrasement)
  for sub in storage public; do
    if [ -e "$ROOT_ABS/$sub" ]; then
      die "destination déjà occupée: $ROOT_ABS/$sub existe — refus (procédure : destination neuve ou intervention explicite hors de ce script)." 7
    fi
  done
  log "destination dédiée vérifiée: $ROOT_ABS (vide pour storage/ et public/)."
fi

# ── 4. Sauvegarde préalable de l'état courant (base vierge -> dump minimal) ─
BACKUP_DIR="${BACKUP_DIR:-/backups}"
mkdir -p "$BACKUP_DIR" || die "création de BACKUP_DIR impossible." 4
PRE="$BACKUP_DIR/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
log "sauvegarde pré-restauration: $(basename "$PRE")"
pg_dump -Fc -f "$PRE" "$TOOL_URL" || die "sauvegarde pré-restauration échouée." 4
[ -s "$PRE" ] || log "attention: dump pré-restauration vide (base vierge)."
pg_restore --list "$PRE" >/dev/null || die "dump pré-restauration illisible." 4
chmod 600 "$PRE" || die "chmod 600 du dump pré-restauration impossible."

# ── 5. Restauration DB ──────────────────────────────────────────────────────
log "restauration de la base..."
if ! pg_restore --exit-on-error --no-owner --no-privileges -d "$TOOL_URL" "$DUMP"; then
  die "pg_restore a échoué (aucun rollback automatique ; la base peut être partielle — inspecter avant toute reprise)." 5
fi
log "restauration DB terminée."

# ── 6. Restauration fichiers (bornée dans RESTORE_FILES_ROOT, additive) ────
if [ -n "$FILES_BASE" ]; then
  log "restauration des fichiers (bornée): $FILES_BASE -> $ROOT_ABS"
  # --no-same-owner : les fichiers sont créés avec l'utilisateur du conteneur.
  # --no-same-permissions : permissions raisonnables (umask 077 du shell).
  tar -xzf "$FILES" -C "$ROOT_ABS" --no-same-owner || die "extraction des fichiers échouée (destination inchangée possible — inspecter)." 6
  log "fichiers restaurés dans $ROOT_ABS (procedure de recopie vers les volumes = manuelle, hors de ce script)."
else
  log "aucune archive fichiers fournie (base seule)."
fi

# ── 7. Contrôle technique (PAS un rapprochement financier) ─────────────────
log "contrôle technique post-restauration (compteurs — PAS un rapprochement financier)..."
node <<'EOF' || die "contrôle technique impossible." 5
const { PrismaClient } = require('@prisma/client');
(async () => {
  const prisma = new PrismaClient();
  try {
    const q = async (label, sql) => {
      const rows = await prisma.$queryRawUnsafe(sql);
      console.log(`  ${label}: ${rows[0].n}`);
    };
    console.log('COMPTEURS TECHNIQUES (à rapprocher manuellement avec la source et le journal provider) :');
    await q('CardPayment', 'SELECT count(*)::int AS n FROM "CardPayment"');
    await q('Refund', 'SELECT count(*)::int AS n FROM "Refund"');
    await q('RefundObservation', 'SELECT count(*)::int AS n FROM "RefundObservation"');
    await q('WalletTransaction', 'SELECT count(*)::int AS n FROM "WalletTransaction"');
    await q('PaymentWebhookEvent', 'SELECT count(*)::int AS n FROM "PaymentWebhookEvent"');
    await q('Order', 'SELECT count(*)::int AS n FROM "Order"');
    console.log('  -> AUCUNE opération rejouée. Rapprochement financier (paiements/remboursements/');
    console.log('     portefeuille/effets provider) = PROCÉDURE MANUELLE obligatoire avant réouverture.');
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
EOF

log "RESTORE_OK (restauration technique — rapprochement financier manuel restant)"
exit 0
