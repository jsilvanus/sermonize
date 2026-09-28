# Sermonize

## Goal

Build a multilingual theological-text corpus and semantic research API for sermons and historical Christian texts.

The first version is intentionally **data-only**: the API stores and retrieves source texts, chunks, embeddings, clusters, and labels. AI processing is performed by external tools/scripts and submitted to the API. The API does not contain an AI processing pipeline, worker queue, or job orchestration.

The data model was revised after a critical review: see [`docs/data-model-review.md`](docs/data-model-review.md) for the reasoning and [`docs/implementation-plan.md`](docs/implementation-plan.md) for the build plan.
[`docs/api-examples.md`](docs/api-examples.md) walks through the whole API with curl; the running server
publishes its OpenAPI document at `/docs` (Swagger UI) and `/docs/json`.
[`docs/deployment.md`](docs/deployment.md) describes the production deployment (Docker Compose, one domain:
web UI at `/`, API at `/api/`, MCP at `/mcp`) in two setups: behind nginx installed on the host, or behind
the shared Traefik and PostgreSQL of the riksunsrk infrastructure. Prebuilt images are published to
`ghcr.io/jsilvanus/sermonize-{api,mcp,web,tools}` for `v*` tags.

## Repository layout

This is an npm-workspaces monorepo (ESM everywhere, one root `package-lock.json`):

```
sermonize/
├── package.json            workspaces + root scripts
├── Dockerfile              production images (targets api, mcp, web, tools)
├── deploy/                 compose.yml + host-nginx/ and traefik/ setups, .env.example, ops scripts (docs/deployment.md)
├── docs/                   design notes, data-model review, API walkthrough, deployment guide
└── packages/
    ├── api/                @sermonize/api: the REST API (this README)
    │   ├── src/  test/  migrations/  sql/roles.sql
    │   └── package.json
    ├── cli/                @sermonize/cli: `sermonize-admin`, user/token administration over the REST API
    │   └── README.md       see packages/cli/README.md
    ├── mcp/                @sermonize/mcp: thin MCP server that relays to the REST API
    │   └── README.md       see packages/mcp/README.md
    └── web/                @sermonize/web: minimal server-rendered web UI over the REST API
        └── README.md       see packages/web/README.md
```

- **`@sermonize/api`** owns the data: PostgreSQL + pgvector, auth, roles, audit. Everything
  below describes it.
- **`@sermonize/mcp`** is a remote MCP server (Streamable HTTP + OAuth) that lets MCP clients use
  the API. Users sign in with their Sermonize account; it talks only to the REST API over HTTP, with
  the API token that sign-in obtained, and contains no domain logic or AI processing. See
  [`packages/mcp/README.md`](packages/mcp/README.md).
- **`@sermonize/web`** is a small server-rendered web UI (no client JavaScript): corpus counts,
  registration, sign-in, account and sign-out. It also talks only to the REST API over HTTP and keeps
  the user's API token in a signed httpOnly cookie. See [`packages/web/README.md`](packages/web/README.md).
