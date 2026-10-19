#!/usr/bin/env bash
# Code Diali — canonicalisation + gardes des chemins HÔTE (GO V5 §4).
# À sourcer. Un seul code utilisé pour la validation ET pour fournir le
# chemin réellement monté (preflight valide, ops.sh exporte la valeur
# canonicalisée AVANT docker compose → montage = chemin validé).
#
# Règles (avant toute mutation) :
# - absolu exigé ;
# - refus littéral : « / », « // », « /nonexistent » ;
# - existence (realpath -e échoue sinon) et répertoire exigés ;
# - CANONICALISATION realpath (résout ., .., doubles barres, liens
#   symboliques) PUIS re-refus de la racine réelle : « /tmp/.. », « // » ou
#   lien symbolique vers « / » convergent vers « / » = refusé ;
# - destinations interdites refusées après canonicalisation :
#   / /nonexistent /proc /sys /dev /etc ;
# - messages : nom de variable + chemin (jamais de secret dans ces variables).

ih_paths_canon() {
  local name="$1" v canon
  v="${!name:-}"
  if [ -z "$v" ]; then
    printf '[paths][ERREUR] %s : valeur absente — aucune opération exécutée.\n' "$name" >&2
    return 1
  fi
  case "$v" in
    //*)
      printf '[paths][ERREUR] %s = %s : chemin refusé (« // » interdit).\n' "$name" "$v" >&2
      return 1
      ;;
    /*) : ;;
    *)
      printf '[paths][ERREUR] %s = %s : chemin hôte ABSOLU attendu.\n' "$name" "$v" >&2
      return 1
      ;;
  esac
  case "$v" in
    / | /nonexistent)
      printf '[paths][ERREUR] %s = %s : chemin refusé (« / » ni « /nonexistent » ne sont jamais montés).\n' "$name" "$v" >&2
      return 1
      ;;
  esac
  if [ ! -e "$v" ]; then
    printf '[paths][ERREUR] %s = %s : introuvable — créez-le d’abord (mkdir -p %q && chmod 700 %q).\n' \
      "$name" "$v" "$v" "$v" >&2
    return 1
  fi
  if [ ! -d "$v" ]; then
    printf '[paths][ERREUR] %s = %s : existe mais n’est pas un répertoire.\n' "$name" "$v" >&2
    return 1
  fi
  canon="$(realpath -e -- "$v")" || {
    printf '[paths][ERREUR] %s = %s : canonicalisation impossible.\n' "$name" "$v" >&2
    return 1
  }
  case "$canon" in
    / | /nonexistent | /proc | /sys | /dev | /etc)
      printf '[paths][ERREUR] %s = %s : canonicalisé %s → destination interdite refusée (racine/%s).\n' \
        "$name" "$v" "$canon" "$canon" >&2
      return 1
      ;;
  esac
  printf -v "$name" '%s' "$canon"
  return 0
}
