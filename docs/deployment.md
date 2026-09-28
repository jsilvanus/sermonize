# Deploying Sermonize (Docker Compose, one domain)

Sermonize runs as four containers (api, mcp, web, and a one-off migrate) behind a reverse proxy, on
**one domain** (e.g. `https://sermonize.example.org`). Two setups are supported:

- **[Setup A: host nginx](#setup-a-host-nginx)**: nginx installed on the host (`apt install nginx`,
  certbot for TLS) proxies to the containers, which are published on `127.0.0.1` only. PostgreSQL is
  bundled in the stack by default (or external).
- **[Setup B: Traefik (riksunsrk infra)](#setup-b-traefik-riksunsrk-infra)**: the shared Traefik of
  `riksunsrk/infra` routes to the containers by Docker labels; the database is the shared PostgreSQL
  (`pg.shared.local`). No host ports.

Both use the same base file and the same routing:

| public path | goes to | notes |
|---|---|---|
| `/` (everything not listed below) | **web** (port 3100) | server-rendered UI: stats, register, sign in, account |
| `/api/…` | **api** (3000), prefix stripped (`/api/works` → `/works`) | REST API; Swagger UI at `/api/docs`, OpenAPI JSON at `/api/docs/json`; 64 MiB request bodies |
| `/api/admin/…` | **api**, as above | optional address allowlist |
| `/mcp` | **mcp** (5999) | MCP resource (Streamable HTTP): no buffering, long timeouts |
| `/oauth/…` | **mcp** | embedded OAuth authorization server (`/oauth/authorize`, `/oauth/token`) |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | **mcp** | OAuth discovery; any other `/.well-known/…` is 404 |

Not public: the API's and MCP server's `/health` (container health checks only) and PostgreSQL.

Files:

```
Dockerfile                    one build of the npm workspace; targets api, mcp, web, tools
.github/workflows/images.yml  publishes ghcr.io/jsilvanus/sermonize-{api,mcp,web,tools} on v* tags
deploy/
├── compose.yml               base: migrate, api, mcp, web (+ profiles: tools, bundled-db)
├── .env.example              every setting, documented; init-env.sh turns it into deploy/.env
├── host-nginx/               Setup A
│   ├── compose.host-nginx.yml   publishes api/mcp/web on 127.0.0.1, pins the edge network
│   ├── sermonize.conf           the nginx site (sites-available/)
│   ├── snippets/                proxy headers, TLS profile, HSTS, security headers
│   ├── admin-allow.conf         optional allowlist for /api/admin/ (empty = off)
│   └── install.sh               installs the site + snippets, nginx -t, reload
├── traefik/
│   └── compose.traefik.yml   Setup B: external networks, Traefik labels
└── scripts/                  POSIX sh, run from anywhere
    ├── init-env.sh           create deploy/.env for a setup, with fresh secrets
    ├── migrate.sh            the migrate service's command (sermonize-migrate in the tools image)
    ├── bootstrap-admin.sh    first admin account (hidden password prompt)
    ├── backup-db.sh / restore-db.sh   pg_dump custom format / restore with confirmation
    └── backup-mcp.sh         consistent copy of the MCP SQLite file
```

## Common part

### Architecture

```
                 reverse proxy (host nginx | Traefik)
                    │            │            │
        ┌───────────┘            │            └──────────┐
     ┌──┴──┐                  ┌──┴──┐                 ┌──┴──┐   egress: mcp fetches OAuth client
     │ web │                  │ api │                 │ mcp ├── metadata documents (CIMD) over HTTPS
     └──┬──┘                  └─┬─┬─┘                 └──┬──┘
        └──► sermonize-api:3000 ┘ │ ◄────────────────────┘   backend: internal network (no Internet),
                                  │                          172.28.0.0/24, unique aliases
                  PostgreSQL + pgvector: bundled `db` (sermonize-db:5432, volume db_data)
                  or external (e.g. pg.shared.local:5432)
  migrate (one-off, every `up`): pgvector check → migrations as the owner → app role (role mode)
  mcp: SQLite (OAuth grants, encrypted API tokens) in volume mcp_data at /data/app.sqlite
```

- **Images** (`Dockerfile`, `node:22-bookworm-slim`): the workspace is installed and compiled once; each
  service image gets only production dependencies and its compiled `dist/`, runs as the non-root `node`
  user with `NODE_ENV=production` and has a health check. `tools` = the api image plus `sermonize-admin`,
  the PostgreSQL 17 client (`psql`, `pg_dump`; new enough for pg16 and pg17 servers) and the migrate script.
- **Networks.** `backend` is internal and carries all service-to-service traffic under unique aliases
  (`sermonize-api`, `sermonize-db`), so joining shared networks (Traefik's, the shared database's)
  cannot make a name resolve to another stack's container. mcp also has `egress`. The setup overrides add
  the network the proxy reaches the services on.
- **Container hardening:** api, mcp, web (and migrate, tools) run with a read-only root filesystem
  (`/tmp` is a tmpfs; mcp writes only its volume), all capabilities dropped, `no-new-privileges`; the
  services also have `init` and rotated JSON logs (10 MB × 5).
- **No uploads.** Sermonize stores no files outside PostgreSQL and the MCP SQLite volume, so it needs no
  S3/MinIO bucket.

### Prerequisites

- A Linux host with **Docker Engine ≥ 24 and the Compose plugin ≥ 2.20** (`docker compose version`;
  `depends_on.required` is used), `openssl` and `git`. 2 GB RAM is enough to start; more for large HNSW
  index builds.
- DNS `A`/`AAAA` records of the domain pointing at the host (`dig +short sermonize.example.org`).
- Outbound HTTPS from the host (image builds or pulls, certificates, the MCP server's client metadata fetches).

### Images: build or pull

`deploy/compose.yml` names the images `${SERMONIZE_IMAGE_PREFIX}-{api,mcp,web,tools}:${SERMONIZE_TAG}`.

- **Build locally** (default: `SERMONIZE_IMAGE_PREFIX=sermonize`): `docker compose build`. Set
  `SERMONIZE_TAG` to e.g. the git commit to keep the previous images for a rollback.
- **Prebuilt from GHCR**: `SERMONIZE_IMAGE_PREFIX=ghcr.io/jsilvanus/sermonize`, `SERMONIZE_TAG=v1.2.3`,
  then `docker compose pull` and `docker compose up -d --no-build`. The `Images` workflow
  (`.github/workflows/images.yml`) publishes them when a `v*` tag is pushed (tags `vX.Y.Z` and `latest`)
  or when it is run by hand (tags: branch name and `sha-<commit>`, never `latest`). If the packages are
  private, `docker login ghcr.io` first (a token with `read:packages`).

### `deploy/.env`

`sh scripts/init-env.sh host-nginx|traefik <domain>` writes `deploy/.env` (mode 0600) from
`.env.example` with fresh secrets and the setup's `COMPOSE_FILE`/`COMPOSE_PROFILES`, so every
`docker compose …` run in `deploy/` uses the right files. It never overwrites an existing `.env`.

| variable | default | used by | |
|---|---|---|---|
| `COMPOSE_FILE` / `COMPOSE_PROFILES` | Setup A: `compose.yml:host-nginx/compose.host-nginx.yml` / `bundled-db` | compose | which files and profiles |
| `DOMAIN` | required | mcp, proxy | public host name; `MCP_PUBLIC_URL=https://$DOMAIN` |
| `SERMONIZE_IMAGE_PREFIX` / `SERMONIZE_TAG` | `sermonize` / `latest` | compose | see [Images](#images-build-or-pull) |
| `DATABASE_OWNER_URL` | required | migrate, tools, backups | the schema owner |
| `DATABASE_APP_URL` | required | api (`DATABASE_URL`), migrate | `sermonize_app`, or the owner URL in `owner` mode |
| `SERMONIZE_APP_ROLE_MODE` | `app` | migrate | `app` or `owner` ([roles](#database-roles)) |
| `POSTGRES_PASSWORD` | bundled db only | db | owner `sermonize`; only applied when the volume is initialised |
| `MCP_JWT_SECRET` | required | mcp (`JWT_SECRET`) | base64, ≥ 32 bytes |
| `MCP_TOKEN_KEY` | required | mcp (`SERMONIZE_TOKEN_KEY`) | base64 of exactly 32 bytes |
| `WEB_COOKIE_SECRET` | required | web | ≥ 32 characters |
| `REGISTRATION_OPEN` / `REGISTRATION_DEFAULT_ROLE` | `false` / `reader` | api | self-registration on the web UI |
| `LOGIN_TOKEN_TTL_HOURS` / `MCP_LOGIN_TOKEN_TTL_HOURS` / `CLI_LOGIN_TOKEN_TTL_HOURS` | `12` / `720` / `12` | api | login token lifetimes |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `10` / `60` | api | per client IP, register and login |
| `MAX_BATCH_ITEMS` | `5000` | api | items per batch request |
| `LOG_LEVEL` | `info` | api, mcp, web | |
| `MCP_REQUEST_TIMEOUT_MS` / `WEB_REQUEST_TIMEOUT_MS` | `15000` / `10000` | mcp / web | upstream API timeouts |
| `SERMONIZE_BACKEND_SUBNET` | `172.28.0.0/24` | compose, api `TRUST_PROXY` | change if it collides |
| `WEB_HOST_PORT` / `API_HOST_PORT` / `MCP_HOST_PORT` | `18100` / `18101` / `18102` | Setup A | loopback ports for host nginx |
| `SERMONIZE_EDGE_SUBNET` / `SERMONIZE_EDGE_GATEWAY` | `172.28.1.0/24` / `172.28.1.1` | Setup A | `TRUST_PROXY` of web, mcp, api |
| `TRAEFIK_NETWORK` / `SHARED_NETWORK` | `traefik-public` / `shared_multi_network` | Setup B | infra's external networks |
| `TRAEFIK_TRUSTED_CIDR` | required in Setup B | Setup B | subnet of `TRAEFIK_NETWORK` (`TRUST_PROXY`) |
| `TRAEFIK_ENTRYPOINT` / `TRAEFIK_CERTRESOLVER` | `websecure` / `letsencrypt` | Setup B | names in infra's Traefik |
| `ADMIN_ALLOW_CIDRS` | `0.0.0.0/0,::/0` | Setup B | allowlist for `/api/admin/` |

Fixed in the compose files: `PUBLIC_BASE_PATH=/api` (the API prefixes its OpenAPI `servers`, Swagger UI
asset URLs and root-relative redirects with it; the proxy strips `/api`), `SERMONIZE_API_URL=http://sermonize-api:3000`
for web, mcp and tools, `WEB_COOKIE_SECURE=true`, `STORAGE_PATH=/data/app.sqlite`, `HOST=0.0.0.0`,
and each service's `TRUST_PROXY` (below).

Database URLs: percent-encode special characters in passwords (the generated hex passwords need none).

### Database roles and migrations

The `migrate` service (`sermonize-migrate`, [`deploy/scripts/migrate.sh`](../deploy/scripts/migrate.sh))
runs before the API on every `docker compose up`; it is idempotent. It

1. checks the owner's connection and **pgvector**. The server must have pgvector installed (it must appear in
   `pg_available_extensions`): the bundled db uses `pgvector/pgvector:0.8.1-pg16`; a shared server's image must
   install the package `postgresql-16-pgvector` (the official `postgres:16` image does **not** include it) or be
   a pgvector image. The extension must then be installed in the database or be creatable by the owner.
   pgvector's control file is not `trusted`, so `CREATE EXTENSION vector` (in migration 0001, written
   `IF NOT EXISTS`) needs a **superuser**: the bundled db's owner is one; on a shared server an administrator
   runs it once (`psql -U postgres -d sermonize_db -c 'CREATE EXTENSION IF NOT EXISTS vector'`). Otherwise
   migrate stops with exactly these instructions;
2. applies pending migrations as the owner (`DATABASE_OWNER_URL`);
3. withdraws `PUBLIC` access to the `private` schema and its functions (again);
4. handles the API's role according to `SERMONIZE_APP_ROLE_MODE` (below);
5. checks that `DATABASE_APP_URL` connects.

#### Database roles

`SERMONIZE_APP_ROLE_MODE` has two values:

- **`app`** (default, both setups): the API connects as the least-privileged `sermonize_app`
  ([`sql/roles.sql`](../packages/api/sql/roles.sql): no table access in `private`, no ownership, so it cannot
  disable triggers or alter tables). `DATABASE_APP_URL` must use the user `sermonize_app`.
- **`owner`**: the API connects as the schema owner (`DATABASE_APP_URL` = `DATABASE_OWNER_URL`); migrate does
  nothing with roles and logs a warning. **Weaker isolation**: the API may then alter tables, disable triggers
  and read `private` directly, so the database no longer enforces immutability and the PII boundary against an
  API compromise. Use it only when no role can be created.

Any other value stops migrate.

In `app` mode migrate looks at the database and takes one of four paths; the log says which:

| situation | what migrate does | typical for |
|---|---|---|
| `sermonize_app` missing, the owner may create roles (superuser, or `CREATEROLE`) | `roles.sql` creates the role and grants, `GRANT CONNECT`, password from `DATABASE_APP_URL` | first start with the bundled db; a shared server where the owner has `CREATEROLE` |
| `sermonize_app` exists and the owner can manage it (superuser, or `CREATEROLE` **and** `ADMIN OPTION` on it) | grants (`roles.sql`), `GRANT CONNECT`, and **syncs the password** from `DATABASE_APP_URL` | every later start of the two cases above |
| `sermonize_app` exists and the owner cannot manage it (an administrator created it) | grants and `GRANT CONNECT` only; **the role and its password are left unchanged** (the log says how to rotate) | shared server with a pre-created role |
| `sermonize_app` missing, the owner may not create roles | stops with the one-time SQL for an administrator (below) | shared server, nothing prepared yet |

The password is read by psql from the environment (`\getenv`) and quoted by psql (`:'var'`); it never appears on a
command line and must be at least 16 characters. The grants are the owner's to give (it owns the tables), so
they are re-applied on every run, also for a role an administrator created.

**PostgreSQL ≥ 16 and `CREATEROLE`.** Since PostgreSQL 16 a non-superuser with `CREATEROLE` can only alter,
drop and change the password of roles on which it holds `ADMIN OPTION`, and it receives `ADMIN OPTION`
automatically on every role it creates. So an owner with `CREATEROLE` can create and manage its own
`sermonize_app` but cannot touch other applications' roles or superusers: granting it is safe. migrate checks
this with `pg_has_role(current_user, 'sermonize_app', 'USAGE WITH ADMIN OPTION')`. (On PostgreSQL ≤ 15,
`CREATEROLE` could alter any non-superuser role; there migrate sets the password when it creates the role and
leaves it unchanged afterwards, since the owner holds no `ADMIN OPTION`.)

**When the owner may not create roles**, migrate stops and an administrator (superuser) does one of these once:

```sql
-- a) let the owner create roles; migrate then creates sermonize_app and keeps its password in sync
ALTER ROLE sermonize_user CREATEROLE;

-- b) or create the role with the password from DATABASE_APP_URL; migrate then applies the grants only
CREATE ROLE sermonize_app LOGIN PASSWORD '<password from DATABASE_APP_URL>';
GRANT CONNECT ON DATABASE sermonize_db TO sermonize_app;
```

`init-env.sh` prints both with the generated password for an external database. migrate prints the same SQL
with a placeholder (it does not write the password into its logs).

**Rotating the password.**

- migrate manages the role (it created it, or the owner is a superuser): generate a new password
  (`openssl rand -hex 32`), put it into `DATABASE_APP_URL` in `deploy/.env`, `docker compose up -d`. migrate sets
  it before the API restarts.
- An administrator created the role: they run `ALTER ROLE sermonize_app PASSWORD '<new>';`, then update
  `DATABASE_APP_URL` and `docker compose up -d`. If `DATABASE_APP_URL` does not match, migrate's final
  connection check fails and says so. Alternatively, if the owner has `CREATEROLE`, a superuser can drop the role
  (`DROP OWNED BY sermonize_app; DROP ROLE sermonize_app;` in `sermonize_db`) and the next run recreates it,
  after which migrate manages it.

Role names are cluster-wide: one `sermonize_app` per PostgreSQL server (one Sermonize database per server).
The `REVOKE CREATE ON SCHEMA public FROM PUBLIC` in `roles.sql` needs the owner to own the `public` schema,
which is the case on PostgreSQL ≥ 15 for the database owner.

`deploy/tests/migrate-roles.sh` tests these paths against a throwaway PostgreSQL ≥ 16 server with pgvector
(superuser owner, `CREATEROLE` owner with password sync, owner without `CREATEROLE`, pre-created role, `owner`
mode, an unknown mode). It creates and drops `smz_mt_*` databases and roles and the cluster-wide
`sermonize_app`; CI runs it in the tools image.

If `up` stops at migrate, read `docker compose logs migrate`, fix the cause, run `docker compose up -d` again.
Migrations are forward-only: to roll back, restore the backup taken before the update and start the
previous images (`SERMONIZE_TAG`).

### First admin and `sermonize-admin`

```sh
sh scripts/bootstrap-admin.sh you@example.org "Your Name"     # hidden password prompt, 12-256 characters
```

It runs the API's database CLI in the tools container as the schema owner (bundled or external database).
Then administer users from your own machine over HTTPS; the API URL includes the `/api` prefix:

```sh
# in a checkout: npm ci && npm run build -w @sermonize/cli
export SERMONIZE_API_URL=https://sermonize.example.org/api
node packages/cli/dist/index.js login --email you@example.org      # or: npm run admin -- login ...
node packages/cli/dist/index.js users list
```

or on the server, on the internal network (not subject to a proxy allowlist; the login token lives only as
long as that container):

```sh
docker compose run --rm tools sh -c 'sermonize-admin login --email you@example.org && sermonize-admin users list'
```

MCP clients use `https://sermonize.example.org/mcp`; users sign in with their Sermonize account on the
OAuth page the client opens ([`packages/mcp/README.md`](../packages/mcp/README.md)).

### Checks after a deployment

```sh
D=https://sermonize.example.org
curl -fsS $D/api/health                         # {"status":"ok","database":"ok"}
curl -fsS $D/api/stats
curl -si  $D/mcp -X POST | grep -i www-authenticate
# WWW-Authenticate: Bearer resource_metadata="https://sermonize.example.org/.well-known/oauth-protected-resource/mcp", scope="mcp"
curl -fsS $D/.well-known/oauth-authorization-server
curl -s -o /dev/null -w '%{http_code}\n' $D/health          # 404: not public
```

and open `$D/` and `$D/api/docs` in a browser.

### Client IPs, `TRUST_PROXY` and rate limiting

The API rate-limits register and login **per client IP**. The edge proxy puts the client address into
`X-Forwarded-For` (replacing whatever the client sent), web and mcp forward the browser's address to the
API on sign-in, and each service trusts exactly the hops in front of it:

| service | trusts (`TRUST_PROXY`) | Setup A | Setup B |
|---|---|---|---|
| web, mcp | the proxy | `SERMONIZE_EDGE_GATEWAY` (172.28.1.1) | `TRAEFIK_TRUSTED_CIDR` |
| api | the proxy + web + mcp | `SERMONIZE_EDGE_GATEWAY`, `SERMONIZE_BACKEND_SUBNET` | `TRAEFIK_TRUSTED_CIDR`, `SERMONIZE_BACKEND_SUBNET` |

If a CDN or another proxy sits in front of the edge proxy, configure it to trust that one (nginx `real_ip`
module; Traefik `forwardedHeaders.trustedIPs` in infra), otherwise all users share its rate-limit bucket.

### Vector indexes

Semantic search works without an index (exact scan). For large embedding spaces build the partial HNSW
index in the tools container (as the schema owner; `CREATE INDEX CONCURRENTLY`, the API keeps serving):

```sh
docker compose run --rm tools sermonize-db create-index <embedding-space-id>
docker compose run --rm tools sermonize-db drop-index <embedding-space-id>
```

The bundled db has `shm_size: 256mb` for parallel builds; raise it (and `maintenance_work_mem`) for very
large spaces; on a shared server ask its administrator. Other commands: `docker compose run --rm tools sermonize-db help`.

### Backups

| what | how | lost without it |
|---|---|---|
| database | `sh scripts/backup-db.sh` → `deploy/backups/sermonize-db-<UTC>.dump` (pg_dump custom format, run in the tools container against `DATABASE_OWNER_URL`: bundled and external alike; checked with `pg_restore --list`) | everything |
| MCP SQLite (`mcp_data`) | `sh scripts/backup-mcp.sh` → `deploy/backups/sermonize-mcp-<UTC>.sqlite` (`VACUUM INTO`, safe while running) | only MCP sign-ins |
| `deploy/.env` | by hand, into a password manager, not next to the backups | passwords, cookie and token keys |

A shared server's own backups (infra) are an addition, not a replacement: `backup-db.sh` gives you a
dump you can restore into either setup. Nightly example (root's crontab; copy the files off the host):

```cron
17 3 * * * cd /opt/sermonize/deploy && sh scripts/backup-db.sh >/dev/null && sh scripts/backup-mcp.sh >/dev/null && find backups -type f -mtime +14 -delete
```

Restore (replaces all data; asks you to type `restore`):

```sh
sh scripts/restore-db.sh backups/sermonize-db-20260101T031700Z.dump
```

It stops web, mcp and api, runs migrate (extension check, schema), restores as the owner in one
transaction **without ownership, privileges and extension entries** (so a dump moves between the bundled
and a shared database), runs migrate again (newer migrations, `PUBLIC` revokes, the app role's grants) and
starts everything. The dump is buffered in the tools container's memory-backed `/tmp`. Restore the MCP file
with mcp stopped:

```sh
docker compose stop mcp
docker compose run --rm --no-deps -v "$PWD/backups:/restore:ro" --entrypoint sh mcp \
  -c 'rm -f /data/app.sqlite-wal /data/app.sqlite-shm && cp /restore/sermonize-mcp-20260101T031700Z.sqlite /data/app.sqlite'
docker compose start mcp
```

### Updates

```sh
cd /opt/sermonize && git pull && cd deploy     # compose files and scripts
sh scripts/backup-db.sh                        # always, before migrations
docker compose build                           # or: set SERMONIZE_TAG=vX.Y.Z and `docker compose pull`
docker compose up -d --wait                    # runs migrate, recreates changed services
docker compose ps && docker compose logs migrate
```

Base images: `docker compose build --pull` picks up security updates of `node:22-bookworm-slim`;
`docker compose pull db` those of `pgvector/pgvector` (bundled db). A major PostgreSQL upgrade of the
bundled db (pg16 → pg17) needs a dump and restore into a new volume.

### Logs

```sh
docker compose logs -f api mcp web       # JSON (pino); the apps never log tokens or bodies
docker compose ps                        # health
```

Always run `docker compose` without `--profile` flags for `up`/`down` (a `--profile` flag replaces
`COMPOSE_PROFILES` from `.env`, e.g. `down` would then leave the bundled db running); `run tools` enables
the tools profile by itself.

### Security checklist

- [ ] `deploy/.env` is mode 0600, not in git (`.gitignore`), and its secrets are in a password manager.
      Every secret was generated (`init-env.sh`), none reused.
- [ ] **Registration stays off** (`REGISTRATION_OPEN=false`) unless you want public sign-ups; if on,
      `REGISTRATION_DEFAULT_ROLE=reader`.
- [ ] The API uses `sermonize_app` (`app` mode), not the owner, unless you accepted `owner` mode.
- [ ] Consider the **admin allowlist** (Setup A: `/etc/nginx/sermonize/admin-allow.conf`; Setup B:
      `ADMIN_ALLOW_CIDRS`).
- [ ] Only the proxy is reachable from outside: Setup A publishes the containers on `127.0.0.1` only (Docker's
      published ports bypass ufw, which is why nothing else is published); firewall: 22 (restricted), 80, 443.
- [ ] SSH with keys only; unattended OS security updates; images rebuilt/pulled regularly.
- [ ] Backups run, are copied off the host, and a restore has been tested.
- [ ] Few admins; tokens for scripts per service user with an expiry (`sermonize-admin tokens create --expires-at …`).
- [ ] HSTS is sent for two years with `includeSubDomains`; make sure every subdomain can do HTTPS (or drop it:
      `snippets/hsts.conf`, or the `sermonize-hsts`/`sermonize-secheaders` labels).

## Setup A: host nginx

nginx and certbot are installed on the host and may serve other sites too. The stack publishes web, api
and mcp on `127.0.0.1:18100/18101/18102` (`WEB_HOST_PORT`, `API_HOST_PORT`, `MCP_HOST_PORT`; high
ports away from common defaults), on the `edge` network (`172.28.1.0/24`, gateway `172.28.1.1`).

Why the gateway is the proxy address: a connection from the host to a published port reaches the
container from the `edge` gateway, whether Docker forwards it with its userland proxy (the default for
`127.0.0.1`) or with NAT. The containers therefore see `172.28.1.1` as the peer and trust it; nginx
**replaces** `X-Forwarded-For` with `$remote_addr`, so the real client address reaches web, mcp and the
API, and clients cannot inject one. (Verified: a spoofed `X-Forwarded-For` is ignored, and two clients get
separate rate-limit buckets.) `edge` is not internal, so api/migrate/tools can also reach an external
database.

1. **Install** Docker (Engine ≥ 24, Compose ≥ 2.20), nginx and certbot:
   `sudo apt install nginx certbot python3-certbot-nginx`. Open 80 and 443
   (`ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable`).
2. **Get the code** and create the settings (bundled PostgreSQL, whose superuser owner lets migrate create
   `sermonize_app`):
   ```sh
   sudo git clone https://github.com/jsilvanus/sermonize.git /opt/sermonize && cd /opt/sermonize/deploy
   sudo sh scripts/init-env.sh host-nginx sermonize.example.org
   ```
   External database instead: `DB=external DB_OWNER_URL=postgres://owner:pw@db.example.org:5432/sermonize
   sh scripts/init-env.sh host-nginx …` (it prints what an administrator may have to run for `sermonize_app`;
   see [Database roles](#database-roles)). A PostgreSQL
   on the same host is `host.docker.internal` (Docker's host gateway, usually `172.17.0.1`): it must listen
   there and allow `SERMONIZE_EDGE_SUBNET` in `pg_hba.conf`.
3. **Images and start**:
   ```sh
   sudo docker compose build            # or pull prebuilt images (Images section)
   sudo docker compose up -d --wait     # db → migrate → api → web, mcp
   sudo docker compose ps               # healthy, migrate exited (0); ports 127.0.0.1:181xx
   ```
4. **Certificate** (DNS must point here, port 80 open). With nginx running (its default site on port 80
   is enough), certbot's nginx plugin answers the challenge without touching the Sermonize site:
   ```sh
   sudo certbot certonly --nginx -d sermonize.example.org
   ```
   (or `--webroot -w /var/www/html` for a webroot the running nginx serves). Renewal runs from certbot's
   systemd timer; it reloads nginx with the nginx plugin. Once the site is installed, its port-80 server also
   serves `/.well-known/acme-challenge/` from `/var/www/letsencrypt` for `certbot … --webroot -w /var/www/letsencrypt`.
5. **Install the site**:
   ```sh
   sudo sh host-nginx/install.sh
   ```
   It copies `snippets/` to `/etc/nginx/sermonize/snippets/`, `admin-allow.conf` to `/etc/nginx/sermonize/`
   (only the first time), renders `sermonize.conf` with `DOMAIN`, the ports and the certificate directory
   (`/etc/letsencrypt/live/DOMAIN`, override with `CERT_DIR=`) into `/etc/nginx/sites-available/`, symlinks it
   into `sites-enabled/` (or writes `conf.d/sermonize.conf`), runs `nginx -t` (restoring the previous file if
   it fails) and reloads nginx. Hosts without IPv6 get no `listen [::]` lines (`IPV6=0|1` overrides).
   The site: HTTP → HTTPS redirect, Mozilla intermediate TLS, HSTS, `X-Forwarded-*` headers,
   an access log without query strings (`/var/log/nginx/sermonize.access.log`; OAuth codes travel in
   queries), 64 MiB bodies and 300 s timeouts on `/api/`, no buffering and 1 h timeouts on `/mcp`, gzip.
   It defines no `default_server`, so it coexists with other sites.
6. **First admin**: `sudo sh scripts/bootstrap-admin.sh you@example.org "Your Name"`, then
   [`sermonize-admin`](#first-admin-and-sermonize-admin) against `https://sermonize.example.org/api`.
7. **Checks** ([above](#checks-after-a-deployment)), backups in cron ([Backups](#backups)).

Changing ports, the domain or the certificate: edit `.env`, `docker compose up -d`, run `install.sh` again.
Admin allowlist: edit `/etc/nginx/sermonize/admin-allow.conf`, `sudo nginx -t && sudo systemctl reload nginx`.

## Setup B: Traefik (riksunsrk infra)

The app follows the `riksunsrk/infra` conventions: no host ports; web, api and mcp join `traefik-public`
and carry Traefik labels (`entrypoints=websecure`, `tls.certresolver=letsencrypt`,
`traefik.docker.network=traefik-public`); api, migrate and tools join `shared_multi_network` for the shared
PostgreSQL at `pg.shared.local:5432`; there is no bundled database. Network, entrypoint and resolver names
are overridable (`TRAEFIK_NETWORK`, `SHARED_NETWORK`, `TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER`).

Routers (all `Host(DOMAIN)`, explicit priorities):

| router | priority | rule | middlewares | service |
|---|---|---|---|---|
| `sermonize-mcp` | 300 | `Path(/mcp)`, `PathPrefix(/oauth/)`, the four discovery paths (exact) | `sermonize-secheaders` | mcp:5999 |
| `sermonize-api-admin` | 250 | `PathPrefix(/api/admin/)` | `sermonize-admin-allow` (ipAllowList, `ADMIN_ALLOW_CIDRS`), strip, secheaders | api:3000 |
| `sermonize-api` | 200 | `Path(/api) \|\| PathPrefix(/api/)` | `sermonize-api-slash` (`/api` → `/api/`), `sermonize-api-strip` (stripprefix `/api`), secheaders | api:3000 |
| `sermonize-web` | 1 | everything else | `sermonize-hsts` | web:3100 |

`sermonize-secheaders` = HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (the
API and the MCP server set none); the web UI sets its own and gets HSTS only. Other `/.well-known/` paths
and the MCP server's `/health` land on the web UI, which answers 404. Traefik streams responses (MCP
Server-Sent Events) without buffering and has no request body limit (the API enforces 64 MiB); infra's
`websecure` entrypoint must not set a short `respondingTimeouts.writeTimeout`, or long MCP streams are cut.
Traefik only routes to healthy containers, so a restarting service answers 404 for a few seconds.

`TRUST_PROXY`: web and mcp trust `TRAEFIK_TRUSTED_CIDR` (the subnet of `traefik-public`, since Traefik's
address in it is not fixed), the API additionally the backend subnet. Traefik drops `X-Forwarded-For` from
clients it does not trust and sets the real client address itself. Find the subnet with
`docker network inspect traefik-public -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}'` (`init-env.sh`
fills it in when it can see the network). Other containers on `traefik-public` are trusted as proxies too:
they could choose the address web/mcp/api rate-limit by, nothing more.

**Infra onboarding** (in `riksunsrk/infra`, once):

1. **Networks**: `traefik-public` and `shared_multi_network` exist on the host (infra creates them).
2. **Database**: `DB_USER=$DB_USER DB_PASSWORD=$DB_PASSWORD ./scripts/add-app.sh sermonize <strong-password>`
   (or the `Database – Create App User` workflow) → role `sermonize_user`, database `sermonize_db`. Use a
   hex password (`openssl rand -hex 32`) or percent-encode it in the URL.
3. **pgvector** in the shared server: the server image must have it installed. infra's database currently runs
   the official `postgres:16` image, which does **not** include pgvector: it needs the package
   `postgresql-16-pgvector` installed in the image (or the `pgvector/pgvector:0.8.1-pg16` image). Then, as a
   superuser, once:
   ```sh
   docker compose -f infra/database/docker-compose.yml exec postgres \
     psql -U "$DB_USER" -d sermonize_db -c 'CREATE EXTENSION IF NOT EXISTS vector'
   ```
4. **API role** (`app` mode, the default). `add-app.sh` currently creates `sermonize_user` as a plain `LOGIN`
   role (no `CREATEROLE`) and runs `REVOKE ALL ON DATABASE sermonize_db FROM PUBLIC`, so `sermonize_app` needs an
   explicit `GRANT CONNECT` (migrate gives it, or the administrator below). As a superuser, **one** of:
   ```sql
   -- a) recommended: sermonize_user may create roles (PostgreSQL >= 16: only manage the ones it creates);
   --    migrate creates sermonize_app and keeps its password in sync with DATABASE_APP_URL
   ALTER ROLE sermonize_user CREATEROLE;
   -- b) or pre-create the role, with the password from DATABASE_APP_URL (app step 1 below prints it);
   --    migrate applies the grants only and never changes the role or its password
   CREATE ROLE sermonize_app LOGIN PASSWORD '<password>';
   GRANT CONNECT ON DATABASE sermonize_db TO sermonize_app;
   ```
   Without either, use `SERMONIZE_APP_ROLE_MODE=owner` and `DATABASE_APP_URL` = `DATABASE_OWNER_URL` (weaker isolation).
   An infra change that adds pgvector and options for extensions and `CREATEROLE` to `add-app.sh` is being
   handled separately in `riksunsrk/infra`; until it lands, steps 3 and 4 are manual.
5. **No object storage**: Sermonize stores no uploads, so skip `add-app-storage.sh`.
6. **Metrics (open item)**: riksunsrk apps are expected to expose a bearer-gated (`METRICS_BEARER_TOKEN`)
   Prometheus `/metrics` endpoint. Sermonize does not have one yet, so skip the scrape job and
   `METRICS_TOKEN_SERMONIZE` until it exists.
7. Store the connection strings and secrets in the app repository's GitHub Actions secrets (or the host's
   `deploy/.env`), per infra's rules; `rotate-secret.sh` targets can then keep them current.

**App deployment** (on the host, as the app deploy user):

1. Get the code (or only `deploy/`) and create the settings:
   ```sh
   git clone https://github.com/jsilvanus/sermonize.git /opt/sermonize && cd /opt/sermonize/deploy
   DB_OWNER_URL=postgres://sermonize_user:<password>@pg.shared.local:5432/sermonize_db \
     sh scripts/init-env.sh traefik sermonize.example.org
   ```
   Check `TRAEFIK_TRUSTED_CIDR`; hand the printed SQL (option a or b) to the infra administrator (onboarding step 4).
2. Images: `docker compose build`, or `SERMONIZE_IMAGE_PREFIX=ghcr.io/jsilvanus/sermonize`,
   `SERMONIZE_TAG=vX.Y.Z` in `.env` and `docker compose pull`.
3. Start: `docker compose up -d --wait` (add `--no-build` with pulled images). migrate stops with an
   explicit message (and the SQL to run) if pgvector or `sermonize_app` is missing.
4. First admin: `sh scripts/bootstrap-admin.sh you@example.org "Your Name"`, then `sermonize-admin`
   against `https://sermonize.example.org/api`.
5. Verify: `curl -I https://sermonize.example.org` and the [checks](#checks-after-a-deployment); backups in cron.

## Local testing

- **Setup A**: `DOMAIN=localhost` (`init-env.sh host-nginx localhost`), a self-signed certificate
  (`openssl req -x509 -nodes -newkey rsa:2048 -days 7 -subj /CN=localhost -addext subjectAltName=DNS:localhost
  -keyout privkey.pem -out fullchain.pem`), `CERT_DIR=<that directory> sh host-nginx/install.sh`, then
  `curl --cacert fullchain.pem https://localhost/api/health`; `sermonize-admin` with
  `NODE_EXTRA_CA_CERTS=fullchain.pem SERMONIZE_API_URL=https://localhost/api`.
- **Setup B**: create the two networks, run a Traefik v3 (≥ 3.6.1 for Docker Engine 29) container on
  `traefik-public` with the Docker provider, a `websecure` entrypoint and a self-signed default certificate
  (a missing `letsencrypt` resolver only logs an error; the default certificate is served), and a
  `pgvector/pgvector` container on `shared_multi_network` with the alias `pg.shared.local` in which you create
  `sermonize_user`/`sermonize_db` and the extension as described above.
