#!/bin/sh
# Installed in the tools image as /usr/local/bin/sermonize-migrate; run by the compose service `migrate`
# on every `docker compose up`. Idempotent: safe to run on every start and after every upgrade.
#
#   1. checks that pgvector is installed or installable (CREATE EXTENSION vector needs a superuser: on a
#      shared server an administrator creates it once, see docs/deployment.md),
#   2. applies pending migrations as the schema owner (DATABASE_OWNER_URL),
#   3. withdraws PUBLIC access to the private schema (again; also after a restore without ACLs),
#   4. handles the API's role according to SERMONIZE_APP_ROLE_MODE:
#        managed   sql/roles.sql (creates/refreshes sermonize_app and its grants), then sermonize_app's
#                  password from DATABASE_APP_URL. The owner must be allowed to create roles.
#        external  sermonize_app must already exist (created once by an administrator); applies the grants
#                  (sql/roles.sql, whose CREATE ROLE is skipped for an existing role) and CONNECT. Never
#                  changes the role or its password.
#        owner     nothing: the API connects as the schema owner (DATABASE_APP_URL = DATABASE_OWNER_URL).
#   5. checks that DATABASE_APP_URL can connect.
set -eu

: "${DATABASE_OWNER_URL:?DATABASE_OWNER_URL is required (the schema owner)}"
: "${DATABASE_APP_URL:?DATABASE_APP_URL is required (the API's connection)}"
MODE=${SERMONIZE_APP_ROLE_MODE:-managed}
APP_DIR=${APP_DIR:-/app/packages/api}
APP_ROLE=sermonize_app

log() { echo "sermonize-migrate: $*"; }
die() { echo "sermonize-migrate: ERROR: $*" >&2; exit 1; }
owner_psql() { psql "$DATABASE_OWNER_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
# Decoded user name / password of DATABASE_APP_URL (never printed, never on a command line).
url_part() {
  node -e 'const u = new URL(process.env.DATABASE_APP_URL); process.stdout.write(decodeURIComponent(u[process.argv[1]]))' "$1"
}

case $MODE in
  managed | external | owner) ;;
  *) die "SERMONIZE_APP_ROLE_MODE must be managed, external or owner (got '$MODE')" ;;
esac

APP_USER=$(url_part username) || die "DATABASE_APP_URL is not a valid URL"
case $MODE in
  managed | external)
    [ "$APP_USER" = "$APP_ROLE" ] || die "with SERMONIZE_APP_ROLE_MODE=$MODE, DATABASE_APP_URL must connect as $APP_ROLE (got '$APP_USER')"
    ;;
  owner)
    [ "$DATABASE_APP_URL" = "$DATABASE_OWNER_URL" ] ||
      log "warning: SERMONIZE_APP_ROLE_MODE=owner but DATABASE_APP_URL differs from DATABASE_OWNER_URL"
    ;;
esac

log "checking the connection and pgvector"
state=$(owner_psql -At -F ' ' -c "
  SELECT current_user, current_database(),
         EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector'),
         EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector'),
         (SELECT rolsuper FROM pg_roles WHERE rolname = current_user),
         COALESCE((SELECT bool_or(trusted) FROM pg_available_extension_versions WHERE name = 'vector'), false)") ||
  die "cannot connect as the schema owner (DATABASE_OWNER_URL)"
set -- $state
OWNER=$1 DBNAME=$2 HAS_VECTOR=$3 VECTOR_AVAILABLE=$4 IS_SUPER=$5 VECTOR_TRUSTED=$6
if [ "$HAS_VECTOR" != t ]; then
  [ "$VECTOR_AVAILABLE" = t ] ||
    die "the PostgreSQL server has no pgvector extension. Use a server image that ships it (e.g. pgvector/pgvector:0.8.1-pg16)."
  if [ "$IS_SUPER" != t ] && [ "$VECTOR_TRUSTED" != t ]; then
    die "extension \"vector\" is not installed in database $DBNAME, and $OWNER may not create it (pgvector is not a trusted extension).
A superuser must run once:
    psql -U postgres -d $DBNAME -c 'CREATE EXTENSION IF NOT EXISTS vector'
then run the migrations again (docker compose up -d)."
  fi
fi

log "migrations"
DATABASE_URL=$DATABASE_OWNER_URL node "$APP_DIR/dist/cli.js" migrate

log "private schema: no PUBLIC access"
owner_psql -c 'REVOKE ALL ON SCHEMA private FROM PUBLIC' -c 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC'

role_exists() {
  [ "$(owner_psql -At -c "SELECT count(*) FROM pg_roles WHERE rolname = '$APP_ROLE'")" = 1 ]
}
grant_connect() {
  owner_psql -c "DO \$\$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO $APP_ROLE', current_database()); END \$\$"
}

case $MODE in
  managed)
    log "roles.sql ($APP_ROLE, managed)"
    owner_psql -f "$APP_DIR/sql/roles.sql" ||
      die "roles.sql failed. SERMONIZE_APP_ROLE_MODE=managed needs an owner that may create roles; on a shared server use external (docs/deployment.md)."
    grant_connect
    log "$APP_ROLE password (from DATABASE_APP_URL)"
    SERMONIZE_APP_DB_PASSWORD=$(url_part password)
    [ "${#SERMONIZE_APP_DB_PASSWORD}" -ge 16 ] || die "the password in DATABASE_APP_URL must be at least 16 characters"
    export SERMONIZE_APP_DB_PASSWORD
    # psql reads the password from the environment (\getenv) and quotes it (:'var'): it never appears on
    # a command line and is never spliced into SQL by the shell.
    owner_psql <<'SQL' || die "cannot set the password of $APP_ROLE. SERMONIZE_APP_ROLE_MODE=managed needs an owner that may manage roles; on a shared server use external (docs/deployment.md)."
\getenv sermonize_app_password SERMONIZE_APP_DB_PASSWORD
ALTER ROLE sermonize_app WITH LOGIN PASSWORD :'sermonize_app_password';
SQL
    unset SERMONIZE_APP_DB_PASSWORD
    ;;
  external)
    role_exists || die "role $APP_ROLE does not exist. With SERMONIZE_APP_ROLE_MODE=external a database administrator creates it once:
    CREATE ROLE $APP_ROLE LOGIN PASSWORD '<the password in DATABASE_APP_URL>';
    GRANT CONNECT ON DATABASE $DBNAME TO $APP_ROLE;
(docs/deployment.md, \"Database roles\"), then run the migrations again (docker compose up -d)."
    log "roles.sql grants ($APP_ROLE, external)"
    owner_psql -f "$APP_DIR/sql/roles.sql"
    grant_connect
    ;;
  owner)
    log "SERMONIZE_APP_ROLE_MODE=owner: the API connects as $OWNER (no separate least-privileged role)"
    ;;
esac

log "checking DATABASE_APP_URL"
psql "$DATABASE_APP_URL" -X -q -At -c 'SELECT 1' > /dev/null ||
  die "the API cannot connect with DATABASE_APP_URL (wrong password? missing CONNECT privilege?)"

log "done"
