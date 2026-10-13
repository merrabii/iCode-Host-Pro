#!/usr/bin/env bash
# Code Diali — conversion contrôlée d'une URL Prisma vers les outils PostgreSQL.
#
# Une URL Prisma (postgresql://user:pass@host:port/db?<options>) peut porter des
# options que libpq (pg_dump/pg_restore/psql) NE comprend PAS (?schema=public…) :
# les outils pg_* refusent alors l'URL. Ce module retire UNIQUEMENT les options
# connues Prisma non-comprises de libpq, PRÉSERVE les paramètres libpq utiles
# (sslmode, connect_timeout, application_name…), et REFUSE (code 2) toute option
# inconnue plutôt que de modifier silencieusement la connexion.
# L'URL complète et le mot de passe ne sont JAMAIS affichés par ce module.
#
# Usage : source ce fichier puis `pg_conn_convert "$URL"`.
# Retourne l'URL convertie sur stdout ; code 2 = refus/invalide.

# Options connues Prisma NON comprises par libpq -> retirées de la query string.
# (source : documentation Prisma — URL "Connection URL" options)
_PG_CONN_PRISMA_OPTS="schema connection_limit pool_timeout pgbouncer socket_timeout keep_alive preview_features direct_url"

# Paramètres libpq reconnus dans une query string -> préservés tels quels.
_PG_CONN_LIBPQ_OPTS="sslmode sslrootcert sslcert sslkey sslpassword sslcompression connect_timeout keepalives keepalives_idle keepalives_interval keepalives_count target_session_attrs gssencmode channel_binding application_name options fallback_application_name service statements_timeout lock_timeout idle_in_transaction_session_timeout"

pg_conn_convert() {
  local url="$1"
  case "$url" in
    postgresql://*|postgres://*) : ;;
    *)
      echo "[pg-conn][ERREUR] DATABASE_URL invalide (postgresql:// ou postgres:// attendu) — refus." >&2
      return 2
      ;;
  esac

  local base="${url%%\?*}"
  if [ "$base" = "$url" ]; then
    printf '%s' "$base"
    return 0
  fi

  local query="${url#*\?}"
  [ -n "$query" ] || { printf '%s' "$base"; return 0; }

  local out="" pair key val
  local old_ifs="$IFS"
  IFS='&'
  for pair in $query; do
    IFS="$old_ifs"
    [ -n "$pair" ] || continue
    case "$pair" in
      *=*) key="${pair%%=*}"; val="${pair#*=}" ;;
      *)
        echo "[pg-conn][ERREUR] option de query string mal formée — refus de convertir." >&2
        return 2
        ;;
    esac
    if ! printf '%s' "$key" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$'; then
      echo "[pg-conn][ERREUR] nom d'option invalide — refus de convertir." >&2
      return 2
    fi
    case " $_PG_CONN_PRISMA_OPTS " in
      *" $key "*) continue ;; # option Prisma : retirée (volontairement)
    esac
    case " $_PG_CONN_LIBPQ_OPTS " in
      *" $key "*) out="${out:+$out&}$key=$val"; continue ;; # paramètre libpq : préservé
    esac
    echo "[pg-conn][ERREUR] option '$key' non prise en charge (ni Prisma connue, ni libpq) — refus plutôt que modification silencieuse de la connexion." >&2
    return 2
  done
  IFS="$old_ifs"

  if [ -n "$out" ]; then
    printf '%s?%s' "$base" "$out"
  else
    printf '%s' "$base"
  fi
  return 0
}

# Masque un mot de passe d'URL pour journalisation (jamais l'URL complète).
pg_conn_mask() {
  printf '%s' "$1" | sed -E 's#//([^:/@]+):[^@]*@#//\1:***@#'
}
