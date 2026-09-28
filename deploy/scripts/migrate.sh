#!/bin/sh
# Installed in the tools image as /usr/local/bin/sermonize-migrate; run by the compose service `migrate`
# on every `docker compose up`. Idempotent: safe to run on every start and after every upgrade.
#
#   1. checks that pgvector is installed or installable (CREATE EXTENSION vector needs a superuser: on a
#      shared server an administrator creates it once, see docs/deployment.md),
#   2. applies pending migrations as the schema owner (DATABASE_OWNER_URL),
#   3. withdraws PUBLIC access to the private schema (again; also after a restore without ACLs),
#   4. handles the API's role according to SERMONIZE_APP_ROLE_MODE:
#        app    (default) the API connects as the least-privileged sermonize_app (sql/roles.sql). migrate
#               looks at the database and takes one of these paths (the log says which):
#               a. sermonize_app exists and the owner can manage it (superuser, or CREATEROLE with ADMIN
#                  OPTION on it, which a CREATEROLE owner gets on PostgreSQL >= 16 for roles it created):
#                  grants (roles.sql), CONNECT, and its password from DATABASE_APP_URL, so rotating it is
#                  "edit .env, docker compose up -d";
#               b. sermonize_app exists and someone else manages it (an administrator created it): grants
#                  and CONNECT only; the role and its password are left unchanged;
#               c. sermonize_app is missing and the owner may create roles (superuser or CREATEROLE):
#                  roles.sql creates it, CONNECT, password from DATABASE_APP_URL;
#               d. sermonize_app is missing and the owner may not create roles: stops with the one-time SQL
#                  for an administrator.
#        owner  nothing: the API connects as the schema owner (DATABASE_APP_URL = DATABASE_OWNER_URL).
#      The old values managed and external are accepted as deprecated aliases of app.
#   5. checks that DATABASE_APP_URL can connect.
set -eu

: "${DATABASE_OWNER_URL:?DATABASE_OWNER_URL is required (the schema owner)}"
: "${DATABASE_APP_URL:?DATABASE_APP_URL is required (the API's connection)}"
MODE=${SERMONIZE_APP_ROLE_MODE:-app}
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
  app | owner) ;;
  managed | external)
    log "warning: SERMONIZE_APP_ROLE_MODE=$MODE is deprecated; it now means 'app' (set SERMONIZE_APP_ROLE_MODE=app in deploy/.env)"
    MODE=app
    ;;
  *) die "SERMONIZE_APP_ROLE_MODE must be app or owner (got '$MODE')" ;;
esac

APP_USER=$(url_part username) || die "DATABASE_APP_URL is not a valid URL"
case $MODE in
  app)
    [ "$APP_USER" = "$APP_ROLE" ] || die "with SERMONIZE_APP_ROLE_MODE=app, DATABASE_APP_URL must connect as $APP_ROLE (got '$APP_USER')"
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
    die "the PostgreSQL server has no pgvector extension (\"vector\" is not in pg_available_extensions).
The server itself must have pgvector installed:
  - bundled or own server: use an image that ships it, e.g. pgvector/pgvector:0.8.1-pg16;
  - shared PostgreSQL (e.g. riksunsrk infra): the official postgres:16 image does NOT include pgvector; the
    server image must install the package postgresql-16-pgvector (or be pgvector/pgvector:0.8.1-pg16),
    then a superuser runs once: psql -U postgres -d $DBNAME -c 'CREATE EXTENSION IF NOT EXISTS vector'.
