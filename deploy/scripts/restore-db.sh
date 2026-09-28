#!/bin/sh
# Restores a dump made by backup-db.sh into the stack's database (bundled or external), REPLACING its
# contents.
#   sh scripts/restore-db.sh <file.dump>
# Stops web, mcp and api, restores in one transaction as the schema owner (tools container,
# DATABASE_OWNER_URL), runs the migrate service (newer migrations, grants, the app role) and starts
# everything again. Portable between setups: ownership and privileges are not restored (the migrate run
# re-applies them) and the extension entries are skipped (pgvector stays as the administrator created it).
set -eu

DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
if [ $# -ne 1 ]; then
  echo "usage: $0 <file.dump>" >&2
  exit 2
fi
case $1 in /*) DUMP=$1 ;; *) DUMP=$(pwd)/$1 ;; esac
[ -f "$DUMP" ] || { echo "no such file: $DUMP" >&2; exit 2; }
cd "$DEPLOY_DIR"

tools() { docker compose run --rm --no-deps -T tools "$@"; }

if docker compose config --services | grep -qx db; then
  docker compose up -d --wait db
fi
tools pg_restore --list < "$DUMP" > /dev/null || { echo "not a pg_dump custom-format file: $DUMP" >&2; exit 1; }

echo "This REPLACES all data in the Sermonize database with $DUMP."
if [ "${RESTORE_CONFIRM:-}" != "restore" ]; then
  printf 'Type "restore" to continue: '
  IFS= read -r answer || answer=
  [ "$answer" = "restore" ] || { echo "aborted"; exit 1; }
fi

docker compose stop web mcp api
# Make sure the extension exists (and a fresh database has the schema) before restoring.
docker compose run --rm migrate
# The dump arrives on stdin (kept in the container's /tmp, a tmpfs: memory-bound); the table of contents
# minus EXTENSION entries is built inside the container.
tools sh -c '
  set -eu
  cat > /tmp/restore.dump
  pg_restore --list /tmp/restore.dump | grep -v " EXTENSION " > /tmp/restore.list
  # As a script through psql: pg_restore 17 emits `SET transaction_timeout`, unknown to older servers.
  pg_restore --use-list=/tmp/restore.list --clean --if-exists --no-owner --no-acl --file=- /tmp/restore.dump |
    grep -v "^SET transaction_timeout" |
    psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction > /dev/null' < "$DUMP"
# Newer migrations than the dump, PUBLIC revokes, the app role's grants and password.
docker compose run --rm migrate
docker compose up -d --wait
echo "restored $DUMP"
