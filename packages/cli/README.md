# @sermonize/cli — `sermonize-admin`

Day-to-day user and token administration for Sermonize. It talks **only to the REST API over HTTP**
(`/auth/login`, `/me`, `/admin/*`, `/stats`); it has no database access and no dependencies beyond Node.js.

The API package keeps its own database CLI (`npm run cli -- …`) for bootstrap and operations: migrations,
creating **the first admin**, emergency tokens as the system user and vector indexes. Everything else about
accounts goes through `sermonize-admin`, so it is authenticated, role-checked and audited like any other API call.

## Install and run

From the repository root:

```sh
npm install
npm run admin -- --help                 # runs src/ with tsx
npm run build -w @sermonize/cli         # then: node packages/cli/dist/index.js --help
                                        # (npm links the bin as node_modules/.bin/sermonize-admin)
```

Requirements: Node.js ≥ 22.12 and a reachable Sermonize API.

## Configuration

| variable | default | meaning |
|---|---|---|
| `SERMONIZE_API_URL` | the URL saved by `login`, else `http://127.0.0.1:3000` | API base URL; may include a path prefix, e.g. `https://example.org/api` behind the reverse proxy of [`docs/deployment.md`](../../docs/deployment.md) |
| `SERMONIZE_TOKEN` | – | API token to use; takes precedence over the saved one |
| `XDG_CONFIG_HOME` | `~/.config` | the token from `login` is saved in `$XDG_CONFIG_HOME/sermonize/credentials.json` (directory 0700, file 0600) |

A saved token is only ever sent to the API URL it was issued by: if `SERMONIZE_API_URL` points elsewhere, the
CLI behaves as not logged in.

## First admin (bootstrap)

```sh
export DATABASE_URL=postgres://…            # the API's database
npm run migrate
read -rs PW && printf '%s\n' "$PW" | npm run --silent cli -- create-user --kind human --role admin \
  --email you@example.org --password-stdin  # prints the user id
```

Then, against the running API:

```sh
export SERMONIZE_API_URL=https://example.org/api   # the API behind the proxy's /api/ (docs/deployment.md)
sermonize-admin login --email you@example.org   # Password: (hidden)
sermonize-admin whoami
```

`login` uses `POST /auth/login` with `client: "cli"`; the token is named `cli` and expires after the API's
`CLI_LOGIN_TOKEN_TTL_HOURS` (default 12 h). `logout` revokes it (`POST /auth/logout`) and deletes the file.

## Commands

```
login [--email <email>] [--password-stdin]
logout
whoami
stats

users list [--role <role>] [--status active|disabled] [--kind human|service] [--q <text>]
           [--limit <n>] [--cursor <c>] [--all]
users get <user-id>
users create --email <email> --role <role> [--display-name <name>] [--kind human|service]
             [--password-prompt | --password-stdin]
users set-role <user-id> <role>
users disable <user-id>
users enable <user-id>
users set-password <user-id> [--revoke-tokens] [--password-stdin]

tokens list <user-id>
tokens create <user-id> --name <name> [--expires-at <ISO date-time>]
tokens revoke <token-id>
```

Every command accepts `--json` (machine-readable output on stdout) and `--help`.

Roles are `reader < contributor < curator < admin`. Self-registration (`POST /auth/register`) only ever gives
`reader` or `contributor`; promote users with `users set-role <id> curator` or `… admin`.

### Examples

```sh
# Find accounts
sermonize-admin users list --q anna
sermonize-admin users list --role admin --status active
sermonize-admin users list --all --json | jq -r '.items[] | [.id, .email, .role] | @tsv'

# Create a curator who signs in with a password (prompted twice, hidden)
sermonize-admin users create --email anna@example.org --display-name "Anna" --role curator --password-prompt

# A service account for an embedding script, with an expiring token
SVC=$(sermonize-admin users create --kind service --role contributor --display-name embedder --json | jq -r .id)
sermonize-admin tokens create "$SVC" --name embeddings --expires-at 2027-01-01T00:00:00Z > embeddings.token
#   (the token goes to stdout, the warning to stderr; it is never shown again)

# Promote, disable, enable
sermonize-admin users set-role <user-id> admin
sermonize-admin users disable <user-id>     # its tokens stop working immediately
sermonize-admin users enable <user-id>

# Reset a password and sign the user out everywhere
sermonize-admin users set-password <user-id> --revoke-tokens
printf '%s\n' "$NEW_PW" | sermonize-admin users set-password <user-id> --password-stdin

# Tokens
sermonize-admin tokens list <user-id>
sermonize-admin tokens revoke <token-id>
```

## Behaviour

- **Passwords are never accepted as arguments** (they would end up in shell history and `ps`): they come from a
  hidden prompt on the terminal, or from the first line of stdin with `--password-stdin`. `--password=…` is
  refused. Nothing the CLI reads is echoed or printed.
- Output is a plain table or key/value block by default and JSON with `--json`. Prompts, warnings and errors go to
  stderr, so stdout stays clean (`tokens create` prints only the token).
- Exit codes: `0` ok, `1` API or usage error (including network errors), `2` not signed in, invalid/expired token,
  or not allowed (401/403).
- The API's safety rules are explained in plain words: an admin cannot demote or disable themself, the last active
  admin cannot be demoted or disabled, and the system user cannot be changed.
- With `--json`, errors are printed to stderr as `{"error": {code, message, details?}, "message": …}`.

## Development

```sh
npm run typecheck -w @sermonize/cli
npm test -w @sermonize/cli
```

The tests start the real API (from its TypeScript sources, via the `@sermonize/source` export condition) on an
ephemeral port against `TEST_DATABASE_URL`, and call the CLI's `main()` with injected argv, env, stdin and
stdout and a temporary `XDG_CONFIG_HOME`. Like the web and MCP packages, they only apply pending migrations to the
shared test database (the API suite is the only one that resets it) and use unique emails.
