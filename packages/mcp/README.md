# @sermonize/mcp

A thin remote [MCP](https://modelcontextprotocol.io) server for Sermonize. MCP clients (Claude,
ChatGPT, Cursor, ...) sign in with OAuth and get tools to browse the corpus, run semantic search
with a caller-supplied vector, inspect clusters and provenance, create scholarly records, and
propose and review cluster labels.

It is a **relay**, not a second backend:

- it talks **only** to the Sermonize REST API over HTTP (`SERMONIZE_API_URL`), never to PostgreSQL;
- it has no domain logic beyond mapping tool arguments to API paths, query strings and bodies;
- it adds no AI processing: it never embeds, clusters, translates or labels anything.

Validation of content, permissions, visibility of restricted texts and audit all stay in the API.

Built from the Codestash scaffold `codestash/mcp/api-connector-style` (Streamable HTTP, embedded
OAuth authorization server with CIMD + PKCE, SQLite storage). [`LEARNED.md`](LEARNED.md) is that
scaffold's file, copied unchanged: read it before touching the OAuth plumbing (`src/oauth/`,
`src/auth.ts`, `src/oauth-metadata.ts`, `src/csp.ts`, `src/mcp/http.ts`). Sermonize changes to it:
the scaffold's demo user store is replaced by sign-in through the Sermonize API, and codes, refresh
tokens and access tokens belong to an OAuth *grant* that holds the upstream API token.

## Accounts: one Sermonize login

There are no MCP-specific users or passwords. People sign in on the MCP sign-in page with their
**Sermonize account** (the same email and password as in `@sermonize/web`; accounts are created by
self-registration on the web UI or by an admin through the API). The MCP server never stores or hashes
passwords: it passes them to the API's `POST /auth/login` with `client: "mcp"` and keeps the API token
it gets back, encrypted, for that OAuth grant. The OAuth subject (`sub`) is the Sermonize user id, and
every tool call runs with the user's own role, restrictions and audit identity.

## Architecture

```
 MCP client (Claude, ChatGPT, ...)
    |
    | Streamable HTTP
    | Bearer <MCP access token (JWT)>
    v
+------------------------------------+
| @sermonize/mcp (port 5999)         |
|                                    |
| /.well-known/*  OAuth discovery    |
| /oauth/*        embedded AS        |
|                 (CIMD, PKCE)       |
| /mcp            verify JWT         |
|    |            (sig, iss, aud)    |
|    v                               |
| grant = JWT sid (must be active),  |
| user  = JWT sub (Sermonize id)     |
|    |                               |
|    v                               |
| SQLite: grant -> API token         |
|   (AES-256-GCM, grant id as AAD)   |
|    |                               |
|    v                               |
| connector.ts (fetch + timeout)     |
+----|-------------------------------+
     |
     | HTTP, Bearer <the grant's
     |       Sermonize API token>
     v
+------------------------------------+
| @sermonize/api (port 3000)         |
| users, roles, validation, audit    |
+----|-------------------------------+
     v
 PostgreSQL + pgvector
```

### Sign-in flow

```
MCP client     browser         MCP server             Sermonize API
    |             |                 |                        |
    |-- open /oauth/authorize ----->|                        |
    |   (client_id=CIMD URL,        | fetch + check CIMD     |
    |    PKCE S256, resource)       | document, redirect_uri |
    |             |<-- sign-in page-|                        |
    |             |-- email, pw --->|                        |
    |             |                 |-- POST /auth/login --->|
    |             |                 |   {email, password,    |
    |             |                 |    client:"mcp"}       |
    |             |                 |   X-Forwarded-For: ip  |
    |             |                 |<-- token, expires_at,--|
    |             |                 |    user_id, role       |
    |             |                 | new pending grant:     |
    |             |                 |  sub=user_id,          |
    |             |                 |  token encrypted       |
    |             |<- consent page -|  (+ one-time ticket)   |
    |             |-- approve ----->|                        |
    |             |                 | grant active;          |
    |<-- redirect ?code=&state=&iss-|  code -> grant         |
    |                               |                        |
    |-- POST /oauth/token --------->|                        |
    |   code + code_verifier        | check PKCE, grant      |
    |<-- access JWT (sub, sid) -----|                        |
    |    + refresh token            |                        |
    |                               |                        |
    |-- POST /mcp tools/call ------>|                        |
    |   Bearer <JWT>                | sid -> API token       |
    |                               |-- GET /me etc. ------->|
    |                               |   Bearer <API token>   |
    |<-- tool result ---------------|<-----------------------|
```

