#!/bin/sh
# Dumps the Sermonize database (pg_dump custom format) to deploy/backups/sermonize-db-<UTC timestamp>.dump
# (mode 0600). Works with the bundled and with an external database: pg_dump (PostgreSQL 17 client) runs in
# the tools container against DATABASE_OWNER_URL.
#   sh scripts/backup-db.sh [output-directory]
# Restore with scripts/restore-db.sh. The MCP SQLite file is backed up by scripts/backup-mcp.sh.
set -eu

DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$DEPLOY_DIR"
OUT_DIR=${1:-$DEPLOY_DIR/backups}

umask 077
mkdir -p "$OUT_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=$OUT_DIR/sermonize-db-$STAMP.dump
TMP=$OUT.partial
trap 'rm -f "$TMP"' EXIT

tools() { docker compose run --rm --no-deps -T tools "$@"; }

# DATABASE_URL (the owner) is expanded inside the container, never on the host's command line.
tools sh -c 'exec pg_dump --dbname="$DATABASE_URL" --format=custom --compress=6' > "$TMP"
# A truncated dump fails to list.
tools pg_restore --list < "$TMP" > /dev/null
mv "$TMP" "$OUT"
trap - EXIT
echo "$OUT"
