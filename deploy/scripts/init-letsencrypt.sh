#!/bin/sh
# Obtains the real Let's Encrypt certificate for DOMAIN (http-01, webroot) while nginx is running
# with the placeholder from self-signed.sh, then reloads nginx.
#   sh scripts/init-letsencrypt.sh [--staging]
# Needs: DNS of DOMAIN pointing at this host, port 80 reachable from the Internet, `docker compose up -d`.
set -eu

DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$DEPLOY_DIR"
STAGING=
if [ "${1:-}" = "--staging" ]; then STAGING=--staging; fi

DOMAIN=$(sed -n 's/^DOMAIN=//p' .env | tail -n 1)
EMAIL=$(sed -n 's/^LETSENCRYPT_EMAIL=//p' .env | tail -n 1)
[ -n "$DOMAIN" ] || { echo "DOMAIN is not set in deploy/.env" >&2; exit 2; }

LIVE=certbot/conf/live/$DOMAIN
if [ -d "$LIVE" ] && [ ! -f "$LIVE/.self-signed" ]; then
  echo "$LIVE already holds a certbot certificate; renew with:" >&2
  echo "  docker compose --profile certbot run --rm certbot renew && docker compose exec nginx nginx -s reload" >&2
  exit 1
fi

if [ -n "$EMAIL" ]; then
  set -- --email "$EMAIL"
else
  set -- --register-unsafely-without-email
fi

# certbot refuses to write into a live/ directory it did not create: move the placeholder aside
# (nginx keeps the files it already loaded until the reload below).
if [ -d "$LIVE" ]; then
  rm -rf "$LIVE.self-signed"
  mv "$LIVE" "$LIVE.self-signed"
fi

if ! docker compose --profile certbot run --rm certbot certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" "$@" --agree-tos --no-eff-email --rsa-key-size 4096 --non-interactive $STAGING; then
  echo "certbot failed; restoring the placeholder certificate" >&2
  if [ -d "$LIVE.self-signed" ] && [ ! -e "$LIVE" ]; then mv "$LIVE.self-signed" "$LIVE"; fi
  exit 1
fi
rm -rf "$LIVE.self-signed"
docker compose exec nginx nginx -t
docker compose exec nginx nginx -s reload
echo "certificate installed for $DOMAIN; nginx reloaded"
