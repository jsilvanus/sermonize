#!/bin/sh
# Creates the first admin account with the API's database CLI (as the schema owner, in the tools
# container; bundled or external database). The password is prompted without echo and passed on stdin (--password-stdin); it never
# appears on a command line or in the shell history.
#   sh scripts/bootstrap-admin.sh <email> [display name]
# Then sign in over HTTPS:  SERMONIZE_API_URL=https://<DOMAIN>/api sermonize-admin login --email <email>
set -eu

DEPLOY_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$DEPLOY_DIR"

if [ $# -lt 1 ]; then
  echo "usage: $0 <email> [display name]" >&2
  exit 2
fi
EMAIL=$1
DISPLAY_NAME=${2:-}

if [ -t 0 ]; then
  stty_saved=$(stty -g)
  trap 'stty "$stty_saved"' EXIT INT TERM
  printf 'Password for %s (12-256 characters): ' "$EMAIL" >&2
  stty -echo
  IFS= read -r PW
  printf '\nRepeat password: ' >&2
  IFS= read -r PW2
  stty "$stty_saved"
  trap - EXIT INT TERM
  printf '\n' >&2
  if [ "$PW" != "$PW2" ]; then
    echo "passwords do not match" >&2
    exit 1
  fi
else
  # Non-interactive: the password is the first line of stdin.
  IFS= read -r PW || true
fi
[ -n "$PW" ] || { echo "empty password" >&2; exit 1; }

if [ -n "$DISPLAY_NAME" ]; then
  set -- --display-name "$DISPLAY_NAME"
else
  set --
fi

# -T: no TTY, so the password on stdin reaches the CLI unchanged.
printf '%s\n' "$PW" | docker compose run --rm --no-deps -T tools \
  sermonize-db create-user --kind human --role admin --email "$EMAIL" --password-stdin "$@"
echo "admin created (the id above). Next: SERMONIZE_API_URL=https://<DOMAIN>/api sermonize-admin login --email $EMAIL (docs/deployment.md)" >&2
