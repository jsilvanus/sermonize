# Data model review

Status: proposal / review of the model in `README.md`. Nothing here is implemented yet.

This document critically reviews the proposed Sermonize data model and recommends
the **minimum robust model**: one that preserves scholarly provenance and keeps
future semantic research possible, without turning the API into an AI-processing
system.

Priorities are marked:

- **MUST**: needed in v1. Retrofitting it later means migrating data or breaking provenance.
- **SHOULD**: cheap to add now and valuable soon, but v1 can ship without it.
- **NICE**: later. Leave room for it, but don't build it yet.

---

## 0. Summary of the most serious problems

1. **`Text.source` / `Text.edition` as strings cannot carry scholarly provenance.**
   Editions, digital sources and licenses are shared by many texts and need their own entity.
2. **`Work.author_id` (single, required) is wrong for this corpus.** Pseudepigrapha,
   disputed attributions, anonymous works, and collective confessional documents are normal here.
3. **`type: original | translation` is too coarse, and "original" is not unique.**
   The Augsburg Confession has two authoritative originals (German and Latin).
   Origen's *De principiis* survives mainly in Rufinus' Latin translation. The
   Apology's German text is Justus Jonas' free rendering, not a plain translation.
4. **Period analysis will be wrong if only the Work has a date.** A translation of
   Augustine made in 1887 is 1887 English. Semantic-drift research needs the date of
   the *text* (edition or translation) as well as the date of the *work*.
5. **Offsets are undefined.** Node counts UTF-16 code units, Python and PostgreSQL
   count code points, and polytonic Greek in NFC and in NFD has different lengths.
   If the text can be edited, every offset silently becomes wrong.
6. **Chunks have no chunking scheme.** Once there are two chunkings of one text
   (paragraphs vs 512-token windows), `sequence` stops being unique and clustering runs mix them.
7. **"Embedding model: name, version, dimensions" doesn't identify a vector space.**
   Prefixes and instructions (`query:` / `passage:`), normalization, truncation and
   distance metric all change the vectors.
8. **Cluster members point at `chunk_id`, not at the embedding actually clustered.**
   The chain `cluster → run → model → embedding → chunk` is broken at the join that matters.
9. **Noise points and the clustering input set aren't recorded.** Without the
   denominator you can't answer "what share of Augustine's chunks fall in cluster 12".
10. **`status: proposed | reviewed` doesn't say *what* the review decided, or who made it.**
11. **Contemporary sermon authors are living people.** `Author.name` is personal data
    in a domain table, which contradicts the "no PII in domain tables" rule. Sermon text
    may also contain third-party and special-category data (religion, health).
12. **Pseudonymous IDs are still personal data under GDPR** (Recital 26). The privacy
    design is sound, but the documentation shouldn't say domain tables are PII-free
    in the legal sense.
13. **Copyright and access are missing.** Modern translations and sermons often can't
    be redistributed. A data API that returns any chunk to any caller is a licensing problem.
    Embeddings of restricted text should be treated as restricted too, because they can
    be partially inverted.
14. **pgvector can't index a mixed-dimension column directly.** You need per-model
    partial expression indexes. Above 2,000 dimensions HNSW requires `halfvec`.

---

## 1. Missing entities and relationships