- **`@sermonize/cli`** is `sermonize-admin`, the day-to-day admin tool for users and tokens. It talks only
  to the REST API over HTTP (sign in with `sermonize-admin login`). See [`packages/cli/README.md`](packages/cli/README.md)
  and [User management](#user-management) below.

Root scripts (run from the repository root):

| script | does |
|---|---|
| `npm install` | installs all workspaces |
| `npm run typecheck` / `npm run build` / `npm test` | runs the workspace script in every package, one package after another |
| `npm run dev:api` / `npm run dev:mcp` / `npm run dev:web` | API (port 3000) / MCP server (port 5999) / web UI (port 3100) with reload |
| `npm run migrate` | apply API migrations to `DATABASE_URL` |
| `npm run cli -- <command>` | the API's database CLI for bootstrap and operations (see below) |
| `npm run admin -- <command>` | `sermonize-admin`, user management over HTTP (see [User management](#user-management)) |

A single package can be targeted with `-w`, e.g. `npm test -w @sermonize/api`.

## Accounts and sign-in (one account everywhere)

There is one user store: the API's (`app_user`, with email and argon2id password hash in the `private` schema).
The same email and password sign in to the web UI and to MCP clients; neither the web app nor the MCP server
stores or hashes passwords, both call the API's `POST /auth/login`.

```
 browser ----> @sermonize/web ---- POST /auth/login {client:"web"} ---+
                (session cookie = token)                              |
                                                                      v
 MCP client -> @sermonize/mcp ---- POST /auth/login {client:"mcp"} -> @sermonize/api
   (OAuth)      (grant -> encrypted token)                            ^   (users, roles,
                                                                      |    tokens, audit)
 admin -----> sermonize-admin ---- POST /auth/login {client:"cli"} ---+
                (~/.config/sermonize/credentials.json, 0600)          |
 scripts ------------------ Authorization: Bearer <token> ------------+
```

API token kinds (all are rows of `private.api_token`, stored as SHA-256 hashes, revocable, sent as
`Authorization: Bearer sz_...`):

| token | name | created by | lifetime |
|---|---|---|---|
| web session | `web` | `POST /auth/login` (default `client: "web"`), via the web sign-in form | `LOGIN_TOKEN_TTL_HOURS` (12 h); revoked at sign-out |
| MCP grant | `mcp` | `POST /auth/login` with `client: "mcp"`, via the MCP OAuth sign-in page | `MCP_LOGIN_TOKEN_TTL_HOURS` (720 h = 30 days); revoked when the OAuth grant ends |
| admin CLI | `cli` | `sermonize-admin login` (`POST /auth/login` with `client: "cli"`, since `0005`) | `CLI_LOGIN_TOKEN_TTL_HOURS` (12 h); revoked by `sermonize-admin logout` |
| script / service | chosen by the admin | `sermonize-admin tokens create`, `npm run cli -- create-token` or `POST /admin/users/:id/tokens` | chosen by the admin (may be unlimited) |
| (before `0004`) | `login` | `POST /auth/login` | `LOGIN_TOKEN_TTL_HOURS` |

Roles (`reader < contributor < curator < admin`) belong to the account, so a user has the same permissions in
the web UI, through MCP tools and with scripts. Disabling a user or revoking a token takes effect at once
everywhere; the MCP server then asks the client to sign in again.

Self-registration only ever gives `reader` (or `contributor`, see `REGISTRATION_DEFAULT_ROLE`); curators and
admins are promoted by an admin with `sermonize-admin users set-role <user-id> curator|admin`.

Rate limiting of register/login is per client IP in the API. The web app and the MCP server forward the end user's
IP as `X-Forwarded-For`, so the API's `TRUST_PROXY` must list the hosts they run on (and nginx, if it talks to the
API directly); each of them has its own `TRUST_PROXY` for the proxy in front of it.

## User management

Two tools, split by purpose:

| tool | talks to | use it for |
|---|---|---|
| `npm run cli -- …` (`packages/api/src/cli.ts`) | PostgreSQL directly (`DATABASE_URL`), as the fixed system user | bootstrap and operations: migrations, **the first admin**, emergency tokens, vector indexes |
| `sermonize-admin …` (`packages/cli`, `npm run admin -- …`) | the REST API over HTTP (`SERMONIZE_API_URL`), with your own admin account | day-to-day: list/find users, create users, change roles, disable/enable, set passwords, issue/revoke tokens |

Bootstrap once, then work over HTTP:

```sh
npm run migrate
read -rs PW && printf '%s\n' "$PW" | npm run --silent cli -- create-user --kind human --role admin \
  --email you@example.org --password-stdin          # prints the new admin's id
export SERMONIZE_API_URL=https://example.org/api    # default http://127.0.0.1:3000 (a path prefix is fine)
npm run admin -- login --email you@example.org      # hidden password prompt; token saved with mode 0600
npm run admin -- users list --role admin
npm run admin -- users set-role <user-id> curator
npm run admin -- users disable <user-id>            # takes effect at once: its tokens stop resolving
npm run admin -- tokens create <service-user-id> --name embeddings --expires-at 2027-01-01T00:00:00Z
```

`sermonize-admin` never accepts passwords as arguments (hidden prompt or `--password-stdin` only), prints
tables by default and JSON with `--json`, and exits 0 (ok), 1 (API or usage error) or 2 (not signed in / not
allowed). The API refuses to let an admin demote or disable themself, to demote or disable the last active
admin, and to change the system user (409 `conflict` with `details.reason` = `self`, `last_admin`,
`system_user`); the CLI explains these. See [`packages/cli/README.md`](packages/cli/README.md).

## Architecture

- Node.js (≥ 22) + TypeScript, ESM only
- Fastify HTTP API with TypeBox schemas
- PostgreSQL (≥ 16) + pgvector (≥ 0.8)
- REST API
- Python is optional for external embedding/clustering/research scripts; it is not part of the API runtime.

Principle:

    producers -> API -> PostgreSQL/pgvector -> API -> consumers

Processing is deliberately outside the service. The API **validates and records**
what external processes did (tool, version, parameters); it never runs them.

## Data model

```
Person
  │ work_person
  │ (role, certainty)
  ▼
Work ─part_of─▶ Work
  │ 1:n         sermon_occasion (1:1)
  ▼
Text ──▶ Source
  │   (edition, license,
  │    access_level)
  │ text_person ─▶ Person
  │ base_text? ─▶ Text
  ▼
Segmentation
  ▼
Chunk
  ▼
Embedding ──▶ EmbeddingSpace
  ▲                ▲
  │                │
Membership ──▶ ClusteringRun
  │                ▲
  ▼                │
Cluster ───────────┘
  ▼
Label ─supersedes─▶ Label
  ▼
LabelReview

── identity ─────────────
private: auth_identity,
         api_token, user_pii
            │ user_id
            ▼
public:  app_user (uuid)
            │ created_by /
            │ updated_by
            ▼
   all tables + audit_event
```

### Conventions

- Primary keys are UUIDv7 (`uuid`), generated by the database by default; clients may
  supply their own id to make batch retries idempotent.
- Every table has `created_by` (→ `app_user.id`) and `created_at`. Mutable tables also
  have `updated_by` and `updated_at`. These are set **by the server** from the
  authenticated principal, never from request data.
- Enumerations are `text` + `CHECK`, not PostgreSQL `ENUM`.
- Years are integers (`year_from`, `year_to`, negative = BCE) with an optional
  `date_note` ("c. 400", "before 430").
- Languages are BCP 47 tags (`la`, `grc`, `fi`, `en`, `de`, `enm`, …).
- `metadata jsonb` holds the long tail only. Anything filtered, joined or validated is a column.
- Nothing referenced by provenance is deleted. Records are **withdrawn**
  (`withdrawn_at`, `withdrawn_by`, `withdrawn_reason`), and foreign keys are `ON DELETE RESTRICT`.
- `producer` (jsonb, required on derived records) describes the external process:
  `{ "tool": string, "version": string, "commit"?: string, "parameters"?: object, "run_at"?: string, "notes"?: string }`.

### Scholarly layer

Curated records. Mutable, with audit, except the text body.

**person**: authors, translators, editors, preachers.
- id, display_name, name_variants text[], is_living boolean NULL,
  year_from, year_to, date_note, external_ids jsonb (e.g. `{"wikidata":"Q8018"}`),
  metadata, withdrawn_*

Preacher names are research-subject data and may be stored (decision recorded in the review).
They are not account PII.

**work**
- id, title, title_variants text[], genre (`treatise | sermon | letter | confession | commentary | homily | hymn | other`),
  original_languages text[] NULL (NULL = unknown), part_of_work_id NULL → work,
  year_from, year_to, date_note, external_ids jsonb (CPL, CPG, CTS URN…), metadata, withdrawn_*

A Work may have **zero, one, or several** original-language texts in the corpus
(e.g. the Augsburg Confession has authoritative German and Latin originals).

**work_person**: authorship and attribution.
- work_id, person_id, role (`author | attributed_author | pseudonymous_author | compiler`),
  certainty (`certain | probable | disputed | spurious`), note. PK (work_id, person_id, role)

Anonymous works have no row.

**sermon_occasion**: 1:1 with a work of genre `sermon`.
- work_id PK, preached_on date NULL, church_year_day text NULL (e.g. `3. sunnuntai loppiaisesta`),
  lectionary text NULL (e.g. `ELCF evankeliumikirja 2000`), lectionary_year text NULL (`I | II | III`),
  pericopes text[] (e.g. `{"Matt. 8:1-13"}`), place text NULL, metadata

**source**: the bibliographic edition and/or digital source a text was taken from.
- id, kind (`print_edition | digital_edition | manuscript | recording_transcript | author_submission | other`),
  citation text (human-readable full citation), editor, title, series, volume, publisher, place, year,
  url, retrieved_at, license, rights_holder, access_level (`public | restricted`), metadata, withdrawn_*

**text**: one textual representation (edition, translation, transcript) of a Work.
- id, work_id, source_id NULL, language (BCP 47),
  relation (`original | translation | adaptation`), translated_from_language NULL,
  base_text_id NULL → text (only when the base is in the corpus), base_note NULL,
  coverage (`complete | partial | excerpt`), coverage_note NULL,
  year_from, year_to, date_note (date of *this* text: edition, translation, preaching),
  title NULL, body text, content_sha256, char_length (code points),
  supersedes_text_id NULL → text, access_level (`public | restricted`), metadata, withdrawn_*

Rules:
- **body is immutable.** A correction is a new Text with `supersedes_text_id`.
- body must be **NFC-normalised** and use `\n` line endings. Non-conforming bodies are rejected (422).
- Effective access = most restrictive of `text.access_level` and `source.access_level`.
- Translations are **not** children of an original. All texts belong directly to the Work.

**text_person**: translator, editor, transcriber of a specific text.
- text_id, person_id, role (`translator | editor | transcriber | reviser`), note. PK (text_id, person_id, role)

### Derived layer

Insert-only and immutable. Provenance (`producer`) is required.

**segmentation**: one chunking of one text by one method.
- id, text_id, method, parameters jsonb, producer jsonb, created_*, withdrawn_*

**chunk**
- id, segmentation_id, text_id (denormalised), sequence int,
  start_offset, end_offset (Unicode **code points**, half-open `[start, end)`),
  text (must equal the exact substring of the text body), locus text NULL (citation such as `10.27.38`),
  language NULL (override for mixed-language texts), content_sha256, metadata
- UNIQUE (segmentation_id, sequence). Overlapping windows are allowed.

**embedding_space**: an immutable definition of one comparable vector space.
- id, name UNIQUE, model, revision, dimensions, element_type (`float32 | float16`),
  metric (`cosine | inner_product | l2`), normalized boolean, document_prefix, query_prefix,
  max_tokens, truncation, pooling, is_multilingual boolean, producer, metadata, withdrawn_*

Any change to model, revision, prefixes, normalisation or metric means a **new** space.

**embedding**
- id, chunk_id, embedding_space_id, vector (`vector`, untyped dimension), metadata, created_*
- UNIQUE (chunk_id, embedding_space_id). Dimension must equal `embedding_space.dimensions`.

**clustering_run**
- id, embedding_space_id, algorithm, parameters jsonb, metric, input_filter jsonb (descriptive only),
  producer, status (`open | complete | withdrawn`), completed_at, withdrawn_reason, metadata

A run is posted in several requests while `open`. When it's marked `complete`, the run and its
clusters and memberships are frozen. Readers see only `complete` runs (a curator can withdraw a run, with a reason).

**cluster**
- id, clustering_run_id, cluster_number, centroid vector NULL, size int NULL, parent_cluster_id NULL, metadata
- UNIQUE (clustering_run_id, cluster_number). The parent must be in the same run.
- `size` = memberships of the cluster **and its descendants**; filled (or verified) when the run is completed.

**cluster_membership**: the full input set of the run.
- clustering_run_id, embedding_id, cluster_id NULL (NULL = noise/unassigned), distance NULL, score NULL, metadata
- PK (clustering_run_id, embedding_id). The embedding must belong to the run's embedding space.

**label**: derived research metadata, not an authoritative theological classification.
- id, cluster_id, language, label, description, producer_kind (`model | human`),
  model NULL, model_version NULL, producer jsonb NULL (required when `producer_kind = model`),
  supersedes_label_id NULL → label, metadata, created_*

Labels are immutable. A human revision is a new label that supersedes the old one.

**label_review**: append-only review decisions.
- id, label_id, reviewer_id → app_user, decision (`accepted | rejected | needs_revision`), note, created_at

A label's current status is derived from its latest review (none = `proposed`). "Accepted" means
"a fair description of this cluster under this method", not a doctrinal judgement.

### Users, identity, access control and audit

```
schema private  (no privileges for the application role)
  auth_identity(user_id, issuer, subject)
  api_token(id, user_id, token_sha256, name, expires_at, revoked_at)
  user_pii(user_id, email, display_name, …)       email unique case-insensitively
  password_credential(user_id, password_hash, …)  argon2id, hashed in Node

schema public
  app_user(id uuid, kind human|service, role, status active|disabled, created_*, updated_*)
  audit_event (append-only)
```

- `app_user.id` is a random UUID. It is the only user reference in domain tables. No email,
  name or login identifier ever appears outside `private`.
- Pseudonymous IDs are still personal data under GDPR. Erasing a user deletes their `private` rows,
  and the UUID then becomes effectively anonymous. Audit rows are kept.
- `kind = service` principals are used by external processing scripts.
- The server resolves the principal from the `Authorization: Bearer <token>` header via
  `SECURITY DEFINER` functions in `private`. v1 uses API tokens (stored as SHA-256 only).
  OIDC can map `(issuer, subject)` through `auth_identity` later.
- Every write runs in one transaction that sets `SET LOCAL app.user_id` and `app.request_id`.
  Database triggers fill `created_by`/`updated_by` and write audit events, so no code path can forget.
  A user id supplied in a request body is ignored.

Roles (least privilege, cumulative):

| role | can |
|---|---|
| `reader` | read public records, metadata of restricted records, search public chunks |
| `contributor` | + read restricted bodies/chunks, create scholarly records and derived data |
| `curator` | + update scholarly records, withdraw records, review labels |
| `admin` | + manage users and tokens |

Self-registered users (`POST /auth/register`, when `REGISTRATION_OPEN=true`) always get
`REGISTRATION_DEFAULT_ROLE`, which may only be `reader` (default) or `contributor`; any other value
stops the API at startup, and the database function refuses other roles too. Curator and admin are
granted by an admin only.

Access level covers derived data too: chunks and embeddings of restricted texts are restricted
(embeddings can be partially inverted).

**audit_event**
- id, occurred_at, actor_id, action (`insert | update | delete | withdraw | batch_insert | status_change |
  token_create | token_revoke | pii_update | password_set | pii_read`; `delete` only for the replaceable join tables;
  `pii_read` (since `0005`) records that an admin listed accounts with their PII: the number of rows and the filter
  names, never the search text or the values),
  entity_type, entity_id NULL, batch_count NULL, request_id, changes jsonb
- Row-level for curated tables. One event per batch for bulk derived data (chunks, embeddings, clusters,
  memberships). INSERT-only. Never contains values from `private`.

## Provenance

The model answers:

- Which source text produced this chunk? → `chunk → text` (exact span, hash)
- Which work and author does it belong to? → `text → work → work_person → person`
- Which edition/source was used? → `text → source`
- Which chunking produced it? → `chunk → segmentation.producer`
- Which model/version produced this vector? → `embedding → embedding_space`
- Which clustering experiment produced this cluster, with what input? → `cluster → clustering_run`, `cluster_membership`
- Which model proposed this label, and who reviewed it? → `label.producer`, `label_review`

`GET /chunks/:id/provenance` and `GET /clusters/:id/provenance` return the whole chain.

## API (v1)

All list endpoints are cursor-paginated. Write endpoints require authentication.

Scholarly:
- `POST/GET /persons`, `GET/PATCH /persons/:id`
- `POST/GET /works`, `GET/PATCH /works/:id`, `PUT /works/:id/persons`, `PUT /works/:id/occasion`
- `POST/GET /sources`, `GET/PATCH /sources/:id`
- `POST/GET /texts`, `GET/PATCH /texts/:id` (metadata only), `GET /texts/:id/body?start=&end=`, `PUT /texts/:id/persons`
- `POST /{persons,works,sources,texts}/:id/withdraw`

Scholarly API details (added in Phase 2, where the spec above left them open):
- Create (`POST`) needs `contributor`; `PATCH`, the `PUT` replace endpoints and withdraw need `curator`.
  So that contributors can still attribute what they create, `POST /works` accepts optional
  `persons` and `occasion`, and `POST /texts` optional `persons` (same shapes as the `PUT` bodies).
- `POST` accepts an optional client `id`; server-owned fields (`created_by`, `withdrawn_*`,
  `content_sha256`, …) and unknown fields in a body are ignored. A `PATCH` naming no updatable
  field is a 400; a `PATCH /texts/:id` containing `body` is a 409 `immutable`.
- Withdraw takes `{ "reason": string }` (required); withdrawing twice is a 409. Lists hide withdrawn
  records unless `?include_withdrawn=true`; `GET /…/:id` still returns them.
- `GET /works/:id` includes `persons` and `occasion` (null unless set); `GET /texts/:id` includes
  `persons` and `effective_access_level`. List items omit the nested arrays. Text bodies are only
  returned by `GET /texts/:id/body` (code-point offsets, `0 ≤ start ≤ end ≤ char_length`).
- `GET /works?year_from=&year_to=` selects works whose date range overlaps the given range; undated works
  are excluded. `GET /persons?q=` matches `display_name` and `name_variants` (case-insensitive substring).
- `PATCH /works/:id` rejects a `part_of_work_id` that would create a cycle (422).

Derived (batch endpoints accept up to 5,000 items and are idempotent on natural keys):
- `POST /segmentations`, `GET /segmentations/:id`, `POST /segmentations/:id/chunks`, `GET /segmentations/:id/chunks`
- `GET /chunks/:id`, `GET /chunks/:id/provenance`
- `POST/GET /embedding-spaces`, `GET /embedding-spaces/:id`
- `POST /embedding-spaces/:id/embeddings`
- `POST /search` (caller supplies the query vector and `embedding_space_id`)
- `POST/GET /clustering-runs`, `GET /clustering-runs/:id`, `POST /clustering-runs/:id/clusters`,
  `POST /clustering-runs/:id/memberships`, `POST /clustering-runs/:id/complete`, `POST /clustering-runs/:id/withdraw`
- `GET /clusters/:id`, `GET /clusters/:id/members`, `GET /clusters/:id/provenance`
- `POST /clusters/:id/labels`, `GET /clusters/:id/labels`, `POST /labels/:id/reviews`
- Added in Phase 4: `GET /clustering-runs/:id/clusters`, `GET /labels/:id` (with its reviews)

Derived API details (added in Phase 3, where the spec above left them open):
- Creating segmentations, chunks, embedding spaces and embeddings needs `contributor`. Also
  `GET /texts/:id/segmentations` (paginated, hides withdrawn unless `?include_withdrawn=true`).
  There are no withdraw endpoints for segmentations/spaces yet (the columns exist).
- Batch endpoints (`POST /segmentations/:id/chunks`, `POST /embedding-spaces/:id/embeddings`) take a
  JSON array of 1…`MAX_BATCH_ITEMS` items (more → 400) and are all-or-nothing:
  - Any invalid item → 422 with `details: { failed, errors: [{ index, reason, message, sequence | chunk_id }] }`
    (all failing items, up to 1,000). Duplicate keys within one batch (`sequence`/`chunk_id`, client `id`)
    are 422 too. Nothing is inserted.
  - Idempotent on the natural key (`(segmentation, sequence)`, `(chunk, space)`): an existing row with
    identical content (offsets/text/locus/language/metadata, or vector/metadata; plus the `id` if the
    client sent one) is `skipped`; different content → 409 with `details.conflicts: [{ index, sequence | chunk_id, existing_id }]`,
    nothing inserted. Response `200 { inserted, skipped }`.
  - One `batch_insert` audit event per request that inserted rows (`entity_id` = segmentation or space,
    `batch_count` = inserted, `changes = { parent_type, skipped }`); a pure retry writes none.
- Chunk offsets are validated **in PostgreSQL** (`substr`/`char_length`, i.e. code points):
  `end_offset ≤ char_length`, `char_length(text) = end - start`, and `text = substr(body, start+1, end-start)`.
  Chunks and segmentations cannot be added to withdrawn texts/segmentations (409).
- Embeddings: `vector` must have the space's dimension, finite values (|x| ≤ 65504 for spaces searched as
  `halfvec`), non-zero for cosine, and unit length (±1%) for `normalized` spaces. The chunk must exist and
  not belong to a withdrawn segmentation, text or work (422); the space must not be withdrawn (409).
- Reads: `GET /segmentations/:id` includes `chunk_count`. `GET /segmentations/:id/chunks` is paginated by
  `sequence`. `GET /chunks/:id` includes `effective_access_level`; `?include_embeddings=true` lists its
  embeddings (space summaries), and `&include_vectors=true` adds the vectors. Vectors are returned nowhere else.
  Chunk text (and vectors) of restricted texts need `contributor`; readers get 403 (segmentation metadata stays readable).
- `GET /embedding-spaces/:id` includes `hnsw_index`: `absent | valid | invalid`.
- `POST /search`: `{ embedding_space_id, vector, limit? (1–200, default 10), filters? }` →
  `{ embedding_space_id, metric, items: [{ embedding_id, distance, similarity, chunk, text, work, authors }] }`,
  ordered by `distance` ascending. `distance` is the metric operator's value: cosine distance (`<=>`),
  **negative** inner product (`<#>`) or L2 distance (`<->`); `similarity` is `1 - distance` (cosine),
  `-distance` = the inner product (inner_product), or `null` (l2).
  - Filters: `language` (chunk override, else text language), `work_id`, `person_id` (via `work_person`, any role),
    `relation`, `genre`, `year_from`/`year_to` (overlap; undated excluded) on the **text** date by default or the
    work date with `date_basis: "work"`, and `include_restricted` (403 unless `contributor`+).
  - Withdrawn segmentations/texts/works are excluded; a withdrawn space is a 409. Restricted chunks are
    excluded unless `include_restricted: true`.
  - The query runs in a transaction with `hnsw.iterative_scan = relaxed_order` (and `hnsw.ef_search =
    max(40, limit)`) and is re-sorted afterwards. With very selective filters an index scan may stop at
    pgvector's `hnsw.max_scan_tuples` (default 20,000) and return fewer than `limit` hits.
  - Vectors are compared as `vector(N)` for N ≤ 2000, `halfvec(N)` for 2000 < N ≤ 4000 (with or without an
    index, so results do not change when one is built) and `vector(N)` above 4000 (exact scan; not indexable).

Clustering, label and provenance details (added in Phase 4):
- Creating runs, clusters, memberships and labels and completing runs needs `contributor`; withdrawing a run
  (`{ "reason" }`, required) and reviewing labels need `curator`.
- **Visibility:** readers see `complete` runs only. `GET /clustering-runs` defaults to `?status=complete`;
  `open`, `withdrawn` and `all` need `contributor`, as do the run, its clusters, members, labels and
  provenance while the run is open or withdrawn (403 otherwise).
- `POST /clustering-runs` takes `{ id?, embedding_space_id, algorithm, parameters?, metric?, input_filter?, producer, metadata? }`
  (`metric` defaults to the space's metric; `status` is always `open`). The space must exist (422) and not be withdrawn (409).
  `GET /clustering-runs/:id` adds `cluster_count`, `input_size` (memberships) and `noise_count`.
- Batches follow the chunk/embedding rules above (all-or-nothing 422/409, `{ inserted, skipped }`, one audit event):
  - `POST /clustering-runs/:id/clusters`: `[{ id?, cluster_number, centroid?, size?, parent_cluster_number?, metadata? }]`,
    idempotent on `(run, cluster_number)`. A parent may be stored already or be in the same batch (in any order);
    unknown parents, self-parents and cycles are 422. Centroids must have the space's dimension.
  - `POST /clustering-runs/:id/memberships`: `[{ embedding_id, cluster_number | null, distance?, score?, metadata? }]`
    (`null` = noise), idempotent on `(run, embedding)`. Post clusters first. The embedding must exist, be in the run's
    space and its chunk must not be withdrawn; the cluster must belong to the run (422 per item).
  - Both are 409 once the run is not `open`.
- `POST /clustering-runs/:id/complete` (open → complete): 409 without memberships, and 409 with
  `details.mismatches: [{ cluster_number, size, member_count }]` when a client-supplied `size` differs from the
  membership count (cluster + descendants). NULL sizes are filled. Afterwards the run, its clusters and memberships are frozen.
  `POST /clustering-runs/:id/withdraw`: open or complete → withdrawn; other transitions are 409.
- `GET /clustering-runs/:id/clusters` (paginated by `cluster_number`) and `GET /clusters/:id` include
  `parent_cluster_number` and `member_count` (direct members); `GET /clusters/:id?include_centroid=true` (contributor+) adds the centroid.
- `GET /clusters/:id/members` lists the **direct** members (paginated by embedding id) with a chunk summary (offsets, locus,
  effective language, hash, `restricted`, `withdrawn`), text and work. For readers, restricted chunks are listed with
  `text: null` (their metadata stays visible, like `GET /texts/:id` versus its body).
- Labels: `POST /clusters/:id/labels` `{ id?, language, label, description?, producer_kind, model?, model_version?, producer?,
  supersedes_label_id?, metadata? }`. `model` needs `model` and `producer`; `human` needs neither and may not set `model`/`model_version`.
  Only clusters of `complete` runs can be labelled (409). `supersedes_label_id` must be a label of the same cluster (422).
  Labels carry the derived `status` (latest review by `(created_at, id)`, else `proposed`), `superseded`, `superseded_by`
  and `review_count`; `GET /clusters/:id/labels?language=` lists them.
- `POST /labels/:id/reviews` `{ decision: accepted | rejected | needs_revision, note? }` (409 for withdrawn runs);
  `reviewer_id` is the caller. Reviews only ever expose reviewer ids, never account PII.
- `GET /chunks/:id/provenance` → `{ chunk, segmentation, text, source, work, persons, embeddings, cluster_memberships }`:
  the chunk (text `null` for readers if restricted), its segmentation and producer, the text (hash, persons), source,
  work (authors, sermon occasion), every linked person, its embeddings with space summaries, and its memberships in
  runs the caller may see.
- `GET /clusters/:id/provenance` → `{ cluster, run, embedding_space, input: { size, noise_count, cluster_count }, labels }`
  with the run's algorithm, parameters, producer and status, and every label with its reviews.

Admin (all need `admin`; used by `sermonize-admin`):
- `POST /admin/users`, `POST /admin/users/:id/tokens`, `DELETE /admin/tokens/:id`
  (since `0003`, an email already used by another account, case-insensitively, is a 409 `conflict`)
- CLI: `npm run cli -- create-user`, `create-token`, `revoke-token`, `migrate`, `create-index <embedding_space_id>`,
  `drop-index <embedding_space_id>`

Account administration (added with `@sermonize/cli`, migration `0005_admin_user_management`). Admins manage accounts,
so these responses include the account PII (`email`, `display_name`), read through the SECURITY DEFINER function
`private.admin_list_users` (which checks for an active admin and writes a `pii_read` audit event). Password hashes and
token hashes are never returned; a token's plaintext only once, when it is created.
- `GET /admin/users?role=&status=&kind=&q=&cursor=&limit=` → `{ items: [{ id, kind, role, status, email, display_name,
  has_password, created_at, updated_at }], next_cursor }`, ordered by `(created_at, id)`. `q` is a case-insensitive
  substring of email or display name (LIKE wildcards are literal).
- `GET /admin/users/:id` → the same fields plus `tokens: { total, active, expired, revoked }`.
- `PATCH /admin/users/:id` `{ role?, status?, email?, display_name? }` (at least one; `display_name: null` clears it) →
  the admin view. Role/status changes are row-audited (`update app_user`, old/new values), PII changes as `pii_update`
  with field names only. 409 `conflict` with `details.reason`: `self` (an admin demoting or disabling their own account),
  `last_admin` (demoting or disabling the last active admin, not counting the system user), `system_user` (the fixed
  system user cannot be changed). Disabling takes effect at once: tokens of disabled users no longer resolve and login fails.
- `PUT /admin/users/:id/password` `{ password, revoke_tokens? }` → `{ user_id, revoked_tokens }`. Same length rule as
  registration (12–256 code points, else 400); argon2id in Node; 422 for service accounts and users without an email.
  Audited as `password_set` (`{ via: "admin", revoke_tokens }`, no values) plus one `token_revoke` (`via: "password_set"`) per revoked token.
- `POST /admin/users` also accepts `password` (human users with `email` only, else 422).
- `GET /admin/users/:id/tokens` → `{ items: [{ id, name, created_by, created_at, expires_at, revoked_at, state }] }`
  (`state`: `active | expired | revoked`). Last use is not tracked.

Password accounts and statistics (added with `@sermonize/web`, migration `0003_password_auth`):
- `GET /auth/config` (public) → `{ registration_open, password_min_length: 12, password_max_length: 256 }`.
- `POST /auth/register` (public) `{ email, password, display_name? }` → `201 { user_id, role }` (no token).
  403 `registration_closed` unless `REGISTRATION_OPEN=true`. Password 12–256 characters (code points), else 400.
  A duplicate email (case-insensitive) is a 409 `conflict` whose message does not echo the address.
  Creates an active `human` user with `REGISTRATION_DEFAULT_ROLE`, its `user_pii` and an argon2id `password_credential`.
- `POST /auth/login` (public) `{ email, password, client? }` → `{ token, expires_at, user_id, role }`: a new API
  token named after `client` — `"web"` (default) expiring after `LOGIN_TOKEN_TTL_HOURS` (default 12), or `"mcp"`
  (used by `@sermonize/mcp`) expiring after `MCP_LOGIN_TOKEN_TTL_HOURS` (default 720 = 30 days), or `"cli"` (since
  `0005`, used by `sermonize-admin login`) expiring after `CLI_LOGIN_TOKEN_TTL_HOURS` (default 12); any other value
  is a 400. (Tokens issued before migration `0004` are named `login`.) Every failure (unknown email, wrong password,
  disabled user, user without a password) is the same 401 `invalid_credentials`; unknown emails still run an
  argon2 verification against a dummy hash, and the status is checked only after verification.
- `POST /auth/logout` (any authenticated caller) revokes the token used for the request → 204.
- Register and login are rate-limited per client IP (`AUTH_RATE_LIMIT_MAX` requests per
  `AUTH_RATE_LIMIT_WINDOW_SECONDS`, default 10 per 60 s, in memory, per process; `0` disables) → 429 `rate_limited`.
  Behind a proxy (`@sermonize/web` and `@sermonize/mcp` forward the end user's IP as `X-Forwarded-For`; nginx),
  set `TRUST_PROXY` to the addresses of all of them, otherwise all their users share one bucket.
- Audit: the actor of registration and login is **the user themself** (the new user id is set as `app.user_id`
  inside the SECURITY DEFINER functions), not the system user, so the trail shows who created the account without
  any PII. Registration writes `insert app_user` (id, kind, role, status), `pii_update user_pii` (field names only)
  and `password_set password_credential`; login writes `token_create` (`via: login`, `client: web|mcp`), logout `token_revoke` (`via: logout`).
- `GET /stats` (public) → aggregate counts: `persons, works, works_by_genre, sermons, texts, texts_by_language,
  sources, segmentations, chunks, embedding_spaces, embeddings, complete_clustering_runs, clusters, labels`.
  Withdrawn records are excluded (chunks of withdrawn segmentations, embeddings of withdrawn spaces); clusters and
  labels count for complete runs only. Counts only, no PII. They are exact `count(*)`s for now; the large tables
  (chunk, embedding) may later need estimates (`pg_class.reltuples`) or a cache.

Other:
- `GET /health`, `GET /stats`, `GET /auth/config`, `POST /auth/register`, `POST /auth/login` and the API
  documentation `GET /docs` (Swagger UI), `GET /docs/json` (OpenAPI 3) are the only
  unauthenticated routes; the document declares bearer-token security for everything else. `GET /me` (the caller's own user id, role and kind;
  added in Phase 1 so that scripts can check a token without needing any particular role)

### Semantic search

`POST /search` takes `embedding_space_id`, a query `vector`, `limit`, and optional filters
(language, work_id, person_id, year range, text relation, genre). The API never generates the
query embedding. The caller is responsible for producing it in the same space (including
`query_prefix`). Similarity across different spaces is not supported.

Vector indexes are per embedding space (partial HNSW expression indexes, `halfvec` above
2,000 dimensions), created by an operator via the CLI, not through the public API:
`npm run cli -- create-index <space_id>` runs
`CREATE INDEX CONCURRENTLY IF NOT EXISTS embedding_hnsw_<id hex> ON embedding USING hnsw ((vector::vector(N)) vector_<cosine|ip|l2>_ops) WHERE embedding_space_id = '<id>'`
(`halfvec`/`halfvec_*_ops` for 2000 < N ≤ 4000; spaces above 4,000 dimensions are refused). An invalid
index left by an interrupted build is dropped and rebuilt. `drop-index <space_id>` removes it. Both need
a role that owns the `embedding` table (e.g. `OWNER_DATABASE_URL`), not `sermonize_app`.

## Development

Requirements: Node.js ≥ 22.12, PostgreSQL ≥ 16 with pgvector ≥ 0.8.

```sh
npm install                     # at the repository root (all workspaces)
cp packages/api/.env.example packages/api/.env   # then export the variables (the app reads process.env only)
export DATABASE_URL=postgres://sermonize:sermonize@localhost:5432/sermonize
npm run migrate                 # applies packages/api/migrations/*.sql (recorded in schema_migrations)
read -rs PW && printf '%s\n' "$PW" | npm run --silent cli -- create-user --kind human --role admin \
  --email you@example.org --password-stdin                                     # prints the user id
npm run cli -- create-token --user <user-id> --name laptop                     # prints the token once
# or, with the API running: npm run admin -- login --email you@example.org
npm run dev:api                 # http://127.0.0.1:3000/health
curl -H "Authorization: Bearer <token>" http://127.0.0.1:3000/me
```

The CLI writes as the fixed system user `00000000-0000-7000-8000-000000000000` (service, admin),
which migration `0001_init` creates for bootstrapping.

Environment: `DATABASE_URL`, `TEST_DATABASE_URL`, `PORT` (3000), `HOST` (127.0.0.1),
`LOG_LEVEL` (info), `MAX_BATCH_ITEMS` (5000), `TRUST_PROXY` (false; `true` or comma-separated proxy addresses/CIDRs),
`PUBLIC_BASE_PATH` (unset; e.g. `/api` when a reverse proxy publishes the API under that prefix with the prefix
stripped: sets the OpenAPI `servers` entry and the Swagger UI asset URLs, routes stay at the root),
`REGISTRATION_OPEN` (false), `REGISTRATION_DEFAULT_ROLE` (reader; only `reader`/`contributor`),
`LOGIN_TOKEN_TTL_HOURS` (12, web sign-in), `MCP_LOGIN_TOKEN_TTL_HOURS` (720, MCP sign-in), `CLI_LOGIN_TOKEN_TTL_HOURS` (12, `sermonize-admin login`), `AUTH_RATE_LIMIT_MAX` (10; 0 disables), `AUTH_RATE_LIMIT_WINDOW_SECONDS` (60).
Invalid values stop the server at startup.

Scripts of `packages/api` (run them there, with `-w @sermonize/api` from the root, or via the root scripts above):

| script | does |
|---|---|
| `npm run dev` | API with reload (tsx watch) |
| `npm run build` / `npm start` | compile to `dist/` / run the compiled server |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm test` | vitest (in `packages/api`) against `TEST_DATABASE_URL` (default `postgres://sermonize:sermonize@localhost:5432/sermonize_test`). **Drops and recreates the `public` and `private` schemas** of that database once per run, then applies all migrations. Test files run one at a time. The MCP and web packages' tests use the same database without resetting it (they only apply pending migrations and use unique data); the root `npm test` runs the suites one after another (api, cli, mcp, web). |
| `npm run migrate` | apply pending migrations to `DATABASE_URL` |
| `npm run cli -- <command>` | `migrate`, `create-user` (`--password-stdin` for a first admin who can sign in), `create-token`, `revoke-token`, `create-index`, `drop-index` (see `npm run cli -- help`) |

Layout (under `packages/api/`): `src/db` (pool, migration runner, `withTransaction`), `src/plugins` (db, auth, error
handling, OpenAPI), `src/routes` (`scholarly/` for persons, works, sources, texts; `derived/` for segmentations, chunks,
embedding spaces, embeddings, search, clustering runs, clusters, labels, provenance), `src/lib` (principal/roles, errors, tokens, users, batch audit,
`pagination.ts` keyset cursors, `sql.ts` whitelisted INSERT/UPDATE builders, `vector.ts` casts/operators/literals,
`vector-index.ts` HNSW index management),
`migrations/` (SQL), `sql/roles.sql` (ops), `test/` (`helpers.ts` is the shared test toolkit).

### Database roles (`packages/api/sql/roles.sql`)

Migrations run as the schema owner. The API should connect as a separate, least-privileged
role. `sql/roles.sql` is an idempotent ops script (not a migration) that creates `sermonize_app`
and grants it: `SELECT/INSERT/UPDATE` on public tables (immutability is enforced by triggers),
`DELETE` only on `work_person`, `text_person` and `sermon_occasion`, `SELECT/INSERT` only on
`audit_event`, and no table privileges in `private` (only `EXECUTE` on the `SECURITY DEFINER`
functions `private.resolve_token`, `create_api_token`, `revoke_api_token`, `set_user_pii`, and since `0003`
`register_user`, `get_password_credential`, `create_login_token`, `revoke_own_token`, and since `0005`
`admin_list_users`, `admin_list_tokens`, `admin_update_user_pii`, `admin_set_password`, which require an active admin). The admin functions check for
an active admin principal; the `0003` ones need none but each does one narrow thing (register only readers/contributors;
look up a credential; store a `web` or `mcp` login token (since `0004`; `login` before) with a future expiry for an
active user with a password; revoke the
caller's own token). `get_password_credential` returns password hashes to the application role, since verification
happens in Node.
Re-run it after every migration that adds tables or functions:

```sh
psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/api/sql/roles.sql
psql "$OWNER_DATABASE_URL" -c "ALTER ROLE sermonize_app PASSWORD '…'"
```

### Database-enforced rules

Writes run through `withTransaction(pool, principal, requestId, fn)`, which sets
`app.user_id`/`app.request_id` for the transaction. Triggers then fill `created_by`/`updated_by`/
`withdrawn_by`/`reviewer_id` (client values are overwritten), write `audit_event` rows, and
reject: writes without a principal, changes to `text.body`, non-NFC bodies or bodies containing
`\r`, updates/deletes of derived rows (except withdrawal columns and `clustering_run.status`),
deletes of withdrawable records, clusters/memberships for runs that are not `open`, vectors
whose dimension differs from their space, and memberships whose embedding is in another space.
Trigger errors use SQLSTATEs `SZ002` (→ 409 `immutable`), `SZ003` (→ 409 `conflict`) and
`SZ004` (→ 422 `validation_failed`).

Migration `0002_clustering_completion` adds the completion rules: `cluster.size` may only be filled once
(NULL → value) while the run is open; `open → complete` requires at least one membership, rejects sizes that
differ from the membership counts (`cluster_subtree_counts(run)`), and fills NULL sizes; `withdrawn_reason`
can only be set by the withdraw transition.

Migration `0003_password_auth` adds `private.password_credential`, a unique index on `lower(user_pii.email)` and the
self-service auth functions described above.

Migration `0004_login_token_client` replaces `private.create_login_token(uuid, text, timestamptz)` with
`create_login_token(uuid, text, timestamptz, text)`: the last argument is the client (`web` or `mcp`), which becomes
the token name and is recorded in the `token_create` audit event. It re-grants `EXECUTE` to `sermonize_app` when that
role exists, so a running deployment keeps working before `roles.sql` is re-run (which lists the new signature).

Migration `0005_admin_user_management` adds the admin functions behind `GET/PATCH /admin/users…`, `PUT
/admin/users/:id/password` and `GET /admin/users/:id/tokens` (see the API section), and lets `create_login_token`
accept the client `cli`. It grants `EXECUTE` on the new functions to `sermonize_app` when that role exists; re-run
`roles.sql` anyway.

## Explicit non-goals for v1

- No LLM calls, translation, embedding generation, clustering execution or automatic labelling
- No background workers, job queue or AI orchestration
- No separate vector database
- No textual variants/critical apparatus, manuscripts, TEI, cross-language alignment,
  2D projections, lexical full-text search (see the review for the NICE-later list)

## Research direction

The intended corpus may contain Latin patristic texts, Ancient Greek texts, English and Finnish
translations, and contemporary sermons. The longer-term goal is to explore semantic structures
and their changes across authors, periods and languages.

This is an exploratory research tool. Semantic clusters and AI-generated labels are representations
produced by particular models and methods, not authoritative theological classifications.
