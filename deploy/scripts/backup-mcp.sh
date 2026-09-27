#!/bin/sh
# Copies the MCP server's SQLite file (OAuth grants, codes, refresh tokens) consistently while it runs
# (VACUUM INTO) to deploy/backups/sermonize-mcp-<UTC timestamp>.sqlite (mode 0600).
#   sh scripts/backup-mcp.sh [output-directory]
# The grants' API tokens in it are encrypted with MCP_TOKEN_KEY: keep that key out of the backup's
# location. Losing this file only means MCP users sign in again.
set -eu

DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$DEPLOY_DIR"
OUT_DIR=${1:-$DEPLOY_DIR/backups}

umask 077
mkdir -p "$OUT_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=$OUT_DIR/sermonize-mcp-$STAMP.sqlite
SNAP=/data/backup-$STAMP.sqlite

docker compose exec -T mcp node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.STORAGE_PATH);
db.exec("VACUUM INTO \x27" + process.argv[1] + "\x27"); // path fixed by this script: no quotes in it
db.close();' "$SNAP"
docker compose cp "mcp:$SNAP" "$OUT"
docker compose exec -T mcp rm -f "$SNAP"
chmod 0600 "$OUT"
echo "$OUT"
