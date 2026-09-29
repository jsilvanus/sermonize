#!/usr/bin/env bash
# Deploys or redeploys sermonize on this server, using the repository's own "Setup A" (host nginx,
# bundled PostgreSQL + pgvector; docs/deployment.md):
#   clone (first run) or pull, create deploy/.env with fresh secrets (first run, deploy/scripts/init-env.sh),
#   build the images, (re)start the stack. The stack's `migrate` service runs the migrations on every up.
#   web, api and mcp are published on 127.0.0.1:4104, 4105 and 4106 for the host's nginx.
#
#   bash /home/deploy/deploy/sermonize/scripts/server-deploy.sh
#   (or a copy of this file from anywhere: it clones the repository on the first run)
#
# Environment (all optional):
#   BASE_DIR       /home/deploy/deploy        the checkout goes to $BASE_DIR/sermonize
#   DEPLOY_BRANCH  main                       branch to deploy
#   REPO_URL       https://github.com/jsilvanus/sermonize.git
#   DOMAIN         asked on the first run     public domain (only used when deploy/.env is created)
#
# Secrets live in $BASE_DIR/sermonize/deploy/.env (mode 600, gitignored). It is never overwritten; edit
# it and run this script again to apply changes. First admin: see the hint printed at the end.
set -euo pipefail

NAME=sermonize
DEFAULT_DOMAIN=sermonize.italeino.fi
WEB_PORT=4104
API_PORT=4105
MCP_PORT=4106
BASE_DIR=${BASE_DIR:-/home/deploy/deploy}
APP_DIR=$BASE_DIR/$NAME
BRANCH=${DEPLOY_BRANCH:-main}
REPO_URL=${REPO_URL:-https://github.com/jsilvanus/$NAME.git}
ENV_FILE=$APP_DIR/deploy/.env
KEPT_ENV=$BASE_DIR/.kept/$NAME.env
SELF=scripts/server-deploy.sh

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

command -v git >/dev/null || die "git is not installed"
command -v openssl >/dev/null || die "openssl is not installed"
docker compose version >/dev/null 2>&1 || die "docker compose (v2) is not available for $(id -un)"

# --- 1. Code ------------------------------------------------------------------------------------
# After updating the checkout, re-run the checkout's own copy of this script (once), so a changed
# script takes effect in the same deployment.
if [ -z "${SERVER_DEPLOY_REEXEC:-}" ]; then
  if [ -d "$APP_DIR/.git" ]; then
    log "Updating $APP_DIR ($BRANCH)"
    git -C "$APP_DIR" fetch --prune origin "$BRANCH"
    git -C "$APP_DIR" checkout -q "$BRANCH"
    git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  else
    [ -e "$APP_DIR" ] && die "$APP_DIR exists but is not a git checkout"
    log "Cloning $REPO_URL ($BRANCH) into $APP_DIR"
    mkdir -p "$BASE_DIR"
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  if [ -f "$APP_DIR/$SELF" ]; then
    SERVER_DEPLOY_REEXEC=1 exec bash "$APP_DIR/$SELF" "$@"
  fi
fi
cd "$APP_DIR/deploy"
log "Deploying $NAME at commit $(git rev-parse --short HEAD)"

# --- 2. Settings and secrets (first run only) ----------------------------------------------------
FIRST_RUN=
if [ ! -f "$ENV_FILE" ] && [ -f "$KEPT_ENV" ]; then
  log "Restoring settings kept by server-delete.sh ($KEPT_ENV)"
  mv "$KEPT_ENV" "$ENV_FILE"
fi
if [ ! -f "$ENV_FILE" ]; then
  if [ -z "${DOMAIN:-}" ] && [ -t 0 ]; then
    read -r -p "Public domain for $NAME [$DEFAULT_DOMAIN]: " DOMAIN
  fi
  DOMAIN=${DOMAIN:-$DEFAULT_DOMAIN}
  sh scripts/init-env.sh host-nginx "$DOMAIN"
  sed -i -e "s/^WEB_HOST_PORT=.*/WEB_HOST_PORT=$WEB_PORT/" \
         -e "s/^API_HOST_PORT=.*/API_HOST_PORT=$API_PORT/" \
         -e "s/^MCP_HOST_PORT=.*/MCP_HOST_PORT=$MCP_PORT/" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  FIRST_RUN=1
  log "Created $ENV_FILE"
fi
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }

# --- 3. Build and start (migrations run in the `migrate` service before api starts) ---------------
# A plain `docker compose` in deploy/ reads COMPOSE_FILE/COMPOSE_PROFILES from deploy/.env.
log "Building images"
docker compose build --pull

log "Starting stack (database, migrations, api, mcp, web)"
docker compose up -d --remove-orphans

# --- 4. Check ------------------------------------------------------------------------------------
PORT=$(env_value WEB_HOST_PORT)
for _ in $(seq 1 45); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/style.css"; then
    docker image prune -f >/dev/null
    log "OK: $NAME is up (web 127.0.0.1:$PORT, api :$(env_value API_HOST_PORT), mcp :$(env_value MCP_HOST_PORT));"
    log "    https://$(env_value DOMAIN) once nginx is set up"
    if [ -n "$FIRST_RUN" ]; then
      log "First admin (asks for a password):"
      log "  cd $APP_DIR/deploy && sh scripts/bootstrap-admin.sh you@example.org"
    fi
    exit 0
  fi
  sleep 2
done
docker compose ps
docker compose logs --tail 30 migrate api web
die "$NAME did not answer on http://127.0.0.1:$PORT/"
