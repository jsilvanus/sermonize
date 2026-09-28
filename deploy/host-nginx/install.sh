#!/bin/sh
# Installs (or updates) the Sermonize site into the host's nginx (Setup A, docs/deployment.md):
#   /etc/nginx/sermonize/snippets/*.conf          proxy headers, TLS profile, HSTS, security headers
#   /etc/nginx/sermonize/admin-allow.conf         optional /api/admin/ allowlist (never overwritten)
#   /etc/nginx/sites-available/sermonize.conf     the site, symlinked into sites-enabled/
#     (or /etc/nginx/conf.d/sermonize.conf where there is no sites-available/)
#   /var/www/letsencrypt                          webroot for certbot's http-01 challenges
# then `nginx -t` (the previous site file is put back if it fails) and a reload.
#
#   sudo sh deploy/host-nginx/install.sh
#
# Reads DOMAIN and WEB_HOST_PORT / API_HOST_PORT / MCP_HOST_PORT from deploy/.env. The certificate must
# already exist (see docs/deployment.md: `certbot certonly --nginx -d DOMAIN`). Environment overrides:
#   ENV_FILE   deploy/.env                         CERT_DIR   /etc/letsencrypt/live/<DOMAIN>
#   NGINX_DIR  /etc/nginx                          WEBROOT    /var/www/letsencrypt
#   NGINX_RELOAD=0  skip the reload                IPV6=0|1   listen on [::] too (default: if the host has IPv6)
#   RENDER_ONLY=<file>  only write the rendered site file there (no certificate check, nothing installed;
#                       used by CI to run `nginx -t` in a container)
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE=${ENV_FILE:-$HERE/../.env}
NGINX_DIR=${NGINX_DIR:-/etc/nginx}
WEBROOT=${WEBROOT:-/var/www/letsencrypt}

[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE (create it with deploy/scripts/init-env.sh)" >&2; exit 2; }
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }

DOMAIN=$(env_value DOMAIN)
WEB_PORT=$(env_value WEB_HOST_PORT); WEB_PORT=${WEB_PORT:-18100}
API_PORT=$(env_value API_HOST_PORT); API_PORT=${API_PORT:-18101}
MCP_PORT=$(env_value MCP_HOST_PORT); MCP_PORT=${MCP_PORT:-18102}
case $DOMAIN in
  '' | *[!A-Za-z0-9.-]* | .* | *.) echo "DOMAIN in $ENV_FILE is missing or invalid: '$DOMAIN'" >&2; exit 2 ;;
esac
for port in "$WEB_PORT" "$API_PORT" "$MCP_PORT"; do
  case $port in '' | *[!0-9]*) echo "invalid port in $ENV_FILE: '$port'" >&2; exit 2 ;; esac
done
CERT_DIR=${CERT_DIR:-/etc/letsencrypt/live/$DOMAIN}
case $CERT_DIR in *'|'* | *'&'* | *'\'*) echo "unsupported characters in CERT_DIR" >&2; exit 2 ;; esac

if [ -z "${RENDER_ONLY:-}" ] && { [ ! -f "$CERT_DIR/fullchain.pem" ] || [ ! -f "$CERT_DIR/privkey.pem" ]; }; then
  cat >&2 <<EOF
No certificate in $CERT_DIR. Obtain one first (DNS of $DOMAIN must point here, port 80 reachable):
  sudo certbot certonly --nginx -d $DOMAIN
or with any webroot the running nginx already serves on port 80 for $DOMAIN, e.g.
  sudo certbot certonly --webroot -w /var/www/html -d $DOMAIN
then run this script again (set CERT_DIR for a certificate elsewhere).
EOF
  exit 1
fi
[ -n "${RENDER_ONLY:-}" ] || command -v nginx >/dev/null 2>&1 || { echo "nginx is not installed (apt install nginx)" >&2; exit 1; }

if [ -z "${IPV6:-}" ]; then
  if [ -s /proc/net/if_inet6 ]; then IPV6=1; else IPV6=0; fi
fi

if [ -d "$NGINX_DIR/sites-available" ]; then
  SITE=$NGINX_DIR/sites-available/sermonize.conf
  LINK=$NGINX_DIR/sites-enabled/sermonize.conf
else
  SITE=$NGINX_DIR/conf.d/sermonize.conf
  LINK=
fi

umask 022
if [ -n "${RENDER_ONLY:-}" ]; then
  SITE=$RENDER_ONLY
else
  mkdir -p "$NGINX_DIR/sermonize/snippets" "$WEBROOT" "$(dirname "$SITE")"
  cp "$HERE"/snippets/*.conf "$NGINX_DIR/sermonize/snippets/"
  if [ ! -e "$NGINX_DIR/sermonize/admin-allow.conf" ]; then
    cp "$HERE/admin-allow.conf" "$NGINX_DIR/sermonize/admin-allow.conf"
  fi
fi

tmp=$SITE.new.$$
trap 'rm -f "$tmp"' EXIT
# Certificate directory first (it contains the example domain), then the domain, the ports, the webroot.
sed -e "s|/etc/letsencrypt/live/sermonize.example.org|$CERT_DIR|g" \
    -e "s|sermonize\.example\.org|$DOMAIN|g" \
    -e "s|127\.0\.0\.1:18100;|127.0.0.1:$WEB_PORT;|" \
    -e "s|127\.0\.0\.1:18101;|127.0.0.1:$API_PORT;|" \
    -e "s|127\.0\.0\.1:18102;|127.0.0.1:$MCP_PORT;|" \
    -e "s|root /var/www/letsencrypt;|root $WEBROOT;|" \
    "$HERE/sermonize.conf" > "$tmp"
if [ "$IPV6" != 1 ]; then
  sed -i '/listen \[::\]/d' "$tmp"
fi

if [ -n "${RENDER_ONLY:-}" ]; then
  mv "$tmp" "$SITE"
  trap - EXIT
  echo "rendered $SITE"
  exit 0
fi

backup=
if [ -f "$SITE" ]; then
  backup=$SITE.bak
  cp -p "$SITE" "$backup"
fi
mv "$tmp" "$SITE"
trap - EXIT
if [ -n "$LINK" ]; then
  mkdir -p "$(dirname "$LINK")"
  ln -sfn "$SITE" "$LINK"
fi

if ! nginx -t; then
  echo "nginx -t failed; putting the previous configuration back" >&2
  if [ -n "$backup" ]; then
    mv "$backup" "$SITE"
  else
    rm -f "$SITE" ${LINK:+"$LINK"}
  fi
  exit 1
fi
rm -f "$backup"

if [ "${NGINX_RELOAD:-1}" = 1 ]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx 2>/dev/null; then
    systemctl reload nginx
  else
    nginx -s reload
  fi
  echo "installed $SITE for $DOMAIN (web :$WEB_PORT, api :$API_PORT, mcp :$MCP_PORT); nginx reloaded"
else
  echo "installed $SITE for $DOMAIN (web :$WEB_PORT, api :$API_PORT, mcp :$MCP_PORT); reload nginx yourself"
fi