| Missing | Why | Priority |
|---|---|---|
| **Source** (bibliographic edition + digital source) | Many texts share one edition (e.g. a Migne PL volume, NPNF series). License and rights belong to it. | MUST |
| **Work ↔ Person attribution** (join table with role and certainty) | Pseudo-Dionysius, Ambrosiaster, spurious Augustine sermons, anonymous works, collective documents (Formula of Concord). | MUST |
| **Segmentation** (a chunking of one text by one method) | Multiple chunkings per text, reproducibility, unique `sequence`. | MUST |
| **Label review** (append-only decisions) | Who reviewed, what was decided, and several reviewers per label. | MUST |
| **Auth identity** (IdP issuer + subject), separate from `users` | Needed for "authentication separated from domain identity". | MUST |
| **Audit event** (append-only) | `updated_by` only keeps the last writer. | MUST |
| **Text contributors** (translator, editor, transcriber) | Translator style confounds cross-language comparison. | SHOULD |
| **Work hierarchy** (`part_of_work_id`) | Sermons within a postil (Luther's *Kirchenpostille*), *Enarrationes in Psalmos*, sermon series, confessional corpora (Book of Concord). | SHOULD |
| **External identifiers** (CPL, CPG, Wikidata, VIAF, CTS URN) | Deduplication and linking to other scholarly data. | SHOULD |
| **Text structure / citation locus** | Scholars cite "Conf. 10.27.38" or "PL 32, 795", not character offsets. It's also the cheapest cross-language alignment key. | SHOULD |
| **Liturgical occasion** for sermons | Date preached, church-year day, lectionary series and year, pericopes. For ELCF sermons this is a primary research dimension (the three-year gospel-book cycle). | SHOULD |
| Cross-language chunk alignment | Parallel-text comparison. | NICE |
| Manuscripts / witnesses / variant readings | Critical-apparatus modelling. | NICE |
| 2D projections (UMAP etc.) per run | Visualisation output that research tools will want to post. | NICE |
| Named datasets / corpus snapshots | Reusable subsets across experiments. | NICE |

Rename **Author → Person**. The same table then holds authors, translators and
editors, and "author" becomes a role rather than a type.

---

## 2. Incorrect assumptions

- **"A Work has one author."** False for a large part of patristic and confessional
  material. Use `work_person(work_id, person_id, role, certainty)`, with
  role ∈ {author, attributed_author, pseudonymous_author, compiler}
  and certainty ∈ {certain, probable, disputed, spurious}. Anonymous works have no row.
- **"Original vs translation is a binary property of a Text."** Both originals can
  exist at once (the Augsburg Confession in German and Latin). A translation can be the
  only witness (Rufinus' Origen, the Latin Irenaeus). Some texts are adaptations or
  paraphrases (Jonas' German Apology), and some are modernised versions of older
  vernacular texts (Agricola-era Finnish). Translations can also be made from other
  translations (Finnish from English rather than from Greek).
  → Model `relation` ∈ {original, translation, adaptation}, `translated_from_language`
  (nullable), and optional `base_text_id` (nullable FK, only when the base is in the
  corpus) plus a free-text `base_note`. **Do not add a "one original per work" constraint.**
- **"The date of a Work is the date of its language."** The date of a Text is needed
  as well (`text_date_from/to`: when it was translated, edited, or preached). Drift
  analysis must be able to choose which date it means.
- **"`language` is a simple code."** Use BCP 47 tags: `la`, `grc`, `fi`, `en`, `de`,
  `enm`, and private-use subtags where needed. Also allow mixed-language texts
  (sermons quoting Latin or Greek) with a chunk-level override.
- **"Dates are dates."** Patristic dates are ranges with uncertainty ("c. 400",
  "before 430"). Store integer years `year_from`/`year_to` plus `date_note`. Use a full
  `date` only where it is actually known (a sermon's preaching date).
- **"The Text body is stable."** Corrections happen. Offsets and every downstream
  record depend on the exact body, so the body must be immutable once a segmentation
  exists. A correction is a new Text that points back with `supersedes_text_id`.
- **"Domain tables contain no PII."** True for account data only. Person records for
  living preachers, and the sermon texts themselves, contain personal data. That is
  research-subject data and needs its own documented legal basis and policy
  (GDPR Art. 89 research safeguards, Finnish Data Protection Act 1050/2018).
- **"A `user_hash` is needed for pseudonymisation."** A random UUID primary key is
  already a pseudonym. A deterministic HMAC of an email adds risk (the key can leak,
  and emails change) and no benefit. Drop `user_hash`.
- **"Every caller is a human."** Nearly all derived data comes from scripts, so you
  need service principals, and "on behalf of" a human is worth recording.

---

## 3. Scale problems

Rough order of magnitude: a large patristic intake plus translations and sermons can
reach millions of chunks. At 1M chunks × 1024 dims × 4 bytes, that is about 4 GB of
vectors **per embedding space**, plus an HNSW index of similar or larger size.
Clustering memberships multiply as runs × chunks.

- **Single-row POST endpoints won't work** for embeddings or memberships. You need
  batch ingestion (NDJSON or `COPY` streaming). For the data model this means
  **natural unique keys** that make retries idempotent: `(segmentation_id, sequence)`,
  `(chunk_id, embedding_space_id)`, `(clustering_run_id, embedding_id)`.
- **Full text bodies in JSON responses.** `GET /texts/:id` shouldn't return the body
  by default. Serve it as a separate resource with range support.
- **Cluster memberships** grow fastest. Key them by run, consider `LIST`/`HASH`
  partitioning by `clustering_run_id`, and make withdrawing a run cheap.
- **Filtered ANN search.** HNSW plus `WHERE language = 'la' AND …` returns too few
  rows. Use pgvector ≥ 0.8 iterative index scans (`hnsw.iterative_scan`), and keep
  filter columns as real columns, not JSONB.
- **Per-row audit** for 10⁶ embedding inserts is pointless. Audit bulk data per batch.
- **IDs:** UUIDv7 (PostgreSQL 18 has `uuidv7()`; on older versions generate it in the
  app) lets clients pre-assign IDs for idempotent batches and keeps index locality.

---

## 4. Scholarly provenance

The proposed chain has gaps:

| Question | Proposed model | Gap |
|---|---|---|
| Which edition/source? | `Text.source`, `Text.edition` strings | Not queryable, duplicated, license isolated from rights holder |
| Which digital file? | — | Digitisation (CCEL, Perseus, OCR of a scan) is a separate provenance step from the print edition: URL, retrieved_at, checksum, cleaning notes |
| Which exact body was chunked? | — | Needs immutable body + `content_sha256` |
| Which chunking method? | — | Needs Segmentation (method, parameters, tool, version) |
| Which vector was clustered? | `cluster_member.chunk_id` | Needs `embedding_id` |
| Which software produced this? | free `metadata` | Needs a required, documented `producer` object (tool, version, commit, parameters) on Segmentation, EmbeddingSpace, ClusteringRun and Label |
| Who asserted an attribution? | — | Attribution certainty plus a note or source |

The API doesn't run these processes. It only **requires the caller to describe
them**. That is data validation, not a pipeline.

---

## 5. Multilingual texts and translations

- Keep all Texts directly under the Work (the proposal is right here). Add the
  *optional* `base_text_id` for when the base is present. It's a pointer, not a
  parent/child hierarchy.
- Record `translated_from_language` even when the base text is absent
  (e.g. "English, from the Maurist Latin").
- **Coverage:** many translations are partial (selected sermons, only Book X).
  Add `coverage` ∈ {complete, partial, excerpt} + `coverage_note`. Comparing a full
  Latin text with a partial Finnish one will otherwise skew every statistic.
- **Cross-language comparison** requires (a) a multilingual embedding space and
  (b) a way to align passages. The cheap alignment is a shared **citation locus**
  on chunks (`"10.27.38"`). An explicit alignment table is NICE later.
- Language-dependent tokenisation means chunk sizes aren't comparable across
  languages. Record the segmentation method, and never compare "chunk counts"
  across languages naïvely.

---

## 6. Editions, sources and textual variants

- **Source** entity (MUST): kind (print_edition | digital_edition | manuscript |
  recording_transcript | author_submission), citation fields (editor, title, series,
  volume, publisher, place, year), url, retrieved_at, license, rights holder,
  `access_level`.
- A **different edition is a different Text.** That is enough for v1.
- **Variant readings / critical apparatus: explicitly out of scope for v1.** Document
  that apparatus, footnotes and editorial sigla are either stripped or kept as
  structure (see §7), and say which.
- Sermons have their own "editions": manuscript, as-preached transcript, and
  published version. Model these as separate Texts with different `Source.kind`.

---

## 7. Chunking and offsets

**MUST define:**

1. Text bodies are stored **NFC-normalised**, with `\n` line endings, and immutable.
2. Offsets are **Unicode code points**, **half-open** `[start, end)`, into that
   body. PostgreSQL `substr()` on a UTF-8 database uses code points, and so does
   Python. Node must use code-point-aware slicing (`Array.from` / `[...str]`), **not**
   `String.prototype.slice`.
3. On write, the API verifies `chunk.text = substr(text.body, start+1, end-start)`
   (or the chunk stores offsets only and text is derived). Any normalisation done for
   embedding (lowercasing, u/v, accent stripping) is recorded in the
   segmentation or embedding-space config, not silently applied to the chunk.
4. Chunks belong to a **Segmentation**. `sequence` is unique per segmentation.
   Overlapping windows are allowed. Non-contiguous chunks are not in v1.
5. `content_sha256` on Text (and optionally on Chunk) gives integrity and dedupe.

**SHOULD:** `text_division(text_id, kind, label, start, end, parent_id)` for
book/chapter/section/paragraph/page markers, and a `locus` string on the chunk
(derivable from divisions). This is how results become citeable. Without it, a
search hit is "characters 183,220–184,011", which no theologian can check.

**NICE:** keep the original TEI/XML source as a file attached to the Source.

---

## 8. Embeddings and model/version management

Replace **EmbeddingModel** with an immutable **EmbeddingSpace**. Any change to the
following means a new row:

- model name + exact revision (HF commit hash or API model snapshot)
- dimensions, element type (float32 / float16)
- distance metric (cosine / inner product / L2) and whether vectors are normalised
- document prefix/instruction and **query** prefix/instruction (asymmetric models)
- max input tokens + truncation behaviour, pooling
- the `producer` object

Rules:

- `UNIQUE (chunk_id, embedding_space_id)`. Duplicate vectors poison clustering.
  To re-embed, create a new space.
- The API validates `vector_dims(vector) = space.dimensions`.
- **Similarity is only defined within one space.** `/search` requires
  `embedding_space_id` and uses that space's metric and operator. The API can't verify
  that the caller's query vector came from the same space, so document that it's the
  caller's responsibility, including the query prefix.
- Cross-lingual comparison is only meaningful in spaces declared multilingual
  (`is_multilingual` in config).
- `created_at` is ingestion time. Generation time goes into producer metadata.
- Deleting a space that a clustering run references is `RESTRICT`. Use `withdrawn_at` instead.

---

## 9. Clustering and membership

- `ClusteringRun` references `embedding_space_id` and records algorithm, parameters,
  metric, `producer`, and a descriptive `input_filter`. The filter is **descriptive
  only**, because the corpus changes. The real input set is the membership table.
- **Membership = `(clustering_run_id, embedding_id, cluster_id NULL)`**. Every input
  embedding gets a row, and noise/unassigned rows have `cluster_id NULL`. That
  records the exact input set, which gives reproducibility and correct denominators.
  Enforce `embedding.space = run.space` (trigger or API check).
- Add `score` / `probability` alongside `distance`, and define `distance` in the run
  ("to centroid, cosine"). Centroid is **nullable**, since density-based clusters
  (HDBSCAN) have no meaningful centroid.
- `UNIQUE (clustering_run_id, cluster_number)`.
- **Run status** ∈ {open, complete, withdrawn}. With no job queue, a run is posted in
  several requests, so readers must see only `complete` runs by default. Once complete,
  a run and its clusters and memberships are immutable.
- Soft/multi-membership, hierarchical clusters (`parent_cluster_id`), and cross-run
  cluster matching (for drift) are NICE later. The composite key above doesn't block them.

---

## 10. Labels and human review

- Labels are **immutable**. A human revision creates a new Label with
  `supersedes_label_id`.
- `producer_kind` ∈ {model, human}. For model labels, record model id and version
  plus a `producer` object (prompt hash or id, parameters). For human labels, `created_by`
  is the producer.
- **`label_review(label_id, reviewer_id, decision, note, created_at)`**, append-only,
  with decision ∈ {accepted, rejected, needs_revision}. Current status is derived from it,
  not stored. That supports several reviewers and later inter-rater agreement.
- Document that "accepted" means **"a fair description of this cluster under this
  method"**. It isn't a doctrinal or confessional judgement.
- A label is a label *of a cluster within a run*. It can't be reused across runs.

---

## 11. User identity, pseudonymisation, PII and audit

Recommended layout:

```
schema private (role: api_auth only)
  auth_identity(user_id, issuer, subject)
  user_pii(user_id, email, display_name, …)

schema public (role: api_app)
  app_user(id uuid, kind human|service,
           role, status, created_at)
  … domain tables: created_by, updated_by → app_user.id
  audit_event (append-only)
```

- `app_user.id` is a random UUID. No `user_hash`.
- The app role has **no** privileges on `private`. Principal resolution goes through
  one `SECURITY DEFINER` function `resolve_principal(issuer, subject) → uuid`.
  This keeps the "one PII table" intent while separating authentication.
- `created_by`/`updated_by` are set from the authenticated principal only. Set
  `SET LOCAL app.user_id` per transaction and let triggers fill the columns, so no
  code path can forget. `SET LOCAL` is safe with connection pooling.
- `audit_event(id, occurred_at, actor_id, on_behalf_of_id, action, entity_type,
  entity_id, batch_id, request_id, changes jsonb)`. Grant INSERT only. Row-level
  for curated data (persons, works, texts, sources, labels, reviews); one event per
  batch for bulk derived data. **Never** copy PII values into `changes`.
- **Derived tables are insert-only**, so they need `created_by/created_at` but no
  `updated_*`.
- Document that pseudonymous IDs are still personal data. Erasure = delete the
  `private` rows. The UUIDs then become effectively anonymous, and audit rows stay.
  State retention periods.
- **Research-subject data** (living preachers in `person`, personal data inside
  sermon texts) is a separate policy from account PII. It needs a lawful basis,
  preacher consent or licence for inclusion, a redaction rule for third parties
  (funeral and baptism sermons!), and `access_level` restrictions.

---

## 12. PostgreSQL / pgvector specifics

- **Mixed dimensions:** use one `embedding` table with an untyped `vector` column,
  and create **one partial expression index per embedding space** in a migration or admin
  operation (not through the public API):
  ```sql
  CREATE INDEX ON embedding
    USING hnsw ((vector::halfvec(3072)) halfvec_cosine_ops)
    WHERE embedding_space_id = '…';
  ```
  Queries must repeat the same cast and predicate. HNSW supports `vector` up to
  2,000 dimensions and `halfvec` up to 4,000.
- The operator class must match the space's metric. The search code chooses the
  operator from the space, never from the request.
- **JSONB `metadata`**: fine for the long tail. Anything that is filtered, joined or
  validated (language, dates, relation, access level, status) must be a column.
  Validate `producer` against a JSON schema in the API.
- Avoid PostgreSQL `ENUM` types (hard to evolve). Use `text + CHECK` or small
  lookup tables.
- `ON DELETE RESTRICT` everywhere from scholarly to derived data. Use
  `withdrawn_at` for retraction, not deletion.
- Index every FK. Keep `updated_at` in triggers.
- Lexical search: PostgreSQL has no Latin or Ancient Greek text-search configuration,
  so use `simple` + `unaccent` if needed. NICE later.
- Row-level security for `access_level`: NICE. v1 can enforce it in the API layer,
  but put the column in now.

---

## 13. Things that would make future research difficult

- No text date → no valid period or drift analysis on translations.
- No full input set for clustering runs → no proportions, no reproducibility.
- Mutable text bodies → silently wrong offsets.
- Filter-relevant fields buried in JSONB → slow, unindexed, inconsistent.
- No citation locus → results that can't be checked against a printed edition.
- No translator record → translator style confused with author or period effect.
- No coverage flag → partial translations skew cross-language comparisons.
- No liturgical occasion on sermons → can't compare sermons on the same pericope
  or church-year day, which is the most natural comparison set in a lectionary church.

---

## 14. Unnecessary complexity for v1

- `user_hash` (HMAC pseudonym). Drop it.
- `updated_by`/`updated_at` on insert-only derived tables.
- Requiring centroids.
- Generic PROV-style "activity" graph. A required `producer` object on
  four entities is enough.
- Generic text-to-text relation graph. `base_text_id` + `supersedes_text_id` is enough.
- Variants, manuscripts, alignment tables, projections, hierarchical clusters, datasets.
- A stored label `status` column (derive it from reviews).
- Per-row audit of bulk vector data.

---

# A. Recommended conceptual model

**Scholarly layer (curated, mutable with audit, except Text body)**

- **person**: id, display_name, name_variants, is_living (nullable), birth/death year
  range, external_ids, access_level, metadata
- **work**: id, title, title_variants, year_from, year_to, date_note,
  original_languages[] (nullable = unknown), part_of_work_id, genre
  (treatise | sermon | letter | confession | commentary | …), external_ids, metadata
- **work_person**: work_id, person_id, role, certainty, note
- **sermon_occasion** (SHOULD, 1:1 with work where genre = sermon): preached_on,
  church_year_day, lectionary, lectionary_year, pericopes[], place
- **source**: id, kind, citation fields, url, retrieved_at, license, rights_holder,
  access_level, metadata
- **text**: id, work_id, source_id, language (BCP 47), relation
  (original | translation | adaptation), translated_from_language, base_text_id,
  base_note, coverage, coverage_note, year_from, year_to, body (NFC, immutable once
  segmented), content_sha256, supersedes_text_id, access_level, withdrawn_at, metadata
- **text_person** (SHOULD): text_id, person_id, role (translator | editor | transcriber)
- **text_division** (SHOULD): text_id, kind, label, start, end, parent_id

**Derived layer (insert-only, immutable, provenance required)**

- **segmentation**: id, text_id, method, parameters, producer
- **chunk**: id, segmentation_id, text_id (denormalised), sequence, start, end, text,
  locus, language (override), UNIQUE(segmentation_id, sequence)
- **embedding_space**: id, name, model, revision, dimensions, element_type, metric,
  normalized, doc_prefix, query_prefix, max_tokens, is_multilingual, producer
- **embedding**: id, chunk_id, embedding_space_id, vector, UNIQUE(chunk_id, space)
- **clustering_run**: id, embedding_space_id, algorithm, parameters, metric,
  input_filter (descriptive), producer, status (open | complete | withdrawn)
- **cluster**: id, clustering_run_id, cluster_number, centroid (nullable), size, metadata
- **cluster_membership**: clustering_run_id, embedding_id, cluster_id (NULL = noise),
  distance, score. PK(run, embedding)
- **label**: id, cluster_id, language, label, description, producer_kind, model,
  model_version, producer, supersedes_label_id
- **label_review**: id, label_id, reviewer_id, decision, note

**Identity and audit**

- **app_user** (public): id, kind, role, status
- **auth_identity**, **user_pii** (private schema)
- **audit_event** (append-only)

Every table: `created_by`, `created_at`. Mutable tables also have `updated_by`, `updated_at`.

# B. ASCII model (narrow)

```
Person
  │ work_person
  │ (role, certainty)
  ▼
Work ─part_of─▶ Work
  │ 1:n
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
         user_pii
            │ user_id
            ▼
public:  app_user (uuid)
            │ created_by /
            │ updated_by
            ▼
   all tables + audit_event
```

# C. Most important changes (in order)

1. Add **Source** and move edition, license and access into it. Add `access_level`.
2. Replace `Work.author_id` with **work_person** (role + certainty). Rename Author → Person.
3. Replace `type` with `relation` + `translated_from_language` + optional
   `base_text_id`. Allow several originals. Add **text dates** and `coverage`.
4. Make Text bodies **immutable, NFC, hashed**. Define offsets as **code points, half-open**.
5. Add **Segmentation**. Chunks belong to it. Add `locus`.
6. Turn EmbeddingModel into an immutable **EmbeddingSpace** (revision, metric,
   prefixes, normalisation). Make `(chunk, space)` unique. Use per-space partial HNSW indexes.
7. Point cluster membership at **embedding_id**, record **every input incl. noise**,
   and add **run status**.
8. Make labels immutable with **label_review** decisions, and add `producer_kind`.
9. Drop `user_hash`. Add **service principals**, a **private schema** for auth
   identity + PII, and an **append-only audit_event**.
10. Write down the **research-subject personal data policy** for living preachers and sermon content.

# D. Assumptions to document before implementation

1. Offset unit, normalisation (NFC, `\n`) and immutability of text bodies.
2. What "original" means. A Work may have zero, one or several originals.
3. Which date period analyses use (work vs text), and how uncertain dates are represented.
4. Language tagging standard (BCP 47) and how mixed-language texts are handled.
5. One embedding space = one comparable vector space. No cross-space similarity.
   Callers are responsible for query-vector compatibility.
6. Clustering runs are immutable snapshots. They are not updated when the corpus changes.
7. Labels are descriptive research metadata. Review ≠ doctrinal endorsement.
8. Licensing and access: who may read restricted text, and whether chunks and
   embeddings of restricted text inherit the restriction (recommended: yes).
9. Living-person and sermon-content data policy: lawful basis, consent/licence,
   redaction, retention.
10. Pseudonymous user IDs are personal data. How erasure and audit retention interact.
11. Service-account attribution: who is `created_by` for script-ingested data.
12. Deletion semantics: withdraw, don't delete. `RESTRICT` on all provenance FKs.
13. Expected scale (texts, chunks, spaces, runs). This drives index and partitioning choices.
14. Out of scope for v1: variants/apparatus, manuscripts, alignment, TEI, lexical search.
