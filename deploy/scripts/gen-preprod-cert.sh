#!/usr/bin/env bash
# Code Diali — génération du certificat auto-signé préproduction (GO V3).
#
# Ce script génère un certificat X.509 auto-signé pour l'accès HTTPS direct.
# Il ne produit AUCUN secret dans le dépôt — le certificat et la clé sont
# écrits sur la VM préproduction uniquement.
#
# Usage (sur la VM préproduction) :
#   ./deploy/scripts/gen-preprod-cert.sh [IP]
#
# Le certificat exporté pour le PC (à importer manuellement) est copié dans
# /home/mourad/preprod-proxy/certs/server.crt — voir la procédure d'import.

set -euo pipefail

IP="${1:-172.17.79.197}"
CERT_DIR="/home/mourad/preprod-proxy/certs"
DAYS=3650

mkdir -p "$CERT_DIR"

echo "[cert] génération du certificat auto-signé pour IP=$IP (validité ${DAYS} jours)..."

openssl req -x509 -newkey rsa:4096 -nodes -days "$DAYS" \
  -keyout "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.crt" \
  -subj "/CN=$IP" \
  -addext "subjectAltName=IP:$IP"

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
