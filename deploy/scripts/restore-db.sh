#!/bin/sh
# Restores a dump made by backup-db.sh into the running stack's database, REPLACING its contents.
#   sh scripts/restore-db.sh <file.dump>
# Stops api, mcp and web, restores (one transaction), re-runs the migrate service (pending migrations,
# roles.sql, sermonize_app password) and starts everything again.
set -eu

DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
if [ $# -ne 1 ]; then
  echo "usage: $0 <file.dump>" >&2
  exit 2
fi
case $1 in /*) DUMP=$1 ;; *) DUMP=$(pwd)/$1 ;; esac
[ -f "$DUMP" ] || { echo "no such file: $DUMP" >&2; exit 2; }
cd "$DEPLOY_DIR"

docker compose up -d --wait db
docker compose exec -T db pg_restore --list < "$DUMP" > /dev/null || { echo "not a pg_dump custom-format file: $DUMP" >&2; exit 1; }

echo "This REPLACES all data in the Sermonize database with $DUMP."
if [ "${RESTORE_CONFIRM:-}" != "restore" ]; then
  printf 'Type "restore" to continue: '
  IFS= read -r answer || answer=
  [ "$answer" = "restore" ] || { echo "aborted"; exit 1; }
fi

docker compose stop nginx web mcp api
# Make sure sermonize_app exists (the dump's GRANTs name it), e.g. on a fresh volume.
docker compose run --rm migrate
docker compose exec -T db sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --single-transaction --exit-on-error' < "$DUMP"
# Apply migrations newer than the dump and refresh the role's grants and password.
docker compose run --rm migrate
docker compose up -d
echo "restored $DUMP"
