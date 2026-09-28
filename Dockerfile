# Sermonize production images: one build of the npm workspace, one target per service.
#
#   docker build --target api   -t sermonize-api   .
#   docker build --target mcp   -t sermonize-mcp   .
#   docker build --target web   -t sermonize-web   .
#   docker build --target tools -t sermonize-tools .   # migrations, DB CLI, sermonize-admin, psql
#
# deploy/compose.yml builds all four (or pulls them: SERMONIZE_IMAGE_PREFIX). See docs/deployment.md.

# Base image (override to pin a digest, e.g. --build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:...).
# Debian (glibc) rather than Alpine: the lockfile's native @node-rs/argon2 binary is the gnu one.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------------------------
# Workspace manifests only, so dependency layers are cached until a package.json changes.
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY packages/web/package.json packages/web/

# ---------------------------------------------------------------------------------------------
# Build: full install (dev dependencies: TypeScript), compile every workspace once.
FROM manifests AS build
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
RUN --mount=type=cache,target=/root/.npm npm ci
COPY packages/api/ packages/api/
COPY packages/cli/ packages/cli/
COPY packages/mcp/ packages/mcp/
COPY packages/web/ packages/web/
RUN npm run build

# ---------------------------------------------------------------------------------------------
# Production dependencies, one set per service (npm hoists them into /app/node_modules).
# `mkdir -p` makes sure the package-level node_modules exists for the COPY below.
FROM manifests AS deps-api
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace @sermonize/api && mkdir -p packages/api/node_modules

FROM manifests AS deps-mcp
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace @sermonize/mcp && mkdir -p packages/mcp/node_modules

FROM manifests AS deps-web
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace @sermonize/web && mkdir -p packages/web/node_modules

# ---------------------------------------------------------------------------------------------
# Common runtime settings. The `node` user (uid 1000) comes with the base image.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    npm_config_update_notifier=false
WORKDIR /app
COPY --chown=root:root package.json ./

# ---------------------------------------------------------------------------------------------
FROM runtime AS api
COPY --from=deps-api /app/node_modules ./node_modules
COPY --from=deps-api /app/packages/api/node_modules ./packages/api/node_modules
COPY packages/api/package.json packages/api/
COPY packages/api/migrations/ packages/api/migrations/
COPY packages/api/sql/ packages/api/sql/
COPY --from=build /app/packages/api/dist/ packages/api/dist/
ENV PORT=3000
EXPOSE 3000
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "packages/api/dist/server.js"]

# ---------------------------------------------------------------------------------------------
FROM runtime AS mcp
COPY --from=deps-mcp /app/node_modules ./node_modules
COPY --from=deps-mcp /app/packages/mcp/node_modules ./packages/mcp/node_modules
COPY packages/mcp/package.json packages/mcp/
COPY --from=build /app/packages/mcp/dist/ packages/mcp/dist/
# SQLite storage (OAuth grants, codes, refresh tokens): mount a volume here. A new named volume
# copies this directory's ownership, so the non-root user can write to it.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
ENV PORT=5999 \
    STORAGE_PATH=/data/app.sqlite
EXPOSE 5999
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||5999)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "packages/mcp/dist/server.js"]

# ---------------------------------------------------------------------------------------------
FROM runtime AS web
COPY --from=deps-web /app/node_modules ./node_modules
COPY --from=deps-web /app/packages/web/node_modules ./packages/web/node_modules
COPY packages/web/package.json packages/web/
COPY --from=build /app/packages/web/dist/ packages/web/dist/
ENV PORT=3100
EXPOSE 3100
USER node
# The web app has no health route; its stylesheet needs no API call.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/style.css').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "packages/web/dist/server.js"]

# ---------------------------------------------------------------------------------------------
# Operations image: the API's database CLI (migrations, first admin, tokens, vector indexes),
# sermonize-admin (user management over HTTP), psql/pg_dump (PostgreSQL 17 client) and the migrate script.
#   sermonize-db <command>      = node packages/api/dist/cli.js <command>   (needs DATABASE_URL)
#   sermonize-admin <command>   = node packages/cli/dist/index.js <command> (needs SERMONIZE_API_URL)
#   sermonize-migrate           = pgvector check, migrations, app role per SERMONIZE_APP_ROLE_MODE (deploy/scripts/migrate.sh)
FROM api AS tools
USER root
# PostgreSQL client from the PGDG repository (key shipped by Debian's postgresql-common): pg_dump must be
# at least as new as the server (bundled pg16, or a shared server that may be newer than Debian's 15).
ARG PG_CLIENT_MAJOR=17
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates postgresql-common \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends "postgresql-client-${PG_CLIENT_MAJOR}" \
 && rm -rf /var/lib/apt/lists/*
COPY packages/cli/package.json packages/cli/
COPY --from=build /app/packages/cli/dist/ packages/cli/dist/
COPY deploy/scripts/migrate.sh /usr/local/bin/sermonize-migrate
RUN chmod 0755 /usr/local/bin/sermonize-migrate packages/cli/dist/index.js \
 && ln -s /app/packages/cli/dist/index.js /usr/local/bin/sermonize-admin \
 && printf '#!/bin/sh\nexec node /app/packages/api/dist/cli.js "$@"\n' > /usr/local/bin/sermonize-db \
 && chmod 0755 /usr/local/bin/sermonize-db
USER node
# sermonize-admin keeps its login token under $HOME/.config (not persisted: use --rm runs and log in each time).
ENV HOME=/home/node
HEALTHCHECK NONE
CMD ["sermonize-db", "help"]
