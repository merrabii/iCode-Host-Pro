#!/usr/bin/env bash
# Code Diali — chargeur de variables .env, PARITÉ COMPOSE vérifiée (GO V5).
# À sourcer depuis preflight.sh / ops.sh (UN seul code des deux côtés).
#
# RÈGLES EMPIRIQUES (docker compose v5.6.0, tests /tmp/ihp-envrc-empirique,
# journaux recette/logs/envrc-parite-*.txt) — sous-ensemble PRIS EN CHARGE :
# - variable d'environnement du processus (même vide) gagne sur le fichier ;
# - dans le fichier, la DERNIÈRE ligne gagne en cas de doublon ;
# - clés [A-Za-z_][A-Za-z0-9_]*, « export » facultatif, espaces autour de « = » ;
# - guillemets simples/doubles OUVRANTS+FERMANTS : retraits des guillemets
#   (les échappements DANS les guillemets doubles ne sont PAS reproduits) ;
# - valeur non guillemetée : trim des espaces de bord + commentaire inline
#   « espace # » retiré (« # » sans espace = valeur, conforme compose) ;
# - aucun contenu n'est JAMAIS exécuté (aucun eval/source du fichier).
#
# REFUS EXPLICITE AVANT TOUTE ACTION (exit via retour 2, jamais d'exécution)
# — syntaxes dont compose ferait un traitement que ce chargeur ne reproduit
# PAS, pour éviter TOUTE divergence de valeur validée vs valeur injectée :
# - valeur contenant « $ » (interpolation compose ${VAR}, $VAR) ;
# - contenant « \ » à l'intérieur de guillemets (échappements \" \n ...) ;
# - ligne qui n'est ni vide, ni commentaire, ni KEY=VALUE valide
#   (guillemets non refermés, syntaxe inconnue).
# Un refus = appelant doit abandonner : aucune opération, aucun conteneur.
#
# Fichier lu : <dossier du script>/../.env (deploy/.env). Absent = aucun
# chargement (env du processus / de Coolify seule).
# Les clés interdites sont affichées, les VALEURS JAMAIS (secrets).

_ih_envrc_status=0

_ih_envrc_fail() {
  printf '[envrc][ERREUR] %s (fichier: %s, ligne: %s) — aucune opération exécutée, abandon avant action.\n' \
    "$1" "${_ih_envrc_file:-?}" "${_ih_line_no:-?}" >&2
  _ih_envrc_status=2
  return 2
}

_ih_envrc_scriptdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_ih_envrc_file="$(cd "$_ih_envrc_scriptdir/.." && pwd)/.env"

if [ -f "$_ih_envrc_file" ]; then
  declare -A _ih_proc_env=()
  while IFS= read -r _ih_k; do
    _ih_proc_env["$_ih_k"]=1
  done < <(compgen -e)

  _ih_line_no=0
  while IFS= read -r _ih_line || [ -n "$_ih_line" ]; do
    _ih_line_no=$((_ih_line_no + 1))
    case "$_ih_line" in '' | '#'*) continue ;; esac

    # « export » facultatif (compose le supporte), espaces tolérés avant la
    # clé (conforme harnais), puis KEY = VALUE.
    _ih_work="$_ih_line"
    case "$_ih_work" in
      [Ee][Xx][Pp][Oo][Rr][Tt][[:space:]]*) _ih_work="${_ih_work#*[[:space:]]}" ;;
    esac
    _ih_work="${_ih_work#"${_ih_work%%[![:space:]]*}"}"
    if [[ ! "$_ih_work" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      _ih_envrc_fail "syntaxe non prise en charge (KEY=VALUE attendu)"
      break
    fi
    _ih_key="${BASH_REMATCH[1]}"
    _ih_raw="${BASH_REMATCH[2]}"

    # REFUS 1 : interpolation compose ($ où que ce soit) — non reproduite.
    case "$_ih_raw" in
      *'$'*)
        _ih_envrc_fail "syntaxe non prise en charge : interpolation « \$ » dans la valeur de $_ih_key (remplacez-la par une valeur littérale)"
        break
        ;;
    esac

    _ih_val=""
    case "$_ih_raw" in
      \"*\")
        _ih_inner="${_ih_raw#\"}"
        _ih_inner="${_ih_inner%\"}"
        case "$_ih_inner" in
          *'\'*)
            _ih_envrc_fail "syntaxe non prise en charge : « \\ » dans la valeur guillemet-double de $_ih_key (échappements non reproduits)"
            break
            ;;
          *'"'*)
            _ih_envrc_fail "syntaxe non prise en charge : guillemet interne dans la valeur de $_ih_key"
            break
            ;;
        esac
        _ih_val="$_ih_inner"
        ;;
      \'*\')
        _ih_inner="${_ih_raw#\'}"
        _ih_inner="${_ih_inner%\'}"
        _ih_val="$_ih_inner"
        ;;
      \"* | \'*)
        _ih_envrc_fail "syntaxe non prise en charge : guillemets non refermés pour $_ih_key"
        break
        ;;
      *)
        # Non guillemeté : trim gauche, commentaire inline « # » (après un
        # espace et du contenu) retire, trim droite — ordre et résultats
        # conformes aux tests compose v5.6 (harnais recette/scripts/opsv5-parite.sh).
        # Une valeur COMMENÇANT par « # » reste une valeur (compose fait de même).
        _ih_raw="${_ih_raw#"${_ih_raw%%[![:space:]]*}"}"
        if [[ "$_ih_raw" =~ ^(.*[^[:space:]])[[:space:]]+#.*$ ]]; then
          _ih_raw="${BASH_REMATCH[1]}"
        fi
        _ih_raw="${_ih_raw%"${_ih_raw##*[![:space:]]}"}"
        _ih_val="$_ih_raw"
        ;;
    esac

    if [ -z "${_ih_proc_env[$_ih_key]:-}" ]; then
      printf -v "$_ih_key" '%s' "$_ih_val" # dernière ligne du fichier gagne
    fi
  done < "$_ih_envrc_file"
fi
unset _ih_envrc_scriptdir _ih_envrc_file _ih_line _ih_line_no _ih_k _ih_key _ih_val _ih_raw _ih_inner _ih_work _ih_proc_env
[ "$_ih_envrc_status" -eq 0 ] || return "$_ih_envrc_status"
unset _ih_envrc_status _ih_envrc_fail
return 0
