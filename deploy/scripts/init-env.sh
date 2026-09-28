#!/bin/sh
# Creates deploy/.env from deploy/.env.example for one of the two setups, with fresh random secrets.
#
#   sh scripts/init-env.sh host-nginx <domain>     Setup A: host nginx, bundled PostgreSQL
#   sh scripts/init-env.sh traefik    <domain>     Setup B: riksunsrk Traefik, shared PostgreSQL
#
# Optional environment:
#   DB=bundled|external      host-nginx only: external = no bundled db; fill in DATABASE_OWNER_URL yourself
#   ROLE_MODE=app|owner                SERMONIZE_APP_ROLE_MODE (default app: the API connects as sermonize_app)
#   DB_OWNER_URL=postgres://...        the schema owner's URL (e.g. from infra's add-app.sh)
#   DB_HOST=pg.shared.local DB_NAME=sermonize_db DB_OWNER=sermonize_user   used when DB_OWNER_URL is unset
#   TRAEFIK_TRUSTED_CIDR=...           traefik only; detected from the Traefik network when Docker can see it
#   ENV_FILE=...                       target file (default deploy/.env)
# Refuses to overwrite an existing .env: secrets must not change by accident (a new POSTGRES_PASSWORD
# does not change the password of an existing bundled database).
set -eu

DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
EXAMPLE=$DEPLOY_DIR/.env.example
TARGET=${ENV_FILE:-$DEPLOY_DIR/.env}

usage() { echo "usage: $0 host-nginx|traefik <domain>" >&2; exit 2; }
[ $# -eq 2 ] || usage
SETUP=$1
DOMAIN=$2
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
APP_PW=$(hex)
NOTES=

case $SETUP in
  host-nginx)
    COMPOSE_FILE=compose.yml:host-nginx/compose.host-nginx.yml
    DB=${DB:-bundled}
    ;;
  traefik)
    COMPOSE_FILE=compose.yml:traefik/compose.traefik.yml
    DB=external
    : "${DB_HOST:=pg.shared.local}" "${DB_NAME:=sermonize_db}" "${DB_OWNER:=sermonize_user}"
    ;;
  *) usage ;;
esac

POSTGRES_PASSWORD=
case $DB in
  bundled)
    COMPOSE_PROFILES=bundled-db
    POSTGRES_PASSWORD=$(hex)
    OWNER_URL=postgres://sermonize:$POSTGRES_PASSWORD@sermonize-db:5432/sermonize
    DB_HOSTPORT=sermonize-db:5432 DB_NAME=sermonize
    ;;
  external)
    COMPOSE_PROFILES=
    : "${DB_HOST:=host.docker.internal}" "${DB_NAME:=sermonize}" "${DB_OWNER:=sermonize}"
    OWNER_URL=${DB_OWNER_URL:-postgres://$DB_OWNER:CHANGE_ME@$DB_HOST:5432/$DB_NAME}
    # host:port/dbname of the owner URL, for the app URL.
    DB_HOSTPORT=$(printf '%s' "$OWNER_URL" | sed -n 's|^postgres[a-z]*://[^@]*@\([^/]*\)/.*|\1|p')
    DB_NAME=$(printf '%s' "$OWNER_URL" | sed -n 's|^postgres[a-z]*://[^@]*@[^/]*/\([^?]*\).*|\1|p')
    [ -n "$DB_HOSTPORT" ] && [ -n "$DB_NAME" ] || { echo "cannot parse DB_OWNER_URL" >&2; exit 2; }
    case $OWNER_URL in *CHANGE_ME*) NOTES="$NOTES
- Put the schema owner's password into DATABASE_OWNER_URL (replace CHANGE_ME)." ;; esac
    ;;
  *) echo "DB must be bundled or external" >&2; exit 2 ;;
esac

ROLE_MODE=${ROLE_MODE:-app}
case $ROLE_MODE in
  app) APP_URL=postgres://sermonize_app:$APP_PW@$DB_HOSTPORT/$DB_NAME ;;
  owner) APP_URL=$OWNER_URL ;;
  *) echo "ROLE_MODE must be app or owner" >&2; exit 2 ;;
