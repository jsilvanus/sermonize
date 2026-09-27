#!/bin/sh
# Creates deploy/.env from deploy/.env.example with fresh random secrets.
#   sh scripts/init-env.sh <domain> [letsencrypt-email]
# Refuses to overwrite an existing .env (secrets must not change by accident: a new
# SERMONIZE_APP_DB_PASSWORD is fine, but a new POSTGRES_PASSWORD does not change the existing
# database's password; see docs/deployment.md).
set -eu

DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
EXAMPLE=$DEPLOY_DIR/.env.example
TARGET=${ENV_FILE:-$DEPLOY_DIR/.env}

if [ $# -lt 1 ]; then
  echo "usage: $0 <domain> [letsencrypt-email]" >&2
  exit 2
fi
DOMAIN=$1
EMAIL=${2:-}
case $DOMAIN in
  *[!A-Za-z0-9.-]* | '' | .* | *.) echo "invalid domain: $DOMAIN" >&2; exit 2 ;;
esac
if [ -e "$TARGET" ]; then
  echo "$TARGET exists; not overwriting it" >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

hex() { openssl rand -hex 32; }
b64() { openssl rand -base64 32; }

umask 077
tmp=$TARGET.tmp.$$
trap 'rm -f "$tmp"' EXIT
# Only lines "NAME=" with an empty value are filled; everything else is copied as is.
while IFS= read -r line || [ -n "$line" ]; do
  case $line in
    DOMAIN=) line="DOMAIN=$DOMAIN" ;;
    LETSENCRYPT_EMAIL=) line="LETSENCRYPT_EMAIL=$EMAIL" ;;
    POSTGRES_PASSWORD=) line="POSTGRES_PASSWORD=$(hex)" ;;
    SERMONIZE_APP_DB_PASSWORD=) line="SERMONIZE_APP_DB_PASSWORD=$(hex)" ;;
    MCP_JWT_SECRET=) line="MCP_JWT_SECRET=$(b64)" ;;
    MCP_TOKEN_KEY=) line="MCP_TOKEN_KEY=$(b64)" ;;
    WEB_COOKIE_SECRET=) line="WEB_COOKIE_SECRET=$(b64)" ;;
  esac
  printf '%s\n' "$line"
done < "$EXAMPLE" > "$tmp"
mv "$tmp" "$TARGET"
trap - EXIT
echo "wrote $TARGET (mode 0600); review it, and keep a copy of the secrets in your password manager"