- **Wrong credentials** (unknown email, wrong password, disabled account): the sign-in page again with
  the generic *"Invalid email or password."* (HTTP 401). The API's 429 becomes *"Too many sign-in
  attempts ..."* (429); an unreachable API (or 5xx) *"Sermonize cannot be reached right now ..."* (503).
- **Deny** at the consent step: redirect with `error=access_denied`; the API token is revoked at once.
- **Lifetimes.** Access tokens: 1 hour, never past the API token's `expires_at`. Refresh tokens:
  30 days, capped at the API token's `expires_at` (the API's `MCP_LOGIN_TOKEN_TTL_HOURS`, default
  720 h = 30 days). A signed-in user has 10 minutes to approve; an approved code must be exchanged
  within 60 seconds.
- **The grant ends** when its refresh token expires, when a sign-in is never approved, when consent is
  denied, or when the API answers 401 for its token (expired, revoked, account disabled). The grant,
  its codes and refresh tokens are then deleted; access tokens carrying its `sid` are answered with
  HTTP 401 + `WWW-Authenticate: ... error="invalid_token"`, the refresh token with `invalid_grant`,
  so the client re-authorizes. The tool call that hit the upstream 401 returns *"Your Sermonize
  sign-in has expired or was revoked ... Please sign in again ..."* with the `mcp/www_authenticate`
  hint. For grants that end while the API token may still be valid (expired refresh token, never
  approved, denied), the server also calls `POST /auth/logout` with that token (best-effort). Ended
  grants are swept every 10 minutes, and noticed at refresh time.
- There is no token revocation endpoint (RFC 7009) and no refresh-token rotation yet, as in the scaffold.

## Setup

Requirements: Node.js >= 22.12 (uses `node:sqlite`), a running Sermonize API, and a Sermonize account
with a password (register on the web UI, or have an admin create one).

```sh
# from the repository root
npm install
cp packages/mcp/.env.example packages/mcp/.env      # edit, then export (the server reads process.env only)
set -a; . packages/mcp/.env; set +a

# Secrets
export JWT_SECRET=$(openssl rand -base64 32)             # signs MCP access tokens
export SERMONIZE_TOKEN_KEY=$(openssl rand -base64 32)    # encrypts the per-grant Sermonize API tokens
export SERMONIZE_API_URL=http://127.0.0.1:3000

npm run dev:mcp            # or: npm run build && npm start -w @sermonize/mcp
```

Environment:

| variable | default | |
|---|---|---|
| `PORT` / `HOST` | `5999` / `127.0.0.1` | the API uses 3000, the web UI 3100 |
| `MCP_PUBLIC_URL` | `http://localhost:$PORT` | public **origin** (no path); OAuth issuer; the MCP resource is `<url>/mcp` |
| `TRUST_PROXY` | `false` | trusted reverse proxies (`true`, or comma-separated addresses/CIDRs, same as the API); decides the end-user IP forwarded to the API at sign-in |
| `JWT_SECRET` | required | base64, >= 32 bytes |
| `STORAGE_PATH` | `./data/app.sqlite` | OAuth grants (with encrypted API tokens), authorization codes, refresh tokens |
| `SERMONIZE_API_URL` | required | base URL of the REST API (sign-in and tools) |
| `SERMONIZE_TOKEN_KEY` | required | base64 of exactly 32 bytes (AES-256-GCM key) |
| `SERMONIZE_REQUEST_TIMEOUT_MS` | `15000` | timeout of one upstream request |
| `LOG_LEVEL` | `info` | |

On the **API** side: `MCP_LOGIN_TOKEN_TTL_HOURS` (default 720) sets how long an MCP sign-in lasts, and
the API's `TRUST_PROXY` must list this server's address, or every MCP sign-in shares one rate-limit bucket.

Removed (earlier versions): `MCP_DEFAULT_USER_ID`, `MCP_DEFAULT_USER_EMAIL`, `MCP_DEFAULT_USER_PASSWORD`
and the `mcp-user` CLI (`npm run mcp-user`, with `--api-token` linking). Users and their roles are managed
in the API only.

### Same domain as the web UI

The server can share one public origin with the web UI and the API, e.g. `MCP_PUBLIC_URL=https://example.org`:
the resource is `https://example.org/mcp`, the issuer `https://example.org`. All its routes are root paths that
the web UI does not use, so a reverse proxy routes by prefix:

| path | to |
|---|---|
| `/mcp` | MCP server |
| `/oauth/` (`/oauth/authorize`, `/oauth/token`) | MCP server |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | MCP server |
| `/api/` (prefix stripped) | API |
| everything else | web UI |

[`docs/deployment.md`](../../docs/deployment.md) is a complete nginx + Docker Compose setup for exactly this layout.
`/health` is also served, for the container health check (not needed publicly). The sign-in form posts to
the relative `/oauth/authorize`, and the CSP `form-action` is `'self'` plus the OAuth client's redirect origin
(see `LEARNED.md`).