esac
if [ "$ROLE_MODE" = app ] && [ "$DB" = external ]; then
  # The bundled db's owner is a superuser; an external owner usually is not. migrate creates sermonize_app
  # itself when the owner may create roles, otherwise it stops and prints the SQL below.
  OWNER_NAME=$(printf '%s' "$OWNER_URL" | sed -n 's|^postgres[a-z]*://\([^:@]*\).*|\1|p')
  NOTES="$NOTES
- The API connects as sermonize_app. Unless the schema owner ($OWNER_NAME) is a superuser or has CREATEROLE,
  a database administrator does ONE of these once (docs/deployment.md, \"Database roles\"):
  a) let the owner create roles (PostgreSQL >= 16: it can then manage only the roles it creates); migrate then
     creates sermonize_app and keeps its password in sync with DATABASE_APP_URL:
       ALTER ROLE \"$OWNER_NAME\" CREATEROLE;
  b) create the role (migrate then applies the grants and never changes the role or its password):
       CREATE ROLE sermonize_app LOGIN PASSWORD '$APP_PW';
       GRANT CONNECT ON DATABASE \"$DB_NAME\" TO sermonize_app;"
fi

TRUSTED_CIDR=
if [ "$SETUP" = traefik ]; then
  TRUSTED_CIDR=${TRAEFIK_TRUSTED_CIDR:-}
  if [ -z "$TRUSTED_CIDR" ] && command -v docker >/dev/null 2>&1; then
    TRUSTED_CIDR=$(docker network inspect "${TRAEFIK_NETWORK:-traefik-public}" \
      -f '{{range .IPAM.Config}}{{.Subnet}},{{end}}' 2>/dev/null | sed 's/,$//') || TRUSTED_CIDR=
  fi
  [ -n "$TRUSTED_CIDR" ] || NOTES="$NOTES
- Set TRAEFIK_TRUSTED_CIDR to the Traefik network's subnet:
    docker network inspect ${TRAEFIK_NETWORK:-traefik-public} -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}'"
fi

export SET_COMPOSE_FILE="$COMPOSE_FILE" SET_COMPOSE_PROFILES="$COMPOSE_PROFILES" SET_DOMAIN="$DOMAIN" \
  SET_DATABASE_OWNER_URL="$OWNER_URL" SET_DATABASE_APP_URL="$APP_URL" SET_SERMONIZE_APP_ROLE_MODE="$ROLE_MODE" \
  SET_POSTGRES_PASSWORD="$POSTGRES_PASSWORD" SET_MCP_JWT_SECRET="$(b64)" SET_MCP_TOKEN_KEY="$(b64)" \
  SET_WEB_COOKIE_SECRET="$(b64)" SET_TRAEFIK_TRUSTED_CIDR="$TRUSTED_CIDR"
[ -z "${TRAEFIK_NETWORK:-}" ] || export SET_TRAEFIK_NETWORK="$TRAEFIK_NETWORK"
[ -z "${SHARED_NETWORK:-}" ] || export SET_SHARED_NETWORK="$SHARED_NETWORK"

umask 077
tmp=$TARGET.tmp.$$
trap 'rm -f "$tmp"' EXIT
# Replaces the value of every NAME= line for which SET_NAME is exported; copies everything else.
awk '{
  if (match($0, /^[A-Z_][A-Z0-9_]*=/)) {
    name = substr($0, 1, RLENGTH - 1)
    if (("SET_" name) in ENVIRON) { print name "=" ENVIRON["SET_" name]; next }
  }
  print
}' "$EXAMPLE" > "$tmp"
mv "$tmp" "$TARGET"
trap - EXIT
echo "wrote $TARGET (mode 0600) for setup $SETUP; review it, and keep a copy of the secrets in your password manager"
if [ -n "$NOTES" ]; then
  printf 'Still to do:%s\n' "$NOTES"
fi