See docs/deployment.md (\"Database roles and migrations\")."
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

grant_connect() {
  owner_psql -c "DO \$\$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO $APP_ROLE', current_database()); END \$\$"
}
apply_roles_sql() {
  owner_psql -f "$APP_DIR/sql/roles.sql" || die "roles.sql failed (grants for $APP_ROLE)"
  grant_connect
}
check_app_password() {
  SERMONIZE_APP_DB_PASSWORD=$(url_part password)
  [ "${#SERMONIZE_APP_DB_PASSWORD}" -ge 16 ] || die "the password in DATABASE_APP_URL must be at least 16 characters"
}
set_app_password() {
  export SERMONIZE_APP_DB_PASSWORD
  # psql reads the password from the environment (\getenv) and quotes it (:'var'): it never appears on
  # a command line and is never spliced into SQL by the shell.
  owner_psql <<'SQL' || die "cannot set the password of $APP_ROLE"
\getenv sermonize_app_password SERMONIZE_APP_DB_PASSWORD
ALTER ROLE sermonize_app WITH LOGIN PASSWORD :'sermonize_app_password';
SQL
  unset SERMONIZE_APP_DB_PASSWORD
}

APP_PATH=
if [ "$MODE" = app ]; then
  # exists, owner is superuser, owner has CREATEROLE, owner can manage the existing role (superuser, or
  # CREATEROLE + ADMIN OPTION on it: on PostgreSQL >= 16 ALTER ROLE ... PASSWORD needs both).
  roles=$(owner_psql -At -F ' ' -c "
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE'), o.rolsuper, o.rolcreaterole,
           CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE') THEN false
                WHEN o.rolsuper THEN true
                ELSE o.rolcreaterole AND pg_has_role(current_user, '$APP_ROLE', 'USAGE WITH ADMIN OPTION') END
    FROM pg_roles o WHERE o.rolname = current_user") || die "cannot read the role attributes of $OWNER"
  set -- $roles
  APP_EXISTS=$1 OWNER_CREATEROLE=$3 CAN_MANAGE=$4
  [ "$IS_SUPER" = t ] && OWNER_CREATEROLE=t
  if [ "$APP_EXISTS" = t ] && [ "$CAN_MANAGE" = t ]; then
    APP_PATH=sync
    check_app_password
    log "$APP_ROLE exists and $OWNER can manage it: applying grants (roles.sql), CONNECT, and syncing its password from DATABASE_APP_URL"
    apply_roles_sql
    set_app_password
  elif [ "$APP_EXISTS" = t ]; then
    APP_PATH=untouched
    log "$APP_ROLE exists and is managed outside Sermonize ($OWNER may not alter it): applying grants (roles.sql) and CONNECT only"
    apply_roles_sql
    log "$APP_ROLE: role and password left unchanged. To rotate the password, whoever manages the role runs
    ALTER ROLE $APP_ROLE PASSWORD '<new>';
and DATABASE_APP_URL is updated to match. Or, if $OWNER has CREATEROLE: a superuser drops the role (in database
$DBNAME: DROP OWNED BY $APP_ROLE; DROP ROLE $APP_ROLE;) and the next run recreates it with the password from
DATABASE_APP_URL and keeps it in sync from then on."
  elif [ "$OWNER_CREATEROLE" = t ]; then
    APP_PATH=created
    check_app_password
    log "$APP_ROLE does not exist; $OWNER may create roles: creating it (roles.sql), CONNECT, password from DATABASE_APP_URL"
    apply_roles_sql
    set_app_password
  else
    die "role $APP_ROLE does not exist, and $OWNER may not create roles (neither superuser nor CREATEROLE).
Either a database administrator (superuser or CREATEROLE) creates it once, with the password from DATABASE_APP_URL:
    CREATE ROLE $APP_ROLE LOGIN PASSWORD '<the password in DATABASE_APP_URL>';
    GRANT CONNECT ON DATABASE \"$DBNAME\" TO $APP_ROLE;
or a superuser allows $OWNER to create roles (safe on PostgreSQL >= 16: a CREATEROLE role can only manage the
roles it created), after which migrate creates $APP_ROLE and keeps its password in sync with DATABASE_APP_URL:
    ALTER ROLE \"$OWNER\" CREATEROLE;
(or SERMONIZE_APP_ROLE_MODE=owner, with weaker isolation). See docs/deployment.md, \"Database roles\".
Then run the migrations again (docker compose up -d)."
  fi
else
  log "SERMONIZE_APP_ROLE_MODE=owner: the API connects as $OWNER (no separate least-privileged role; weaker isolation)"
fi

log "checking DATABASE_APP_URL"
if ! psql "$DATABASE_APP_URL" -X -q -At -c 'SELECT 1' > /dev/null; then
  if [ "$APP_PATH" = untouched ]; then
    die "the API cannot connect with DATABASE_APP_URL. $APP_ROLE is managed outside Sermonize, so its password must be
the one in DATABASE_APP_URL (ALTER ROLE $APP_ROLE LOGIN PASSWORD '...' by whoever manages it), or the connection
is refused (pg_hba.conf)."
  fi
  die "the API cannot connect with DATABASE_APP_URL (wrong password? missing CONNECT privilege? pg_hba.conf?)"
fi

log "done"