### Upgrading an existing SQLite file

The schema version is kept in `PRAGMA user_version`. A file from before sign-in through the API (version 0)
is upgraded on start by **dropping** its old tables (`users`, `sermonize_api_tokens`, `authorization_codes`,
`refresh_tokens`) and creating the new ones: the old OAuth subjects were MCP user ids and their tokens were
linked by hand, so nothing can be carried over. Existing MCP clients get `invalid_token` / `invalid_grant`
and sign in again with their Sermonize account. The old linked API tokens are not revoked by this; revoke
them with the API CLI (`npm run cli -- revoke-token <id>`) if they are no longer needed.

## Tools

Results are the API's JSON, returned as text content. List tools pass `cursor` and `limit`
(1-500) through; use `next_cursor` from one page to get the next. The role is the minimum
Sermonize role the **API** enforces for the caller's account; the MCP server itself checks nothing
beyond "signed in". Read tools carry `readOnlyHint: true`; write tools
`readOnlyHint: false, destructiveHint: false`.

| tool | API | role |
|---|---|---|
| `whoami` | `GET /me` | reader |
| `search_persons` (`q`, `include_withdrawn`) | `GET /persons` | reader |
| `get_person` | `GET /persons/:id` | reader |
| `list_works` (`genre`, `person_id`, `year_from`, `year_to`, `part_of_work_id`) | `GET /works` | reader |
| `get_work` | `GET /works/:id` | reader |
| `list_sources` | `GET /sources` | reader |
| `get_source` | `GET /sources/:id` | reader |
| `list_texts` (`work_id`, `language`, `relation`, `source_id`) | `GET /texts` | reader |
| `get_text` | `GET /texts/:id` | reader |
| `get_text_body` (`start`, `end` in code points) | `GET /texts/:id/body` | reader; contributor for restricted texts |
| `get_chunk` (`include_embeddings`) | `GET /chunks/:id` | reader; contributor for restricted chunks |
| `get_chunk_provenance` | `GET /chunks/:id/provenance` | reader |
| `list_embedding_spaces` | `GET /embedding-spaces` | reader |
| `get_embedding_space` | `GET /embedding-spaces/:id` | reader |
| `semantic_search` (`embedding_space_id`, `vector`, `limit`, `filters`) | `POST /search` | reader; contributor for `include_restricted` |
| `list_clustering_runs` (`embedding_space_id`, `status`) | `GET /clustering-runs` | reader; contributor for non-complete runs |
| `get_clustering_run` | `GET /clustering-runs/:id` | reader |
| `list_run_clusters` | `GET /clustering-runs/:id/clusters` | reader |
| `get_cluster` | `GET /clusters/:id` | reader |
| `list_cluster_members` | `GET /clusters/:id/members` | reader |
| `list_cluster_labels` (`language`) | `GET /clusters/:id/labels` | reader |
| `get_cluster_provenance` | `GET /clusters/:id/provenance` | reader |
| `create_person` | `POST /persons` | contributor |
| `create_work` (with `persons`, `occasion`) | `POST /works` | contributor |
| `create_source` | `POST /sources` | contributor |
| `create_text` (with `persons`) | `POST /texts` | contributor |
| `propose_label` (`producer_kind` `human` or `model`) | `POST /clusters/:id/labels` | contributor |
| `review_label` | `POST /labels/:id/reviews` | curator |

`get_embedding_space` is an addition to the planned list: `semantic_search` callers need the
space's model, `dimensions` and `query_prefix` to produce a compatible vector.

**`semantic_search` never embeds.** The caller must supply a query vector produced by the
embedding space's own model (same revision, `query_prefix`, normalisation, dimension). Vectors
from any other model are accepted by shape but give meaningless neighbours.

**Labels written by an AI** must be proposed with `producer_kind: "model"` plus `model` and
`producer`; the tool description tells the model so. The API records the label under the
signed-in user, so both the account and the producing model are on record.

### Deliberately not exposed

- **Bulk ingestion** (`POST /segmentations`, `/segmentations/:id/chunks`, `/embedding-spaces`,
  `/embedding-spaces/:id/embeddings`, `/clustering-runs` and its clusters, memberships, complete):
  these take up to 5,000 items with exact offsets, full vectors and producer metadata. They are
  produced by scripts, and pushing them through an LLM context would be slow, expensive and
  error-prone (a model retyping offsets or vectors corrupts data). Scripts call the REST API directly
  with a service token.
- **Updates, withdrawals and admin** (`PATCH`, `PUT .../persons|occasion`, `.../withdraw`,
  `/admin/*`): curator/admin operations with lasting effect stay in the API/CLI, where a person
  acts deliberately. They can be added as tools later if needed.
