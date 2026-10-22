#!/usr/bin/env bash
# Code Diali — génération du certificat auto-signé préproduction (GO V3).
#
# Ce script génère un certificat X.509 auto-signé pour l'accès HTTPS direct.
# Il ne produit AUCUN secret dans le dépôt — le certificat et la clé sont
# écrits sur la VM préproduction uniquement.
#
# Usage (sur la VM préproduction) :
#   ./deploy/scripts/gen-preprod-cert.sh <IP-ou-domaine>   # argument OBLIGATOIRE
#
# - AUCUN repli : sans argument = usage error exit 2 (jamais d'IP de VM de test
#   en dur, jamais de certificat généré pour une cible non demandée).
# - IP = SAN « IP: » ; domaine = SAN « DNS: » (détecté automatiquement).
# - Chemin de sortie configurable : CERT_DIR (env), défaut
#   ${PREPROD_PROXY_DIR:-/home/mourad/preprod-proxy}/certs.
#
# Le certificat exporté pour le PC (à importer manuellement) est copié dans
# $CERT_DIR/server.crt — voir la procédure d'import.

set -euo pipefail

if [ $# -lt 1 ] || [ -z "${1:-}" ]; then
  echo "[cert][ERREUR] IP ou domaine obligatoire — aucun repli de cible." >&2
  echo "[cert][ERREUR] Usage : $0 <IP-ou-domaine>   (ex. : $0 203.0.113.7)" >&2
  echo "[cert][ERREUR] Sortie configurable : CERT_DIR ou PREPROD_PROXY_DIR (défaut /home/mourad/preprod-proxy)." >&2
  exit 2
fi

IP="$1"
CERT_DIR="${CERT_DIR:-${PREPROD_PROXY_DIR:-/home/mourad/preprod-proxy}/certs}"
DAYS=3650

if [[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  SAN="IP:$IP"
else
  SAN="DNS:$IP"
fi

mkdir -p "$CERT_DIR"

echo "[cert] génération du certificat auto-signé pour $IP (SAN=$SAN, validité ${DAYS} jours)..."
echo "[cert] sortie : $CERT_DIR"

openssl req -x509 -newkey rsa:4096 -nodes -days "$DAYS" \
  -keyout "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.crt" \
  -subj "/CN=$IP" \
  -addext "subjectAltName=$SAN"

chmod 600 "$CERT_DIR/server.key"
chmod 644 "$CERT_DIR/server.crt"

echo "[cert] certificat généré :"
openssl x509 -in "$CERT_DIR/server.crt" -noout -subject -dates -fingerprint -sha256

echo ""
echo "[cert] EMPREINTE SHA-256 (à conserver pour vérification) :"
openssl x509 -in "$CERT_DIR/server.crt" -noout -fingerprint -sha256

echo ""
echo "[cert] Pour exporter le certificat sur le PC (import manuel) :"
echo "  scp user@${IP}:${CERT_DIR}/server.crt ./preprod-cert-${IP}.crt"
echo ""
echo "[cert] Procédure d'import sur le PC (manuelle, aucune installation silencieuse) :"
echo "  1. Double-clic sur le fichier .crt"
echo "  2. Propriétés → Certificat → Voir le certificat"
echo "  3. Installer le certificat → Magasin 'Autorité de certification racine de confiance'"
echo "  4. Suivre l'assistant jusqu'à la fin"
