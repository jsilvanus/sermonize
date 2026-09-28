#!/bin/sh
# Script-level test of sermonize-migrate's role handling (deploy/scripts/migrate.sh) against a real
# PostgreSQL >= 16 server with pgvector. Every case gets its own database and owner role (smz_mt_*).
#
#   From a checkout (npm run build first; needs psql, node):
#     sh deploy/tests/migrate-roles.sh
#   Inside the tools image (CI):
#     docker run --rm --network host -v "$PWD/deploy/tests:/tests:ro" -e TEST_PG_ADMIN_URL=... \
#       sermonize-tools:latest sh /tests/migrate-roles.sh
#
# Environment:
#   TEST_PG_ADMIN_URL   a superuser's URL (default postgres://sermonize:sermonize@localhost:5432/postgres)
#   MIGRATE             the script under test (default: deploy/scripts/migrate.sh next to this file, else
#                       /usr/local/bin/sermonize-migrate)
#   APP_DIR             packages/api with dist/ and sql/ (default: the checkout's, else /app/packages/api)
#   MIGRATE_TEST_DROP_APP_ROLE=1   allow dropping an existing sermonize_app first (DROP OWNED BY in every
#                       database of the server). Role names are cluster-wide: use a throwaway server.
set -eu

ADMIN_URL=${TEST_PG_ADMIN_URL:-postgres://sermonize:sermonize@localhost:5432/postgres}
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if [ -z "${MIGRATE:-}" ]; then
  if [ -f "$HERE/../scripts/migrate.sh" ]; then MIGRATE=$HERE/../scripts/migrate.sh; else MIGRATE=/usr/local/bin/sermonize-migrate; fi
fi
if [ -z "${APP_DIR:-}" ]; then
  if [ -d "$HERE/../../packages/api/dist" ]; then APP_DIR=$HERE/../../packages/api; else APP_DIR=/app/packages/api; fi
fi
export APP_DIR
# host:port of the admin URL, for the test URLs.
HOSTPORT=$(printf '%s' "$ADMIN_URL" | sed -n 's|^postgres[a-z]*://[^@]*@\([^/]*\)/.*|\1|p')
[ -n "$HOSTPORT" ] || { echo "cannot parse TEST_PG_ADMIN_URL" >&2; exit 2; }
OUT=$(mktemp)
FAILS=0 PASSES=0

admin() { psql "$ADMIN_URL" -X -q -At -v ON_ERROR_STOP=1 "$@"; }
admin_db() { db=$1; shift; psql "${ADMIN_URL%/*}/$db" -X -q -At -v ON_ERROR_STOP=1 "$@"; }
pass() { PASSES=$((PASSES + 1)); echo "  ok: $*"; }
fail() { FAILS=$((FAILS + 1)); echo "  FAIL: $*"; echo "  --- migrate output:"; sed 's/^/  | /' "$OUT"; }
check() { # check <description> <command...>
  d=$1; shift
  if "$@" > /dev/null 2>&1; then pass "$d"; else fail "$d"; fi
}
has_line() { grep -q -- "$1" "$OUT"; }
can_connect() { psql "$1" -X -q -At -c 'SELECT count(*) FROM schema_migrations' > /dev/null 2>&1; }
role_exists() { [ "$(admin -c "SELECT count(*) FROM pg_roles WHERE rolname = '$1'")" = 1 ]; }

cleanup() {
  for db in $(admin -c "SELECT datname FROM pg_database WHERE datname LIKE 'smz\_mt\_%'"); do
    admin -c "DROP DATABASE \"$db\" WITH (FORCE)"
  done
  if role_exists sermonize_app; then
    admin -c 'DROP ROLE sermonize_app' 2> /dev/null || {
      [ "${MIGRATE_TEST_DROP_APP_ROLE:-}" = 1 ] || {
        echo "sermonize_app exists and has privileges outside the test databases. This test drops the cluster-wide" >&2
        echo "role; set MIGRATE_TEST_DROP_APP_ROLE=1 to run DROP OWNED BY sermonize_app in every database first." >&2
        exit 2
      }
      for db in $(admin -c "SELECT datname FROM pg_database WHERE datallowconn"); do
        admin_db "$db" -c 'DROP OWNED BY sermonize_app'
      done
      admin -c 'DROP ROLE sermonize_app'
    }
  fi
  for r in $(admin -c "SELECT rolname FROM pg_roles WHERE rolname LIKE 'smz\_mt\_%'"); do
    admin -c "DROP ROLE \"$r\""
  done
}

# new_case <name> <owner attributes>: fresh owner role + database (owned by it, with pgvector), sets
# OWNER_URL and DB.
new_case() {
  echo "case: $1"
  cleanup
  DB=smz_mt_$1
  admin -c "CREATE ROLE ${DB}_owner LOGIN $2 PASSWORD 'owner-password-0123456789'"
  admin -c "CREATE DATABASE $DB OWNER ${DB}_owner"
  admin_db "$DB" -c 'CREATE EXTENSION IF NOT EXISTS vector'
  OWNER_URL=postgres://${DB}_owner:owner-password-0123456789@$HOSTPORT/$DB
}
app_url() { echo "postgres://sermonize_app:$1@$HOSTPORT/$DB"; }
# migrate <mode> <app url>: runs the script, output in $OUT, exit status in $RC.
migrate() {
  RC=0
  env DATABASE_OWNER_URL="$OWNER_URL" DATABASE_APP_URL="$2" SERMONIZE_APP_ROLE_MODE="$1" sh "$MIGRATE" > "$OUT" 2>&1 || RC=$?
}
ok_run() { [ "$RC" = 0 ]; }
# Wrong passwords are only rejected if pg_hba.conf asks for one (the official images trust 127.0.0.1 inside
# the container, e.g. with --network host); the negative password checks are skipped otherwise.
check_pw() { # check_pw <description> <command...>
  if [ "$PW_ENFORCED" = t ]; then check "$@"; else echo "  skipped (server does not check passwords here): $1"; fi
}
failed_run() { [ "$RC" != 0 ]; }

PW1=first-app-password-0123456789
PW2=second-app-password-0123456789
ADMIN_PW=admin-chosen-password-0123456789

new_case super SUPERUSER
PW_ENFORCED=f
psql "postgres://${DB}_owner:wrong-password@$HOSTPORT/$DB" -X -q -At -c 'SELECT 1' > /dev/null 2>&1 || PW_ENFORCED=t
migrate app "$(app_url $PW1)"
check "superuser owner: exits 0" ok_run
check "creates sermonize_app" has_line "does not exist; .* may create roles: creating it"
check "the API connects" can_connect "$(app_url $PW1)"
migrate app "$(app_url $PW2)"
check "second run: syncs the password" has_line "exists and .* can manage it: .*syncing its password"
check "new password works" can_connect "$(app_url $PW2)"
check_pw "old password no longer works" sh -c "! psql '$(app_url $PW1)' -X -At -c 'SELECT 1' 2> /dev/null"

new_case createrole CREATEROLE
migrate app "$(app_url $PW1)"
check "CREATEROLE owner: exits 0" ok_run
check "creates sermonize_app" has_line "does not exist; .* may create roles: creating it"
check "owner holds ADMIN OPTION on sermonize_app (PostgreSQL >= 16)" \
  test "$(admin -c "SELECT pg_has_role('${DB}_owner', 'sermonize_app', 'USAGE WITH ADMIN OPTION')")" = t
check "the API connects" can_connect "$(app_url $PW1)"
migrate app "$(app_url $PW2)"
check "second run: syncs the password" has_line "exists and .* can manage it: .*syncing its password"
check "new password works" can_connect "$(app_url $PW2)"
check_pw "old password no longer works" sh -c "! psql '$(app_url $PW1)' -X -At -c 'SELECT 1' 2> /dev/null"
migrate app "$(app_url short)"
check "password shorter than 16 characters is refused" has_line "at least 16 characters"

new_case nocreate ''
migrate app "$(app_url $PW1)"
check "owner without CREATEROLE, role missing: fails" failed_run
check "prints CREATE ROLE for an administrator" has_line "CREATE ROLE sermonize_app LOGIN PASSWORD"
check "prints GRANT CONNECT" has_line "GRANT CONNECT ON DATABASE \"$DB\" TO sermonize_app"
check "mentions ALTER ROLE ... CREATEROLE" has_line "ALTER ROLE \"${DB}_owner\" CREATEROLE"
check "does not print the password" sh -c "! grep -q '$PW1' '$OUT'"
check "creates no role" sh -c "! psql '$ADMIN_URL' -X -At -c \"SELECT 1 FROM pg_roles WHERE rolname = 'sermonize_app'\" | grep -q 1"

for attrs in '' CREATEROLE; do
  name=precreated${attrs:+_createrole}
  new_case "$name" "$attrs"
  admin -c "CREATE ROLE sermonize_app LOGIN PASSWORD '$ADMIN_PW'"
  admin -c "GRANT CONNECT ON DATABASE $DB TO sermonize_app"
  migrate app "$(app_url $ADMIN_PW)"
  check "pre-created role, owner ${attrs:-without CREATEROLE}: exits 0" ok_run
  check "grants only, password left unchanged" has_line "managed outside Sermonize"
  check "logs how to rotate" has_line "ALTER ROLE sermonize_app PASSWORD"
  check "the API connects (grants applied)" can_connect "$(app_url $ADMIN_PW)"
  migrate app "$(app_url $PW2)"
  check_pw "DATABASE_APP_URL with another password: fails at the connection check" failed_run
  check_pw "explains that the role is managed outside" has_line "managed outside Sermonize, so its password"
  check "the administrator's password still works" can_connect "$(app_url $ADMIN_PW)"
done

new_case ownermode ''
migrate owner "$OWNER_URL"
check "owner mode: exits 0" ok_run
check "logs the owner mode" has_line "SERMONIZE_APP_ROLE_MODE=owner"
check "creates no sermonize_app" sh -c "! psql '$ADMIN_URL' -X -At -c \"SELECT 1 FROM pg_roles WHERE rolname = 'sermonize_app'\" | grep -q 1"

new_case alias_managed SUPERUSER
migrate managed "$(app_url $PW1)"
check "alias managed: exits 0" ok_run
check "logs the deprecation" has_line "SERMONIZE_APP_ROLE_MODE=managed is deprecated"
check "creates sermonize_app" can_connect "$(app_url $PW1)"

new_case alias_external ''
admin -c "CREATE ROLE sermonize_app LOGIN PASSWORD '$ADMIN_PW'"
admin -c "GRANT CONNECT ON DATABASE $DB TO sermonize_app"
migrate external "$(app_url $ADMIN_PW)"
check "alias external: exits 0" ok_run
check "logs the deprecation" has_line "SERMONIZE_APP_ROLE_MODE=external is deprecated"
check "grants only" has_line "managed outside Sermonize"

new_case badmode SUPERUSER
migrate bogus "$(app_url $PW1)"
check "unknown mode: fails" failed_run
check "names the valid modes" has_line "must be app or owner"

new_case novector ''
admin_db "$DB" -c 'DROP EXTENSION vector'
migrate app "$(app_url $PW1)"
check "pgvector not installed, non-superuser owner: fails" failed_run
check "prints the superuser's CREATE EXTENSION" has_line "CREATE EXTENSION IF NOT EXISTS vector"

cleanup
rm -f "$OUT"
echo "$PASSES passed, $FAILS failed"
[ "$FAILS" = 0 ]