- Vectors and centroids (`include_vectors`, `include_centroid`) are not requested: large, and not
  useful in a conversation.

## Security notes

- **Identity.** The OAuth access token's `sub` is the Sermonize user id and its `sid` the grant (both
  verified with signature, issuer and audience; the grant must still be active). The grant selects the
  Sermonize API token. Tool arguments never carry a user id or token, and unknown arguments are dropped.
  Each call goes upstream as that user, so the API's role checks, restricted-text rules and the **audit
  trail** (`created_by`, `reviewer_id`, `audit_event.actor_id`) record the real person.
- **Passwords** are only passed through to the API over `SERMONIZE_API_URL` (use HTTPS or a private
  network), never stored, hashed, logged or echoed back into the form.
- **Encryption at rest.** API tokens are stored in the SQLite file encrypted with AES-256-GCM
  (`SERMONIZE_TOKEN_KEY`, random 96-bit IV per write, the grant id as additional authenticated data, so a
  ciphertext moved to another grant's row does not decrypt). Losing or rotating the key only means users
  sign in again (undecryptable grants are ended). Keep the key out of the SQLite file's backups.
- **Consent ticket.** Between sign-in and consent the browser holds a random one-time ticket (stored as a
  SHA-256 hash), bound to the exact OAuth request; the grant stays pending and unusable until it is
  presented with *Approve*.
- **No token output.** Tokens are never logged or included in tool results or error messages. The Fastify
  request log has method, URL, host, remote address and status, no headers or bodies.
- **No PII stored.** The SQLite file holds grant ids, Sermonize user ids, client ids and encrypted tokens;
  the email typed into the sign-in form is only shown back on the consent page.
- **Rate limiting** is the API's (per client IP). The server forwards `request.ip` as `X-Forwarded-For`; set
  `TRUST_PROXY` here for the proxy in front of it, and list this server in the API's `TRUST_PROXY`.
- The scaffold's remaining production notes still apply (refresh-token rotation, a revocation endpoint,
  CIMD caching); see `LEARNED.md`.

## Development

| script (in `packages/mcp`, or `-w @sermonize/mcp` from the root) | does |
|---|---|
| `npm run dev` / `npm run build` / `npm start` | run with reload / compile to `dist/` / run compiled |
| `npm run typecheck` | `src/` (strict, `exactOptionalPropertyTypes`) and `test/` |
| `npm test` | vitest |

Tests:

- `connector.test.ts`: the client against a stub Fastify server (Bearer passthrough, query/path
  encoding, JSON bodies, login/logout, error JSON -> code/message/details, 401/403 explanations,
  timeouts, unreachable API).
- `token-crypto.test.ts`: encryption round trip, tamper/wrong-grant/wrong-key detection, key parsing,
  the grant store (pending/active, ticket binding, cascade, sweep), the SQLite schema upgrade.
- `config.test.ts`: `TRUST_PROXY`, `MCP_PUBLIC_URL` validation, and discovery metadata / 401 challenge
  for `MCP_PUBLIC_URL=https://example.org`; all routes sit under proxy-routable prefixes.
- `tools.test.ts` (stub API): discovery and the 401 challenge, the sign-in page, sign-in via
  `POST /auth/login` (client `mcp`) with 401/429/5xx mapping, X-Forwarded-For with `TRUST_PROXY` on/off,
  deny, ticket binding, sweeping, refresh-token capping, the registered tools and annotations,
  per-grant token passthrough, upstream 401 -> sign in again.
- `integration.test.ts`: the full OAuth code + PKCE flow against the real API (`buildApp` from
  `@sermonize/api`, resolved to its TypeScript sources through the `@sermonize/source` export condition,
  on an ephemeral port) with accounts registered through the API: `whoami` returns the API user id and
  role, the `mcp` token and capped refresh token, wrong password, disabled account and revoked token ->
  sign in again, logout of ended grants, the API's per-IP rate limit through the MCP server; then
  `create_person` (audit attribution), `search_persons` with pagination, work/source/text creation,
  `get_text_body` code-point slices, 403/404 mapping.

The tests replace CIMD fetching with a fixed client (`resolveClient` option of `buildMcpApp`), since a
CIMD document must be served over public HTTPS.

**Shared test database.** The integration test uses the API's `TEST_DATABASE_URL`. The API suite
drops and recreates its schemas in its globalSetup; this package's globalSetup only applies pending
migrations (idempotent) and never drops anything, and the tests create their own uniquely named
rows and accounts. The root `npm test` runs the workspaces one after another (API first), so the reset
never overlaps an MCP run. Do not run both suites concurrently against the same database.
