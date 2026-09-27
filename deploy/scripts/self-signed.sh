#!/bin/sh
# Creates a self-signed placeholder certificate where nginx expects the Let's Encrypt one
# (deploy/certbot/conf/live/<DOMAIN>/{fullchain,privkey}.pem), so nginx can start before the
# real certificate exists (first boot) or for local testing. scripts/init-letsencrypt.sh replaces it.
#   sh scripts/self-signed.sh [domain]      (default: DOMAIN from deploy/.env)
# Does nothing if a certificate is already there (pass --force to replace it).
set -eu

DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; shift; fi
DOMAIN=${1:-}
if [ -z "$DOMAIN" ] && [ -f "$DEPLOY_DIR/.env" ]; then
  DOMAIN=$(sed -n 's/^DOMAIN=//p' "$DEPLOY_DIR/.env" | tail -n 1)
fi
[ -n "$DOMAIN" ] || { echo "usage: $0 [--force] <domain>  (or set DOMAIN in deploy/.env)" >&2; exit 2; }
case $DOMAIN in *[!A-Za-z0-9.-]*) echo "invalid domain: $DOMAIN" >&2; exit 2 ;; esac
command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

LIVE=${CERT_DIR:-$DEPLOY_DIR/certbot/conf}/live/$DOMAIN
mkdir -p "$LIVE" "$DEPLOY_DIR/certbot/www"
if [ -f "$LIVE/fullchain.pem" ] && [ "$FORCE" -ne 1 ]; then
  echo "$LIVE/fullchain.pem exists; leaving it (use --force to replace)"
  exit 0
fi

umask 077
openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
  -keyout "$LIVE/privkey.pem" -out "$LIVE/fullchain.pem" \
  -subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN" >/dev/null 2>&1
chmod 0644 "$LIVE/fullchain.pem"
# Marker for init-letsencrypt.sh: this directory is a placeholder, not certbot's.
: > "$LIVE/.self-signed"
echo "self-signed certificate for $DOMAIN in $LIVE (valid 30 days)"
