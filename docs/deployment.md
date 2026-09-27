# Deploying Sermonize (Docker Compose + nginx, one domain)

This guide runs the whole stack on one Linux host behind nginx, on **one domain** (e.g.
`https://sermonize.example.org`):

| public path | goes to | notes |
|---|---|---|
| `/` (everything not listed below) | **web** (`web:3100`) | server-rendered UI: stats, register, sign in, account |
| `/api/…` | **api** (`api:3000`), prefix stripped (`/api/works` → `/works`) | REST API; Swagger UI at `/api/docs`, OpenAPI JSON at `/api/docs/json`; 64 MiB request bodies |
| `/api/admin/…` | **api**, as above | optional address allowlist ([`deploy/nginx/admin-allow.conf`](../deploy/nginx/admin-allow.conf)) |
| `/mcp` | **mcp** (`mcp:5999`) | MCP resource (Streamable HTTP): no buffering, 1 h read timeout |
| `/oauth/…` | **mcp** | embedded OAuth authorization server (`/oauth/authorize`, `/oauth/token`) |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | **mcp** | OAuth discovery; any other `/.well-known/…` is 404 |
| `http://…/.well-known/acme-challenge/…` | nginx (webroot) | Let's Encrypt http-01; everything else on port 80 redirects to HTTPS |

Not public: the API's and MCP server's `/health` (container health checks only), PostgreSQL, and every
container port except nginx's 80/443.

Files:

```
Dockerfile                 one build of the npm workspace; targets api, mcp, web, tools
.dockerignore
deploy/
├── docker-compose.yml     db, migrate, api, mcp, web, nginx (+ profiles: certbot, tools)
├── .env.example           every setting, documented; copy to deploy/.env (never committed)
├── nginx/
│   ├── nginx.conf                       main config (logs without query strings, gzip, timeouts)
│   ├── templates/sermonize.conf.template   the site; ${DOMAIN} filled in at container start
│   ├── snippets/                        proxy headers, TLS profile, HSTS, security headers
│   └── admin-allow.conf                 optional allowlist for /api/admin/ (empty = off)
└── scripts/               POSIX sh, run from anywhere
    ├── init-env.sh          create deploy/.env with fresh secrets
    ├── self-signed.sh       placeholder certificate so nginx can start before Let's Encrypt
    ├── init-letsencrypt.sh  obtain the real certificate (webroot) and reload nginx
    ├── bootstrap-admin.sh   first admin account (hidden password prompt)
    ├── backup-db.sh / restore-db.sh   pg_dump custom format / restore with confirmation
    ├── backup-mcp.sh        consistent copy of the MCP SQLite file
    └── migrate.sh           the migrate service's command (inside the tools image)
```

## Architecture

```
            Internet
               │ 80, 443
        ┌──────┴──────┐  edge network
        │    nginx    │  (only published ports)
        └──┬───┬───┬──┘
  backend  │   │   │        internal network 172.28.0.0/24 (no Internet), nginx = 172.28.0.10
     ┌─────┘   │   └──────┐
  ┌──┴──┐   ┌──┴──┐    ┌──┴──┐   egress network: mcp fetches OAuth client metadata
  │ web │   │ api │    │ mcp ├── documents (CIMD) from the Internet
  └──┬──┘   └┬─┬──┘    └──┬──┘
     └──────►┘ │◄─────────┘      web and mcp call http://api:3000 (never PostgreSQL)
            ┌──┴──┐
            │ db  │  pgvector/pgvector:0.8.1-pg16, volume db_data (not published)
            └─────┘
  migrate (one-off, every `up`): migrations as owner → roles.sql → sermonize_app password
  mcp: SQLite (OAuth grants, encrypted API tokens) in volume mcp_data at /data/app.sqlite
```

