#!/usr/bin/env bash
# Code Diali — sauvegarde base + fichiers persistants (GO §3 + revue V2).
# Usage : backup.sh <DATABASE_URL> <BACKUP_DIR>
#   DATABASE_URL : URL de la base (obligatoire, aucun repli).
#   BACKUP_DIR   : dossier de destination monté depuis l'hôte (obligatoire).
#
# Garanties :
# - umask 077 AVANT toute écriture (dumps, listes, empreintes créés en 0600 ;
#   le mode est ensuite re-vérifié — aucun échec de permission masqué).
# - Sortie en SHA256SUMS-<ts>-<pid>.txt : manifeste à basenames, utilisable
#   DIRECTEMENT par restore.sh (aucune sélection opportuniste de fichiers).
# - Dossiers de fichiers persistants : PRÉSENCE exigée (sinon erreur — volume
#   attendu absent/non monté n'est JAMAIS une « sauvegarde complète ») ;
#   dossiers présents et VIDES = cas normal (0 fichier, archive non produite).
# - REQUIRE_VOLUME_MOUNTS=1 (défaut dans le job compose backup) : chaque
#   répertoire de fichiers doit être un point de montage de volume — la
#   sauvegarde d'un arbre non monté serait potentiellement incomplète (erreur,
#   pas de succès silencieux). Poser à 0 pour un mode expert documenté.
# - Noms uniques : <ts>-<pid> — aucun écrasement, aucune collision.
# - Échec bruyant (exit 1) sur tout problème.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pg-conn.sh
. "$SCRIPT_DIR/pg-conn.sh"

log() { echo "[backup] $*"; }
die() { echo "[backup][ERREUR] $*" >&2; exit 1; }

URL="${1:-${DATABASE_URL:-}}"
DEST="${2:-${BACKUP_DIR:-}}"
[ -n "$URL" ] || die "DATABASE_URL obligatoire."
[ -n "$DEST" ] || die "BACKUP_DIR obligatoire."

STORAGE_DIR="${STORAGE_DIR:-/repo/apps/api/storage}"
BRANDING_DIR="${BRANDING_DIR:-/repo/apps/api/public/branding}"
REQUIRE_VOLUME_MOUNTS="${REQUIRE_VOLUME_MOUNTS:-1}"

TS="$(date -u +%Y%m%dT%H%M%SZ)-$$"

TOOL_URL="$(pg_conn_convert "$URL")" || die "conversion Prisma -> outils PostgreSQL refusée (option inconnue ou URL invalide — ci-dessus)."
log "base: $(pg_conn_mask "$URL")"
log "destination: $DEST"

mkdir -p "$DEST" || die "création du dossier de destination impossible: $DEST"

# Chaque racine de fichiers DOIT être présente (volume monté ou répertoire
# créé dans l'image) : un répertoire manquant = configuration de montage
# invalide, jamais un « succès ».
for d in "$STORAGE_DIR" "$BRANDING_DIR"; do
  [ -d "$d" ] || die "répertoire attendu absent (volume attendu absent ou non monté?): $d"
done
if [ "$REQUIRE_VOLUME_MOUNTS" = "1" ]; then
  for d in "$STORAGE_DIR" "$BRANDING_DIR"; do
    awk -v p="$d" '$5 == p { found = 1 } END { exit found ? 0 : 1 }' /proc/self/mountinfo \
      || die "REQUIRE_VOLUME_MOUNTS=1 : $d n'est PAS un point de montage — volume non monté (refus, pas de sauvegarde complète)."
  done
  log "volumes montés: storage + branding vérifiés (mountinfo)."
fi

# 1) Base -------------------------------------------------------------------
DBF="$DEST/db-$TS.dump"
log "pg_dump..."
pg_dump -Fc -f "$DBF" "$TOOL_URL" || die "pg_dump a échoué."
[ -s "$DBF" ] || die "fichier de base vide."
pg_restore --list "$DBF" >/dev/null || die "archive de base illisible (pg_restore --list)."
DB_SIZE="$(wc -c <"$DBF")"
chmod 600 "$DBF" || die "chmod 600 du dump impossible (échec de permission non masqué)."
log "base OK: db-$TS.dump ($DB_SIZE octets, archive lisible, mode 0600)."

# 2) Fichiers persistants (présents+vides = normal ; illisible = erreur) -----
FILELIST="$DEST/files-$TS.txt"
: >"$FILELIST" || die "création de la liste de fichiers impossible."
find "$STORAGE_DIR" "$BRANDING_DIR" -type f -print >>"$FILELIST" || die "listing des fichiers persistants impossible."
NFILES="$(grep -c . "$FILELIST" || true)"
FILES_ARC=""
if [ "$NFILES" -gt 0 ]; then
  FILES_ARC="$DEST/files-$TS.tar.gz"
  # Chemins RELATIFS dans l'archive (relative à /repo/apps/api) : restore.sh
  # impose préfixes autorisés + refus des absolus/« .. » (contrôle borné).
  # Tout fichier hors /repo/apps/api/* = configuration invalide (refus).
  RELIST="$DEST/files-rel-$TS.txt"
  : >"$RELIST" || die "création de la liste relative impossible."
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      /repo/apps/api/*) printf '%s\n' "${f#/repo/apps/api/}" >>"$RELIST" ;;
      *) die "fichier persistant hors /repo/apps/api/* — format d'archive non pris en charge (refus)." ;;
    esac
  done <"$FILELIST"
  (cd /repo/apps/api && tar -czf "$FILES_ARC" -T "$RELIST") || die "archivage des fichiers échoué."
  [ -s "$FILES_ARC" ] || die "archive fichiers vide."
  tar -tzf "$FILES_ARC" >/dev/null || die "archive fichiers illisible."
  chmod 600 "$FILES_ARC" "$RELIST" || die "chmod 600 de l'archive impossible."
  log "fichiers OK: files-$TS.tar.gz ($NFILES fichiers, chemins relatifs, archive lisible)."
else
  log "dossiers persistants présents et vides (cas normal) — archive fichiers non produite."
fi
chmod 600 "$FILELIST" || die "chmod 600 de la liste impossible."

# 3) Manifeste (basenames uniquement — consommable par restore.sh) ----------
SUMS="$DEST/SHA256SUMS-$TS.txt"
(
  cd "$DEST"
  sha256sum "db-$TS.dump"
  if [ -n "$FILES_ARC" ]; then sha256sum "files-$TS.tar.gz"; fi
) >"$SUMS" || die "calcul SHA-256 échoué."
chmod 600 "$SUMS" || die "chmod 600 du manifeste impossible."
log "manifeste: SHA256SUMS-$TS.txt (basenames — usage direct restore.sh)"
cat "$SUMS"

log "BACKUP_OK ts=$TS db=$DB_SIZE fichiers=$NFILES"
exit 0
