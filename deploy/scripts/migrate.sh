#!/bin/sh
# Installed in the tools image as /usr/local/bin/sermonize-migrate; run by the compose service `migrate`.
#   1. applies pending migrations as the schema owner (OWNER_DATABASE_URL),
#   2. applies sql/roles.sql (creates/refreshes the least-privileged role sermonize_app and its grants),
#   3. sets sermonize_app's password from SERMONIZE_APP_DB_PASSWORD.
# Idempotent: safe to run on every start and after every upgrade.
set -eu

: "${OWNER_DATABASE_URL:?OWNER_DATABASE_URL is required (the schema owner)}"
: "${SERMONIZE_APP_DB_PASSWORD:?SERMONIZE_APP_DB_PASSWORD is required (password of sermonize_app)}"
if [ "${#SERMONIZE_APP_DB_PASSWORD}" -lt 16 ]; then
  echo "SERMONIZE_APP_DB_PASSWORD must be at least 16 characters" >&2
  exit 2
fi

APP_DIR=${APP_DIR:-/app/packages/api}

echo "sermonize-migrate: migrations"
DATABASE_URL=$OWNER_DATABASE_URL node "$APP_DIR/dist/cli.js" migrate

echo "sermonize-migrate: roles.sql"
psql "$OWNER_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$APP_DIR/sql/roles.sql"

echo "sermonize-migrate: sermonize_app password"
# The password is read from the environment by psql (\getenv) and quoted by psql (:'var'): it never
# appears on a command line and is never spliced into SQL by the shell.
psql "$OWNER_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
\getenv sermonize_app_password SERMONIZE_APP_DB_PASSWORD
ALTER ROLE sermonize_app WITH LOGIN PASSWORD :'sermonize_app_password';
SQL

echo "sermonize-migrate: done"
