#!/bin/sh
# Dumps the Sermonize database (pg_dump custom format, run inside the db container) to
# deploy/backups/sermonize-db-<UTC timestamp>.dump (mode 0600).
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

# The credentials are the container's own POSTGRES_USER/POSTGRES_DB (local socket, no password).
docker compose exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6' > "$TMP"
# A truncated dump fails to list.
docker compose exec -T db pg_restore --list < "$TMP" > /dev/null
mv "$TMP" "$OUT"
trap - EXIT
echo "$OUT"
