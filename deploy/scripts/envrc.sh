#!/usr/bin/env bash
# Code Diali — chargeur de variables .env, RÈGLES IDENTIQUES à docker compose
# (GO V4). À sourcer depuis preflight.sh / ops.sh — un seul code, mêmes règles
# des deux côtés (mesure vérifiée en préproduction, docker Compose 5.6.0) :
# - la variable d'environnement du processus gagne sur le fichier ;
# - dans le fichier, la DERNIÈRE ligne gagne en cas de doublons ;
# - une variable déjà définie (même vide) n'est jamais remplacée par le
#   fichier : vide = échec, aucun repli silencieux ;
# - seules les clés KEY=VALUE simples sont lues, sans évaluation shell
#   (aucun code exécuté depuis le .env).
#
# Fichier lu : <dossier du script>/../.env (deploy/.env, ou l'arbre préprod
# équivalent — preprod-ops/.env). Absent = aucun chargement : env du
# conteneur / de Coolify seule.
#
# NB : les valeurs chargées sont des variables de shell NON exportées — chaque
# script ne s'en sert que pour ses propres contrôles ; docker compose relit
# lui-même le même .env (via --project-directory) avec la même règle.

_ih_envrc_scriptdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_ih_envrc_file="$(cd "$_ih_envrc_scriptdir/.." && pwd)/.env"

if [ -f "$_ih_envrc_file" ]; then
  declare -A _ih_proc_env=()
  while IFS= read -r _ih_k; do
    _ih_proc_env["$_ih_k"]=1
  done < <(compgen -e)

  while IFS= read -r _ih_line || [ -n "$_ih_line" ]; do
    case "$_ih_line" in '' | '#'*) continue ;; esac
    if [[ "$_ih_line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      _ih_key="${BASH_REMATCH[1]}"
      _ih_val="${BASH_REMATCH[2]}"
      if [[ "$_ih_val" =~ ^\"(.*)\"$ ]] || [[ "$_ih_val" =~ ^\'(.*)\'$ ]]; then
        _ih_val="${BASH_REMATCH[1]}"
      fi
      if [ -z "${_ih_proc_env[$_ih_key]:-}" ]; then
        printf -v "$_ih_key" '%s' "$_ih_val" # dernière ligne du fichier gagne
      fi
    fi
  done < "$_ih_envrc_file"
fi
unset _ih_envrc_scriptdir _ih_envrc_file _ih_line _ih_k _ih_key _ih_val