- **Images** (`Dockerfile`, `node:22-bookworm-slim`): the workspace is installed and compiled once
  (`npm ci`, `npm run build`); each service image gets only production dependencies (`npm ci --omit=dev`),
  its compiled `dist/`, runs as the non-root `node` user with `NODE_ENV=production` and has a health
  check. `tools` = the api image plus `sermonize-admin`, `psql` and the migrate script.
  (npm installs the production dependencies of all workspaces a service's workspace links to, so the web
  and mcp images also carry the API's runtime packages; no dev tooling is included.)
- **Database roles.** The `migrate` service runs migrations as the schema owner `sermonize`
  (`POSTGRES_PASSWORD`), then applies [`packages/api/sql/roles.sql`](../packages/api/sql/roles.sql),
  which creates/refreshes `sermonize_app` and its grants, then sets `sermonize_app`'s password from
  `SERMONIZE_APP_DB_PASSWORD` (`roles.sql` does not set one). The password goes through psql's
  `\getenv` and `:'var'` quoting: it is never on a command line or spliced into SQL. The **api connects as
  `sermonize_app`**, never as the owner. Only `migrate`, the `tools` container and backups use the owner.
- **Container hardening:** api, mcp and web run with a read-only root filesystem (`/tmp` is a tmpfs;
  mcp writes only its volume), all capabilities dropped, `no-new-privileges`, `init`, rotated JSON logs.

## Prerequisites

- A Linux host (2 GB RAM is enough to start; more for large HNSW index builds) with **Docker Engine ≥ 24
  and the Compose plugin ≥ 2.20** (`docker compose version`), `openssl` and `git`.
- A **DNS** `A` (and `AAAA`, if the host has IPv6) record for your domain pointing at the host. Check with
  `dig +short sermonize.example.org`.
- Inbound **TCP 80 and 443** open (80 is needed for Let's Encrypt http-01 and the HTTPS redirect).
  Close everything else except SSH (see the [security checklist](#security-checklist)).
- Outbound HTTPS from the host (image builds, Let's Encrypt, and the MCP server's client metadata fetches).

## First deployment

```sh
git clone https://github.com/jsilvanus/sermonize.git && cd sermonize/deploy

# 1. Settings and secrets -> deploy/.env (mode 0600). Review it afterwards.
sh scripts/init-env.sh sermonize.example.org admin@example.org

# 2. Build the images (api, mcp, web, tools) from the repository root's Dockerfile.
docker compose build

# 3. Placeholder certificate, so nginx can start before the real one exists.
sh scripts/self-signed.sh

# 4. Start: db -> migrate (migrations, roles.sql, app password) -> api -> web, mcp -> nginx.
docker compose up -d --wait
docker compose ps            # all "healthy"; migrate "exited (0)"

# 5. Real certificate (Let's Encrypt, webroot), then nginx reloads. Try --staging first if unsure.
sh scripts/init-letsencrypt.sh

# 6. The first admin (hidden password prompt, 12-256 characters).
sh scripts/bootstrap-admin.sh you@example.org "Your Name"
```

Instead of `init-env.sh` you can `cp .env.example .env`, fill in every empty value (each has its
generation command, e.g. `openssl rand -hex 32` for database passwords, `openssl rand -base64 32` for the
other secrets) and `chmod 600 .env`. Database passwords are hex so they can sit in a `postgres://` URL
without escaping.

Check it (replace the domain):

```sh
curl -fsS https://sermonize.example.org/api/health          # {"status":"ok","database":"ok"}
curl -fsS https://sermonize.example.org/api/stats
curl -si  https://sermonize.example.org/mcp -X POST | grep -i www-authenticate
# WWW-Authenticate: Bearer resource_metadata="https://sermonize.example.org/.well-known/oauth-protected-resource/mcp", scope="mcp"
curl -fsS https://sermonize.example.org/.well-known/oauth-authorization-server
```

and open `https://sermonize.example.org/` and `https://sermonize.example.org/api/docs` in a browser.

### Administer users from your own machine

`sermonize-admin` ([`packages/cli`](../packages/cli/README.md)) talks to the API over HTTPS; its API URL
includes the `/api` prefix:

```sh
# in a checkout on your machine: npm ci && npm run build -w @sermonize/cli
export SERMONIZE_API_URL=https://sermonize.example.org/api
node packages/cli/dist/index.js login --email you@example.org      # or: npm run admin -- login ...
node packages/cli/dist/index.js users list
```

or on the server, inside the internal network (not subject to the nginx allowlist; the login token lives
only as long as that container):

```sh
docker compose run --rm tools sh -c 'sermonize-admin login --email you@example.org && sermonize-admin users list'
```

### MCP clients

The MCP server URL is `https://sermonize.example.org/mcp`. Users sign in with their Sermonize account
on the OAuth page the client opens. See [`packages/mcp/README.md`](../packages/mcp/README.md).

## Configuration reference (`deploy/.env`)

| variable | default | used by | |
|---|---|---|---|
| `DOMAIN` | required | nginx, mcp | public host name; `MCP_PUBLIC_URL=https://$DOMAIN` |
| `LETSENCRYPT_EMAIL` | empty | init-letsencrypt.sh | expiry notices |
| `POSTGRES_PASSWORD` | required | db, migrate, tools | schema owner `sermonize`; only applied when the db volume is initialised |
| `SERMONIZE_APP_DB_PASSWORD` | required | migrate, api | `sermonize_app`; re-applied on every `up` (rotate by changing it and `docker compose up -d`) |
| `MCP_JWT_SECRET` | required | mcp (`JWT_SECRET`) | base64, ≥ 32 bytes |
| `MCP_TOKEN_KEY` | required | mcp (`SERMONIZE_TOKEN_KEY`) | base64 of exactly 32 bytes |
| `WEB_COOKIE_SECRET` | required | web | ≥ 32 characters |
| `REGISTRATION_OPEN` | `false` | api | self-registration on the web UI |
| `REGISTRATION_DEFAULT_ROLE` | `reader` | api | `reader` or `contributor` |
| `LOGIN_TOKEN_TTL_HOURS` / `MCP_LOGIN_TOKEN_TTL_HOURS` / `CLI_LOGIN_TOKEN_TTL_HOURS` | `12` / `720` / `12` | api | login token lifetimes |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `10` / `60` | api | per client IP, register and login |
| `MAX_BATCH_ITEMS` | `5000` | api | items per batch request |
| `LOG_LEVEL` | `info` | api, mcp, web | |
| `SERMONIZE_TAG` | `latest` | compose | tag of the locally built images |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | nginx | published host ports |
| `SERMONIZE_SUBNET` / `NGINX_BACKEND_IP` | `172.28.0.0/24` / `172.28.0.10` | compose, `TRUST_PROXY` | change together if the subnet collides |
| `MCP_REQUEST_TIMEOUT_MS` / `WEB_REQUEST_TIMEOUT_MS` | `15000` / `10000` | mcp / web | upstream API timeouts |

Fixed in `docker-compose.yml` (no need to set them): `PUBLIC_BASE_PATH=/api` and
`TRUST_PROXY=$SERMONIZE_SUBNET` for the api; `TRUST_PROXY=$NGINX_BACKEND_IP`, `SERMONIZE_API_URL=http://api:3000`
for web and mcp; `WEB_COOKIE_SECURE=true`; `STORAGE_PATH=/data/app.sqlite`; `HOST=0.0.0.0`.

### `PUBLIC_BASE_PATH` (API)

The API's routes stay at its root; nginx strips `/api`. `PUBLIC_BASE_PATH=/api` tells the API about the
prefix so that the OpenAPI document gets `servers: [{ "url": "/api" }]` (Swagger UI's "Try it out" and
generated clients call `/api/...`) and the Swagger UI page at `/api/docs` loads its assets from
`/api/docs/static/...`. Unset (the default), nothing changes. It must be a plain absolute path
(`/api`, `/sermonize/api`); anything else stops the API at startup.

## Client IPs, `TRUST_PROXY` and rate limiting

The API rate-limits register and login **per client IP**, so every hop must pass the real address on,
and each service must trust exactly the hop in front of it:

| request | hops | who trusts whom |
|---|---|---|
| browser → web UI sign-in | client → nginx → web → api | web trusts nginx (`TRUST_PROXY=172.28.0.10`) and forwards the browser IP; api trusts web |
| MCP sign-in page | client → nginx → mcp → api | mcp trusts nginx; api trusts mcp |
| scripts, `sermonize-admin` | client → nginx → api | api trusts nginx |

The API trusts the whole backend subnet (`TRUST_PROXY=172.28.0.0/24`): only nginx, web and mcp can send it
requests with `X-Forwarded-For`, since the network is internal and nothing else is attached to it. nginx
**replaces** `X-Forwarded-For` with the connecting address (it is the edge), so a client cannot inject a
fake address. If you put another proxy or a CDN in front of nginx, configure nginx's `real_ip` module for it;
otherwise all users share that proxy's rate-limit bucket.

With Docker's default `iptables` port publishing the connecting address is the real client. If you see
only the Docker gateway (e.g. `172.18.0.1`) in `docker compose logs api` for sign-ins, the host runs Docker's
userland proxy (e.g. IPv6 without `ip6tables`) and all clients share one bucket; fix the Docker networking or
raise `AUTH_RATE_LIMIT_MAX`.

## Updates

```sh
cd sermonize && git pull
cd deploy
sh scripts/backup-db.sh                    # always, before migrations
docker compose build                       # optionally SERMONIZE_TAG=<commit> in .env to keep the old images
docker compose up -d --wait                # runs migrate (pending migrations + roles.sql), recreates changed services
docker compose ps && docker compose logs migrate
```

`migrate` runs on every `up`, before the API starts; if it fails, `up` stops there with an error: read
`docker compose logs migrate`, fix the cause, run `docker compose up -d --wait` again.
Migrations are forward-only: to roll back, restore the backup taken before the update and start the
previous images (`SERMONIZE_TAG`).

Base images: `docker compose pull db nginx` and `docker compose build --pull` pick up security updates of
`pgvector/pgvector`, `nginx` and `node:22-bookworm-slim`. A **major PostgreSQL upgrade** (pg16 → pg17)
needs a dump and restore into a new volume, not just a new tag.

## Backups

Back up **both** volumes and keep the secrets (`deploy/.env`) separately (password manager):

| what | how | lost without it |
|---|---|---|
| database (`db_data`) | `sh scripts/backup-db.sh` → `deploy/backups/sermonize-db-<UTC>.dump` (pg_dump custom format, run in the db container, checked with `pg_restore --list`) | everything |
| MCP SQLite (`mcp_data`) | `sh scripts/backup-mcp.sh` → `deploy/backups/sermonize-mcp-<UTC>.sqlite` (`VACUUM INTO`, safe while running) | only MCP sign-ins (users sign in again) |
| `deploy/.env` | copy by hand, not next to the backups | database passwords, cookie and token keys |
| `deploy/certbot/conf` | optional (certbot can re-issue) | |

Nightly example (root's crontab; copy the files off the host, e.g. with restic or rclone):

```cron
17 3 * * * cd /opt/sermonize/deploy && sh scripts/backup-db.sh >/dev/null && sh scripts/backup-mcp.sh >/dev/null && find backups -type f -mtime +14 -delete
```

The MCP SQLite file holds API tokens encrypted with `MCP_TOKEN_KEY`: keep that key out of the backup's
location. Restoring a database (replaces all data; asks you to type `restore`):

```sh
sh scripts/restore-db.sh backups/sermonize-db-20260101T031700Z.dump
```

It stops nginx, web, mcp and api, runs `migrate` (so `sermonize_app` exists), restores with
`pg_restore --clean --if-exists --single-transaction`, runs `migrate` again (newer migrations, grants,
the app password) and starts everything. Restore the MCP file with mcp stopped (the copy runs as the
container's user, so the file keeps the right owner):

```sh
docker compose stop mcp
docker compose run --rm --no-deps -v "$PWD/backups:/restore:ro" --entrypoint sh mcp \
  -c 'rm -f /data/app.sqlite-wal /data/app.sqlite-shm && cp /restore/sermonize-mcp-20260101T031700Z.sqlite /data/app.sqlite'
docker compose start mcp
```

## Vector indexes

Semantic search works without an index (exact scan). For large embedding spaces build the partial HNSW
index with the API's database CLI in the tools container (as the schema owner; `CREATE INDEX CONCURRENTLY`,
the API keeps serving):

```sh
docker compose run --rm tools sermonize-db create-index <embedding-space-id>
docker compose run --rm tools sermonize-db drop-index <embedding-space-id>
```

The db container has `shm_size: 256mb` for parallel index builds; raise it (and PostgreSQL's
`maintenance_work_mem`, e.g. `command: postgres -c maintenance_work_mem=1GB` on the db service) for very large
spaces. Other database CLI commands: `docker compose run --rm tools sermonize-db help`
(`create-token` for emergency tokens as the system user, `revoke-token`, …).

## Certificates

`scripts/init-letsencrypt.sh` moves the placeholder aside, runs `certbot certonly --webroot` (profile
`certbot`, webroot `deploy/certbot/www` served by nginx on port 80), and reloads nginx; on failure it puts the
placeholder back. Renew twice a day from cron (certbot only renews when due):

```cron
23 4,16 * * * cd /opt/sermonize/deploy && docker compose --profile certbot run --rm certbot renew --quiet && docker compose exec nginx nginx -s reload
```

`scripts/self-signed.sh [--force] [domain]` also serves local testing: e.g. `DOMAIN=localhost`,
`HTTP_PORT=8080`, `HTTPS_PORT=8443` in `.env` and `curl -k https://localhost:8443/`.

## Logs and operations

```sh
docker compose logs -f nginx api          # JSON logs of api/mcp/web (pino), nginx access log without query strings
docker compose ps                         # health
docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload   # after editing nginx files
docker compose up -d --force-recreate nginx   # after editing nginx.conf or the template
docker compose exec db psql -U sermonize -d sermonize
```

Logs rotate at 10 MB × 5 per container. The nginx access log leaves out query strings (OAuth codes and
state travel there); the apps never log tokens or bodies.

## Security checklist

- [ ] `deploy/.env` is mode 0600, not in git (it is in `.gitignore`), and its secrets are also in a password
      manager. Every secret was generated (`init-env.sh` or the commands in `.env.example`), none reused.
- [ ] **Registration stays off** (`REGISTRATION_OPEN=false`, the default) unless you want public sign-ups;
      if on, `REGISTRATION_DEFAULT_ROLE=reader`. Admins create accounts with `sermonize-admin users create`.
- [ ] Consider the **admin allowlist**: add `allow <your address>; deny all;` to
      `deploy/nginx/admin-allow.conf` and reload nginx. `/api/admin/` then answers 403 elsewhere
      (`sermonize-admin` from other addresses fails; the tools container still works).
- [ ] **Firewall**: only 22 (ideally restricted), 80 and 443 inbound, e.g.
      `ufw default deny incoming && ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`.
      Docker's published ports bypass ufw, which is why only nginx publishes any.
- [ ] SSH with keys only; unattended OS security updates; `docker compose build --pull` regularly.
- [ ] Backups run, are copied off the host, and a restore has been tested.
- [ ] Few admins: promote with `sermonize-admin users set-role`, remove with `users disable`; tokens for
      scripts are per service user with an expiry (`sermonize-admin tokens create --expires-at …`).
- [ ] HSTS is sent for two years (`includeSubDomains`); make sure every subdomain can do HTTPS, or remove
      `includeSubDomains` in `deploy/nginx/snippets/hsts.conf`.
- [ ] The web UI sets its own CSP and frame/referrer headers; nginx adds HSTS everywhere and `nosniff`,
      `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` for the API and the MCP server.
