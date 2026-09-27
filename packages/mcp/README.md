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
`src/auth.ts`, `src/oauth-metadata.ts`, `src/csp.ts`, `src/mcp/http.ts`), which is kept as in the
scaffold apart from passing the Sermonize client and token store through.

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
| MCP user = JWT sub                 |
|    |                               |
|    v                               |
| SQLite: sub -> Sermonize token     |
|   (AES-256-GCM encrypted)          |
|    |                               |
|    v                               |
| connector.ts (fetch + timeout)     |
+----|-------------------------------+
     |
     | HTTP, Bearer <this user's
     |       Sermonize API token>
     v
+------------------------------------+
| @sermonize/api (port 3000)         |
| roles, validation, audit           |
+----|-------------------------------+
     v
 PostgreSQL + pgvector
```

## Setup

Requirements: Node.js >= 22.12 (uses `node:sqlite`), a running Sermonize API.

```sh
# from the repository root
npm install
cp packages/mcp/.env.example packages/mcp/.env      # edit, then export (the server reads process.env only)
set -a; . packages/mcp/.env; set +a

# Secrets
export JWT_SECRET=$(openssl rand -base64 32)             # signs MCP access tokens
export SERMONIZE_TOKEN_KEY=$(openssl rand -base64 32)    # encrypts stored Sermonize API tokens
export MCP_DEFAULT_USER_PASSWORD='change-me'
export SERMONIZE_API_URL=http://127.0.0.1:3000

npm run dev:mcp            # or: npm run build && npm start -w @sermonize/mcp
```

Environment:

| variable | default | |
|---|---|---|
| `PORT` / `HOST` | `5999` / `127.0.0.1` | the API uses 3000 |
| `MCP_PUBLIC_URL` | `http://localhost:$PORT` | public origin; OAuth issuer, MCP resource is `<url>/mcp` |
| `JWT_SECRET` | required | base64, >= 32 bytes |
| `STORAGE_PATH` | `./data/app.sqlite` | OAuth codes, refresh tokens, MCP users, encrypted API tokens |
| `MCP_DEFAULT_USER_ID` / `_EMAIL` / `_PASSWORD` | `demo-user` / `demo@example.com` / required | account created on first start (without an API token) |
| `SERMONIZE_API_URL` | required | base URL of the REST API |
| `SERMONIZE_TOKEN_KEY` | required | base64 of exactly 32 bytes (AES-256-GCM key) |
| `SERMONIZE_REQUEST_TIMEOUT_MS` | `15000` | timeout of one upstream request |
| `LOG_LEVEL` | `info` | |

### Users and their Sermonize tokens

Every MCP user must be linked to **their own** Sermonize API token. Create the Sermonize user and
token with the API's admin CLI or admin API, then store the token with the MCP user:

```sh
# 1. Sermonize side (API admin CLI): a user with the role this person should have
SMZ_USER=$(npm run -s cli -- create-user --kind human --role contributor)
TOKEN=$(npm run -s cli -- create-token --user "$SMZ_USER" --name mcp)

# 2. MCP side: the OAuth login, linked to that token (read from stdin, so it stays out of shell history)
printf '%s' "$TOKEN" | npm run -s mcp-user -- create --name "Anna" --email anna@example.org \
  --password 'change-me' --api-token-stdin

# Link or replace later; unlink
printf '%s' "$TOKEN" | npm run -s mcp-user -- update <mcp-user-id> --api-token-stdin
npm run -s mcp-user -- update <mcp-user-id> --clear-api-token
npm run -s mcp-user -- list          # shows has_api_token, never the token or password hash
```

`--api-token <token>` also works but leaves the token in shell history and the process list.
Writing a token needs `SERMONIZE_TOKEN_KEY` (the same key as the server). A user without a token
can sign in, but every tool returns: *"Your MCP account is not linked to a Sermonize API token ..."*.

Revoking the Sermonize token (`npm run cli -- revoke-token <id>`) cuts the MCP user off at once:
tools then return the API's 401 with an explanation.

## Tools

Results are the API's JSON, returned as text content. List tools pass `cursor` and `limit`
(1-500) through; use `next_cursor` from one page to get the next. The role is the minimum
Sermonize role the **API** enforces for the caller's token; the MCP server itself checks nothing
beyond "signed in and linked". Read tools carry `readOnlyHint: true`; write tools
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
linked user, so both the account and the producing model are on record.

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

- **Token mapping.** The OAuth access token's `sub` (the MCP user id, verified with signature,
  issuer and audience) selects the Sermonize API token. Tool arguments never carry a user id or
  token, and unknown arguments are dropped. Each call goes upstream as that user, so the API's
  role checks, restricted-text rules and the **audit trail** (`created_by`, `reviewer_id`,
  `audit_event.actor_id`) record the real person, not a shared service account.
- **Encryption at rest.** Sermonize tokens are stored in the SQLite file encrypted with
  AES-256-GCM (`SERMONIZE_TOKEN_KEY`, random 96-bit IV per write, the MCP user id as additional
  authenticated data, so a ciphertext moved to another user's row does not decrypt). Losing the
  key means re-linking all tokens; rotate by re-linking. Keep the key out of the SQLite file's
  backups.
- **No token output.** Tokens are never logged, printed by the CLI, or included in tool
  results or error messages. The Fastify request log has method, URL, host, remote address and status, no headers or bodies.
- **No PII beyond the MCP login.** The MCP server stores name, e-mail and an Argon2id password
  hash per MCP user (for sign-in) plus the encrypted token. Sermonize account PII lives only in the
  API's `private` schema and is never returned by the API.
- The scaffold's production hardening list still applies (rate limiting, password reset,
  refresh-token rotation/revocation, account disable, ...); see the scaffold notes in `LEARNED.md`.
  Deleting an MCP user removes their linked token, so existing access tokens stop working for data
  access immediately even before they expire.

## Development

| script (in `packages/mcp`, or `-w @sermonize/mcp` from the root) | does |
|---|---|
| `npm run dev` / `npm run build` / `npm start` | run with reload / compile to `dist/` / run compiled |
| `npm run typecheck` | `src/` + `scripts/` (strict, `exactOptionalPropertyTypes`) and `test/` |
| `npm run user -- <command>` | MCP user CLI (root: `npm run mcp-user -- ...`) |
| `npm test` | vitest |

Tests:

- `connector.test.ts`: the client against a stub Fastify server (Bearer passthrough, query/path
  encoding, JSON bodies, error JSON -> code/message/details, 401/403 explanations, timeouts,
  unreachable API).
- `token-crypto.test.ts`: encryption round trip, tamper/wrong-user/wrong-key detection, key parsing,
  the SQLite token store.
- `tools.test.ts`: discovery and the 401 challenge, the registered tool list and annotations,
  per-user token passthrough, unlinked users.
- `integration.test.ts`: MCP client -> MCP HTTP server -> the real API (`buildApp` from
  `@sermonize/api`, resolved to its TypeScript sources through the `@sermonize/source` export
  condition) -> the test database: `whoami`, `create_person` (audit attribution),
  `search_persons` with pagination, work/source/text creation, `get_text_body` code-point slices,
  403/404/401 mapping.

**Shared test database.** The integration test uses the API's `TEST_DATABASE_URL`. The API suite
drops and recreates its schemas in its globalSetup; this package's globalSetup only applies pending
migrations (idempotent) and never drops anything, and the tests create their own uniquely named
rows. The root `npm test` runs the workspaces one after another (API first), so the reset never
overlaps an MCP run. Do not run both suites concurrently against the same database.
