# Sermonize

## Goal

Build a multilingual theological-text corpus and semantic research API for sermons and historical Christian texts.

The first version is intentionally **data-only**: the API stores and retrieves source texts, chunks, translations, embeddings, clusters, and labels. AI processing is performed by external tools/scripts and submitted to the API. The API does not contain an AI processing pipeline, worker queue, or job orchestration.

## Architecture

- Node.js + TypeScript
- Fastify HTTP API
- PostgreSQL
- pgvector
- REST API
- Python is optional for external embedding/clustering/research scripts; it is not part of the API runtime.

Principle:

    producers -> API -> PostgreSQL/pgvector -> API -> consumers

Processing is deliberately outside the service.

## Data model

### Authors

- id
- name
- metadata

### Works

- id
- author_id
- title
- date_from
- date_to
- metadata

### Texts

Represents a particular textual representation, edition, or translation.

- id
- work_id
- language
- type (original | translation)
- text
- source
- edition
- license
- metadata

The original text must never be replaced by a translation.

### Chunks

- id
- text_id
- sequence
- text
- start_offset
- end_offset
- metadata

Chunks are the primary unit for semantic search and clustering.

### Embedding models

- id
- name
- version
- dimensions
- metadata

### Embeddings

- id
- chunk_id
- embedding_model_id
- vector
- created_at
- metadata

Multiple embeddings may exist for the same chunk. This allows experiments with different embedding models without changing source data.

### Clustering runs

A clustering run describes one reproducible semantic map.

- id
- embedding_model_id
- algorithm
- parameters
- corpus/filter metadata
- created_at

### Clusters

- id
- clustering_run_id
- cluster_number
- centroid
- metadata

### Cluster members

- cluster_id
- chunk_id
- distance
- metadata

### Labels

Cluster labels are derived data, not canonical cluster names.

- id
- cluster_id
- language
- label
- description
- model
- model_version
- status (proposed | reviewed)
- metadata

This permits AI-generated labels to be reviewed or replaced by a human without destroying provenance.


## Users, access control, and audit metadata

The API is user-controlled. Every mutable/domain record must record who created it and when, and records that can be changed should also record who last changed them and when.

Public/domain tables must **not contain personally identifiable information (PII)**. They refer to users only through a stable pseudonymized user identifier.

### User identity

Use two separate concepts:

- **user identity / authentication**: handled by the authentication layer
- **domain user reference**: a pseudonymized, non-PII identifier stored in the database

A single dedicated PII table is the only place where account-level PII is stored.

### Users

Domain-facing user record:

- id
- user_hash (stable pseudonymized identifier)
- role
- status
- created_at
- updated_at

The application must never expose the PII record through ordinary domain endpoints.

### User PII

One isolated table contains account PII:

- user_id
- email / login identifier as required
- display_name where required
- other strictly necessary PII
- created_at
- updated_at

Keep this table behind stricter database/API permissions than ordinary corpus data. Do not duplicate PII into authors, works, texts, chunks, embeddings, clusters, labels, or audit fields.

### Audit fields

Domain records should use:

- created_by_user_id
- created_at
- updated_by_user_id
- updated_at

For immutable records, at minimum:

- created_by_user_id
- created_at

For operations where historical accountability matters, retain an append-only audit trail rather than relying only on current `updated_by` values.

### Authorization

The API must enforce authorization server-side. User identity is never trusted merely because a caller supplies a `user_id` in request data.

The authenticated principal determines `created_by_user_id`, `updated_by_user_id`, and authorization decisions.

Roles/permissions should be explicit and least-privilege. At minimum distinguish ordinary users from administrators/research-data managers.

### Pseudonymization

The pseudonymized identifier must be stable and non-reversible from the domain API. Do not use email addresses, names, or other PII as foreign keys in corpus tables.

If a deterministic hash is used, use a server-side secret/keyed construction rather than an unsalted plain hash of an email address or other identifier.

### Privacy boundary

The intended boundary is:

    authenticated principal
            |
            v
       authorization
            |
            v
    pseudonymous user id
            |
            v
    domain/corpus tables

    PII <---- isolated user-PII table

No domain endpoint should need to return PII to perform ordinary corpus operations.

## Provenance

Derived data must retain enough information to answer:

- Which source text produced this chunk?
- Which work, author, edition and source produced the text?
- Which model/version produced this embedding?
- Which embedding/model produced this clustering run?
- Which model/version proposed a label?

Scholarly provenance is a first-class requirement.

## API

### Write

- POST /authors
- POST /works
- POST /texts
- POST /chunks
- POST /embedding-models
- POST /embeddings
- POST /clustering-runs
- POST /clusters
- POST /cluster-members
- POST /labels

### Read

- GET /authors/:id
- GET /works/:id
- GET /texts/:id
- GET /chunks/:id
- GET /clusters
- GET /clusters/:id
- GET /clusters/:id/members

### Semantic search

POST /search

Input should contain a query and search parameters. The API may perform vector similarity search, but it must not generate the query embedding itself. The caller supplies the query embedding or an explicitly supported stored representation.

This keeps embedding generation outside the API.

## Initial implementation phases

1. Repository/application skeleton
2. PostgreSQL + pgvector schema and migrations
3. Author/work/text/chunk CRUD
4. Embedding model + embedding ingestion
5. Vector similarity search
6. Clustering-run/cluster/member ingestion
7. Label ingestion and review state
8. Provenance and validation
9. API documentation and tests

## Explicit non-goals for v1

- No LLM calls
- No translation service
- No embedding generation
- No clustering execution
- No automatic labeling
- No background workers
- No job queue
- No AI orchestration
- No requirement for a separate vector database

The API is deliberately a stable data boundary. External AI/research tooling can evolve independently.

## Research direction

The intended corpus may contain:

- Latin patristic texts
- Ancient Greek texts
- English translations
- Finnish translations
- contemporary sermons

The longer-term research goal is to explore semantic structures and their changes across authors, periods and languages.

This should be treated as an exploratory research tool. Semantic clusters and AI-generated labels are representations produced by particular models and methods, not authoritative theological classifications.
