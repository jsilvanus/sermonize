-- Sermonize v1 schema. See README.md (spec) and docs/implementation-plan.md.
--
-- Custom SQLSTATEs raised by triggers (mapped to HTTP errors by the API):
--   SZ001  no authenticated principal (app.user_id not set)       -> 500 (server bug)
--   SZ002  attempt to modify an immutable record/column             -> 409 immutable
--   SZ003  invalid state (e.g. clustering run not open)             -> 409 conflict
--   SZ004  cross-record validation failed (dimension, space, genre) -> 422 validation_failed

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------

-- UUIDv7 (RFC 9562): 48-bit unix ms timestamp, version 7, variant 10, random rest.
CREATE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $$
DECLARE
  b bytea := uuid_send(gen_random_uuid());  -- 16 random bytes with variant bits already 10xx
  ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
BEGIN
  b := overlay(b PLACING substring(int8send(ms) FROM 3) FROM 1 FOR 6);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);  -- version 7
  RETURN encode(b, 'hex')::uuid;
END $$;

-- The authenticated principal of the current transaction. Raises if unset,
-- so every write must happen inside withTransaction() (or set app.user_id).
CREATE FUNCTION app_actor_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v text := current_setting('app.user_id', true);
BEGIN
  IF v IS NULL OR v = '' THEN
    RAISE EXCEPTION 'app.user_id is not set: writes require an authenticated principal'
      USING ERRCODE = 'SZ001';
  END IF;
  RETURN v::uuid;
END $$;

CREATE FUNCTION app_request_id() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.request_id', true), '') $$;

-- BCP 47 language tag (syntactic check only).
CREATE DOMAIN language_tag AS text
  CHECK (VALUE ~ '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$');

CREATE DOMAIN sha256_hex AS text CHECK (VALUE ~ '^[0-9a-f]{64}$');

-- `producer` describes the external process that produced a derived record.
CREATE FUNCTION is_valid_producer(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_typeof(p) = 'object'
     AND jsonb_typeof(p -> 'tool') = 'string' AND length(p ->> 'tool') > 0
     AND jsonb_typeof(p -> 'version') = 'string' AND length(p ->> 'version') > 0
     AND (NOT p ? 'commit' OR jsonb_typeof(p -> 'commit') = 'string')
     AND (NOT p ? 'parameters' OR jsonb_typeof(p -> 'parameters') = 'object')
     AND (NOT p ? 'run_at' OR jsonb_typeof(p -> 'run_at') = 'string')
     AND (NOT p ? 'notes' OR jsonb_typeof(p -> 'notes') = 'string'), false)
$$;

-- BEFORE INSERT OR UPDATE: fills audit columns from the principal, never from
-- the client. Handles any subset of created_*, updated_*, withdrawn_by, reviewer_id.
CREATE FUNCTION stamp_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := app_actor_id();
  cur jsonb := to_jsonb(NEW);
  patch jsonb := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    patch := jsonb_build_object('created_by', actor, 'created_at', now());
    IF cur ? 'updated_by' THEN
      patch := patch || jsonb_build_object('updated_by', actor, 'updated_at', now());
    END IF;
    IF cur ? 'withdrawn_by' THEN
      patch := patch || jsonb_build_object('withdrawn_by',
        CASE WHEN cur ->> 'withdrawn_at' IS NULL THEN NULL ELSE actor END);
    END IF;
    IF cur ? 'reviewer_id' THEN
      patch := patch || jsonb_build_object('reviewer_id', actor);
    END IF;
  ELSE
    patch := jsonb_build_object('created_by', to_jsonb(OLD) -> 'created_by',
                                'created_at', to_jsonb(OLD) -> 'created_at');
    IF cur ? 'updated_by' THEN
      patch := patch || jsonb_build_object('updated_by', actor, 'updated_at', now());
    END IF;
    IF cur ? 'withdrawn_by' THEN
      IF (cur -> 'withdrawn_at') IS DISTINCT FROM (to_jsonb(OLD) -> 'withdrawn_at') THEN
        patch := patch || jsonb_build_object('withdrawn_by',
          CASE WHEN cur ->> 'withdrawn_at' IS NULL THEN NULL ELSE actor END);
      ELSE
        patch := patch || jsonb_build_object('withdrawn_by', to_jsonb(OLD) -> 'withdrawn_by');
      END IF;
    END IF;
    IF cur ? 'reviewer_id' THEN
      patch := patch || jsonb_build_object('reviewer_id', to_jsonb(OLD) -> 'reviewer_id');
    END IF;
  END IF;
  NEW := jsonb_populate_record(NEW, patch);
  RETURN NEW;
END $$;

-- Cheaper variant of stamp_row() for high-volume insert-only tables that only
-- have created_by/created_at (chunk, embedding, cluster, cluster_membership, label).
CREATE FUNCTION stamp_created() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_by := app_actor_id();
  NEW.created_at := now();
  RETURN NEW;
END $$;

-- BEFORE UPDATE OR DELETE on insert-only tables. TG_ARGV lists the columns that
-- may still change (e.g. withdrawn_at, withdrawn_reason, status). Audit columns
-- are managed by stamp_row() and ignored here.
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := TG_ARGV::text[] || ARRAY['created_by', 'created_at', 'updated_by', 'updated_at', 'withdrawn_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% records cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'SZ002';
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION '% records are immutable (mutable columns: %)', TG_TABLE_NAME,
      coalesce(nullif(array_to_string(TG_ARGV::text[], ', '), ''), 'none')
      USING ERRCODE = 'SZ002';
  END IF;
  RETURN NEW;
END $$;

-- BEFORE DELETE on curated tables that are withdrawn instead of deleted.
CREATE FUNCTION forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records cannot be deleted; withdraw them instead', TG_TABLE_NAME
    USING ERRCODE = 'SZ002';
END $$;

-- ---------------------------------------------------------------------------
-- Users and audit (public)
-- ---------------------------------------------------------------------------

CREATE TABLE app_user (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- random, not time-ordered (pseudonym)
  kind        text NOT NULL CHECK (kind IN ('human', 'service')),
  role        text NOT NULL CHECK (role IN ('reader', 'contributor', 'curator', 'admin')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by  uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL,
  updated_by  uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE audit_event (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  action       text NOT NULL CHECK (action ~ '^[a-z][a-z_]*$'),
  entity_type  text NOT NULL,
  entity_id    uuid,
  batch_count  integer CHECK (batch_count >= 0),
  request_id   text,
  changes      jsonb
);
CREATE INDEX audit_event_entity_idx ON audit_event (entity_type, entity_id);
CREATE INDEX audit_event_actor_idx ON audit_event (actor_id);
CREATE INDEX audit_event_request_idx ON audit_event (request_id);

CREATE FUNCTION audit_event_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- schema-qualified: also reached from private SECURITY DEFINER functions
  NEW.actor_id := public.app_actor_id();
  NEW.request_id := public.app_request_id();
  NEW.occurred_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION audit_event_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only' USING ERRCODE = 'SZ002';
END $$;

CREATE TRIGGER a_stamp BEFORE INSERT ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_stamp();
CREATE TRIGGER a_append_only BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
CREATE TRIGGER a_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();

-- AFTER INSERT OR UPDATE OR DELETE row-level audit.
--   TG_ARGV[0]      name of the column used as entity_id (default 'id')
--   TG_ARGV[1..]    columns never copied into `changes` (e.g. large bodies)
-- action: insert | update | delete | withdraw | status_change
CREATE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  id_col text := coalesce(TG_ARGV[0], 'id');
  skip text[] := coalesce(TG_ARGV[1:], '{}'::text[])
                 || ARRAY['created_by', 'created_at', 'updated_by', 'updated_at'];
  o jsonb;
  n jsonb;
  diff jsonb := '{}';
  k text;
  act text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    n := to_jsonb(NEW);
    INSERT INTO audit_event (action, entity_type, entity_id, changes)
      VALUES ('insert', TG_TABLE_NAME, (n ->> id_col)::uuid, n - skip);
    RETURN NULL;
  ELSIF TG_OP = 'DELETE' THEN
    o := to_jsonb(OLD);
    INSERT INTO audit_event (action, entity_type, entity_id, changes)
      VALUES ('delete', TG_TABLE_NAME, (o ->> id_col)::uuid, o - skip);
    RETURN NULL;
  END IF;

  o := to_jsonb(OLD) - skip;
  n := to_jsonb(NEW) - skip;
  FOR k IN SELECT jsonb_object_keys(n) LOOP
    IF (n -> k) IS DISTINCT FROM (o -> k) THEN
      diff := diff || jsonb_build_object(k, jsonb_build_object('old', o -> k, 'new', n -> k));
    END IF;
  END LOOP;
  IF diff = '{}' THEN
    RETURN NULL;
  END IF;

  IF diff ? 'withdrawn_at' AND o ->> 'withdrawn_at' IS NULL THEN
    act := 'withdraw';
  ELSIF diff ? 'status' AND TG_TABLE_NAME = 'clustering_run' THEN
    act := 'status_change';
  ELSE
    act := 'update';
  END IF;
  INSERT INTO audit_event (action, entity_type, entity_id, changes)
    VALUES (act, TG_TABLE_NAME, (to_jsonb(NEW) ->> id_col)::uuid, diff);
  RETURN NULL;
END $$;

CREATE TRIGGER b_stamp BEFORE INSERT OR UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION stamp_row();
CREATE TRIGGER a_no_delete BEFORE DELETE ON app_user
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER z_audit AFTER INSERT OR UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ---------------------------------------------------------------------------
-- Scholarly layer
-- ---------------------------------------------------------------------------

CREATE TABLE person (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  display_name      text NOT NULL CHECK (length(btrim(display_name)) > 0),
  name_variants     text[] NOT NULL DEFAULT '{}',
  is_living         boolean,
  year_from         integer,
  year_to           integer,
  date_note         text,
  external_ids      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(external_ids) = 'object'),
  metadata          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  withdrawn_at      timestamptz,
  withdrawn_by      uuid REFERENCES app_user ON DELETE RESTRICT,
  withdrawn_reason  text,
  created_by        uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL,
  updated_by        uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL,
  CHECK (year_from IS NULL OR year_to IS NULL OR year_from <= year_to)
);
CREATE INDEX person_years_idx ON person (year_from, year_to);
CREATE INDEX person_display_name_idx ON person (lower(display_name));

CREATE TABLE work (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  title               text NOT NULL CHECK (length(btrim(title)) > 0),
  title_variants      text[] NOT NULL DEFAULT '{}',
  genre               text NOT NULL CHECK (genre IN ('treatise', 'sermon', 'letter', 'confession',
                                                     'commentary', 'homily', 'hymn', 'other')),
  original_languages  language_tag[],  -- NULL = unknown
  part_of_work_id     uuid REFERENCES work ON DELETE RESTRICT CHECK (part_of_work_id <> id),
  year_from           integer,
  year_to             integer,
  date_note           text,
  external_ids        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(external_ids) = 'object'),
  metadata            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  withdrawn_at        timestamptz,
  withdrawn_by        uuid REFERENCES app_user ON DELETE RESTRICT,
  withdrawn_reason    text,
  created_by          uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL,
  updated_by          uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL,
  CHECK (year_from IS NULL OR year_to IS NULL OR year_from <= year_to)
);
CREATE INDEX work_genre_idx ON work (genre);
CREATE INDEX work_years_idx ON work (year_from, year_to);
CREATE INDEX work_part_of_idx ON work (part_of_work_id);

CREATE TABLE work_person (
  work_id     uuid NOT NULL REFERENCES work ON DELETE RESTRICT,
  person_id   uuid NOT NULL REFERENCES person ON DELETE RESTRICT,
  role        text NOT NULL CHECK (role IN ('author', 'attributed_author', 'pseudonymous_author', 'compiler')),
  certainty   text NOT NULL DEFAULT 'certain' CHECK (certainty IN ('certain', 'probable', 'disputed', 'spurious')),
  note        text,
  created_by  uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL,
  updated_by  uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (work_id, person_id, role)
);
CREATE INDEX work_person_person_idx ON work_person (person_id);

CREATE TABLE sermon_occasion (
  work_id          uuid PRIMARY KEY REFERENCES work ON DELETE RESTRICT,
  preached_on      date,
  church_year_day  text,
  lectionary       text,
  lectionary_year  text,
  pericopes        text[] NOT NULL DEFAULT '{}',
  place            text,
  metadata         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_by       uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL,
  updated_by       uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  updated_at       timestamptz NOT NULL
);
CREATE INDEX sermon_occasion_preached_on_idx ON sermon_occasion (preached_on);
CREATE INDEX sermon_occasion_church_year_day_idx ON sermon_occasion (church_year_day);

-- sermon_occasion only exists for works of genre 'sermon'.
CREATE FUNCTION sermon_occasion_check_genre() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'sermon_occasion' THEN
    IF NOT EXISTS (SELECT 1 FROM work WHERE id = NEW.work_id AND genre = 'sermon') THEN
      RAISE EXCEPTION 'sermon_occasion requires a work of genre sermon' USING ERRCODE = 'SZ004';
    END IF;
  ELSIF OLD.genre = 'sermon' AND NEW.genre <> 'sermon'
        AND EXISTS (SELECT 1 FROM sermon_occasion WHERE work_id = NEW.id) THEN
    RAISE EXCEPTION 'work % has a sermon_occasion; genre must stay sermon', NEW.id USING ERRCODE = 'SZ004';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c_check_genre BEFORE INSERT OR UPDATE ON sermon_occasion
  FOR EACH ROW EXECUTE FUNCTION sermon_occasion_check_genre();
CREATE TRIGGER c_check_occasion BEFORE UPDATE OF genre ON work
  FOR EACH ROW EXECUTE FUNCTION sermon_occasion_check_genre();

CREATE TABLE source (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  kind              text NOT NULL CHECK (kind IN ('print_edition', 'digital_edition', 'manuscript',
                                                  'recording_transcript', 'author_submission', 'other')),
  citation          text NOT NULL CHECK (length(btrim(citation)) > 0),
  editor            text,
  title             text,
  series            text,
  volume            text,
  publisher         text,
  place             text,
  year              integer,
  url               text,
  retrieved_at      timestamptz,
  license           text,
  rights_holder     text,
  access_level      text NOT NULL DEFAULT 'public' CHECK (access_level IN ('public', 'restricted')),
  metadata          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  withdrawn_at      timestamptz,
  withdrawn_by      uuid REFERENCES app_user ON DELETE RESTRICT,
  withdrawn_reason  text,
  created_by        uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL,
  updated_by        uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL
);
CREATE INDEX source_kind_idx ON source (kind);
CREATE INDEX source_access_level_idx ON source (access_level);

CREATE TABLE text (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  work_id                   uuid NOT NULL REFERENCES work ON DELETE RESTRICT,
  source_id                 uuid REFERENCES source ON DELETE RESTRICT,
  language                  language_tag NOT NULL,
  relation                  text NOT NULL CHECK (relation IN ('original', 'translation', 'adaptation')),
  translated_from_language  language_tag,
  base_text_id              uuid,
  base_note                 text,
  coverage                  text NOT NULL DEFAULT 'complete' CHECK (coverage IN ('complete', 'partial', 'excerpt')),
  coverage_note             text,
  year_from                 integer,
  year_to                   integer,
  date_note                 text,
  title                     text,
  body                      text NOT NULL,
  content_sha256            sha256_hex NOT NULL,  -- computed by trigger
  char_length               integer NOT NULL,     -- code points, computed by trigger
  supersedes_text_id        uuid,
  access_level              text NOT NULL DEFAULT 'public' CHECK (access_level IN ('public', 'restricted')),
  metadata                  jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  withdrawn_at              timestamptz,
  withdrawn_by              uuid REFERENCES app_user ON DELETE RESTRICT,
  withdrawn_reason          text,
  created_by                uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at                timestamptz NOT NULL,
  updated_by                uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  updated_at                timestamptz NOT NULL,
  CONSTRAINT text_body_nfc CHECK (body IS NFC NORMALIZED),
  CONSTRAINT text_body_no_cr CHECK (position(E'\r' IN body) = 0),
  CONSTRAINT text_body_not_empty CHECK (body <> ''),
  CONSTRAINT text_translated_from_only_for_non_original
    CHECK (translated_from_language IS NULL OR relation <> 'original'),
  CHECK (year_from IS NULL OR year_to IS NULL OR year_from <= year_to),
  CHECK (base_text_id <> id AND supersedes_text_id <> id),
  UNIQUE (id, work_id),
  -- base and superseded texts must belong to the same work
  FOREIGN KEY (base_text_id, work_id) REFERENCES text (id, work_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_text_id, work_id) REFERENCES text (id, work_id) ON DELETE RESTRICT
);
CREATE INDEX text_work_idx ON text (work_id);
CREATE INDEX text_source_idx ON text (source_id);
CREATE INDEX text_language_idx ON text (language);
CREATE INDEX text_relation_idx ON text (relation);
CREATE INDEX text_years_idx ON text (year_from, year_to);
CREATE INDEX text_base_idx ON text (base_text_id);
CREATE INDEX text_supersedes_idx ON text (supersedes_text_id);
CREATE INDEX text_content_sha256_idx ON text (content_sha256);

-- body is immutable; hash and length are always derived from it.
CREATE FUNCTION text_body_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.body IS DISTINCT FROM OLD.body THEN
      RAISE EXCEPTION 'text.body is immutable; create a new text with supersedes_text_id'
        USING ERRCODE = 'SZ002';
    END IF;
    NEW.content_sha256 := OLD.content_sha256;
    NEW.char_length := OLD.char_length;
  ELSE
    NEW.content_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
    NEW.char_length := char_length(NEW.body);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_body_guard BEFORE INSERT OR UPDATE ON text
  FOR EACH ROW EXECUTE FUNCTION text_body_guard();

CREATE TABLE text_person (
  text_id     uuid NOT NULL REFERENCES text ON DELETE RESTRICT,
  person_id   uuid NOT NULL REFERENCES person ON DELETE RESTRICT,
  role        text NOT NULL CHECK (role IN ('translator', 'editor', 'transcriber', 'reviser')),
  note        text,
  created_by  uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL,
  updated_by  uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (text_id, person_id, role)
);
CREATE INDEX text_person_person_idx ON text_person (person_id);

-- Scholarly triggers: audit columns, row audit, no deletes for withdrawable records.
CREATE TRIGGER b_stamp BEFORE INSERT OR UPDATE ON person FOR EACH ROW EXECUTE FUNCTION stamp_row();
CREATE TRIGGER b_stamp BEFORE INSERT OR UPDATE ON work FOR EACH ROW EXECUTE FUNCTION stamp_row();
CREATE TRIGGER b_stamp BEFORE INSERT OR UPDATE ON work_person FOR EACH ROW EXECUTE FUNCTION stamp_row();
CREATE TRIGGER b_stamp BEFORE INSERT OR UPDATE ON sermon_occasion FOR EACH ROW EXECUTE FUNCTION stamp_row();
CREATE TRIGGER b_stamp BEFORE INSERT OR UPDATE ON source FOR EACH ROW EXECUTE FUNCTION stamp_row();
CREATE TRIGGER b_stamp BEFORE INSERT OR UPDATE ON text FOR EACH ROW EXECUTE FUNCTION stamp_row();
CREATE TRIGGER b_stamp BEFORE INSERT OR UPDATE ON text_person FOR EACH ROW EXECUTE FUNCTION stamp_row();

CREATE TRIGGER a_no_delete BEFORE DELETE ON person FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER a_no_delete BEFORE DELETE ON work FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER a_no_delete BEFORE DELETE ON source FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER a_no_delete BEFORE DELETE ON text FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TRIGGER z_audit AFTER INSERT OR UPDATE ON person FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER z_audit AFTER INSERT OR UPDATE ON work FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER z_audit AFTER INSERT OR UPDATE OR DELETE ON work_person
  FOR EACH ROW EXECUTE FUNCTION audit_row('work_id');
CREATE TRIGGER z_audit AFTER INSERT OR UPDATE OR DELETE ON sermon_occasion
  FOR EACH ROW EXECUTE FUNCTION audit_row('work_id');
CREATE TRIGGER z_audit AFTER INSERT OR UPDATE ON source FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER z_audit AFTER INSERT OR UPDATE ON text
  FOR EACH ROW EXECUTE FUNCTION audit_row('id', 'body');
CREATE TRIGGER z_audit AFTER INSERT OR UPDATE OR DELETE ON text_person
  FOR EACH ROW EXECUTE FUNCTION audit_row('text_id');

-- ---------------------------------------------------------------------------
-- Derived layer (insert-only)
-- ---------------------------------------------------------------------------

CREATE TABLE segmentation (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  text_id           uuid NOT NULL REFERENCES text ON DELETE RESTRICT,
  method            text NOT NULL CHECK (length(btrim(method)) > 0),
  parameters        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(parameters) = 'object'),
  producer          jsonb NOT NULL CHECK (is_valid_producer(producer)),
  withdrawn_at      timestamptz,
  withdrawn_by      uuid REFERENCES app_user ON DELETE RESTRICT,
  withdrawn_reason  text,
  created_by        uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL,
  UNIQUE (id, text_id)
);
CREATE INDEX segmentation_text_idx ON segmentation (text_id);

CREATE TABLE chunk (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  segmentation_id  uuid NOT NULL,
  text_id          uuid NOT NULL REFERENCES text ON DELETE RESTRICT,
  sequence         integer NOT NULL CHECK (sequence >= 0),
  start_offset     integer NOT NULL CHECK (start_offset >= 0),
  end_offset       integer NOT NULL,
  text             text NOT NULL,
  locus            text,
  language         language_tag,
  content_sha256   sha256_hex NOT NULL,  -- computed by trigger
  metadata         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_by       uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL,
  CHECK (start_offset < end_offset),
  CHECK (char_length(text) = end_offset - start_offset),
  UNIQUE (segmentation_id, sequence),
  -- text_id is denormalised; it must match the segmentation's text.
  FOREIGN KEY (segmentation_id, text_id) REFERENCES segmentation (id, text_id) ON DELETE RESTRICT
);
CREATE INDEX chunk_text_idx ON chunk (text_id);
CREATE INDEX chunk_language_idx ON chunk (language) WHERE language IS NOT NULL;

CREATE FUNCTION chunk_compute_hash() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.content_sha256 := encode(sha256(convert_to(NEW.text, 'UTF8')), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER c_hash BEFORE INSERT ON chunk FOR EACH ROW EXECUTE FUNCTION chunk_compute_hash();

CREATE TABLE embedding_space (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  name              text NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
  model             text NOT NULL,
  revision          text NOT NULL,
  dimensions        integer NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
  element_type      text NOT NULL DEFAULT 'float32' CHECK (element_type IN ('float32', 'float16')),
  metric            text NOT NULL CHECK (metric IN ('cosine', 'inner_product', 'l2')),
  normalized        boolean NOT NULL,
  document_prefix   text,
  query_prefix      text,
  max_tokens        integer CHECK (max_tokens > 0),
  truncation        text,
  pooling           text,
  is_multilingual   boolean NOT NULL DEFAULT false,
  producer          jsonb NOT NULL CHECK (is_valid_producer(producer)),
  metadata          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  withdrawn_at      timestamptz,
  withdrawn_by      uuid REFERENCES app_user ON DELETE RESTRICT,
  withdrawn_reason  text,
  created_by        uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL
);

CREATE TABLE embedding (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  chunk_id            uuid NOT NULL REFERENCES chunk ON DELETE RESTRICT,
  embedding_space_id  uuid NOT NULL REFERENCES embedding_space ON DELETE RESTRICT,
  vector              vector NOT NULL,  -- untyped; per-space partial HNSW indexes are created via the CLI
  metadata            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_by          uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL,
  UNIQUE (chunk_id, embedding_space_id)
);
CREATE INDEX embedding_space_idx ON embedding (embedding_space_id);

-- Statement-level check: every inserted vector has its space's dimension.
CREATE FUNCTION embedding_check_dimensions() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bad record;
BEGIN
  SELECT n.chunk_id, vector_dims(n.vector) AS got, s.dimensions AS want INTO bad
    FROM new_rows n JOIN embedding_space s ON s.id = n.embedding_space_id
   WHERE vector_dims(n.vector) <> s.dimensions
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'embedding for chunk % has % dimensions, space requires %',
      bad.chunk_id, bad.got, bad.want USING ERRCODE = 'SZ004';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER c_check_dimensions AFTER INSERT ON embedding
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION embedding_check_dimensions();

CREATE TABLE clustering_run (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  embedding_space_id  uuid NOT NULL REFERENCES embedding_space ON DELETE RESTRICT,
  algorithm           text NOT NULL,
  parameters          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(parameters) = 'object'),
  metric              text NOT NULL,
  input_filter        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(input_filter) = 'object'),
  producer            jsonb NOT NULL CHECK (is_valid_producer(producer)),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'complete', 'withdrawn')),
  completed_at        timestamptz,
  metadata            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_by          uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL,
  CHECK (status <> 'complete' OR completed_at IS NOT NULL)
);
CREATE INDEX clustering_run_space_idx ON clustering_run (embedding_space_id);
CREATE INDEX clustering_run_status_idx ON clustering_run (status);

-- Runs are created open; allowed transitions: open->complete, open->withdrawn, complete->withdrawn.
CREATE FUNCTION clustering_run_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'clustering runs must be created with status open' USING ERRCODE = 'SZ003';
    END IF;
    NEW.completed_at := NULL;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'open' AND NEW.status IN ('complete', 'withdrawn'))
            OR (OLD.status = 'complete' AND NEW.status = 'withdrawn')) THEN
      RAISE EXCEPTION 'invalid clustering run transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'SZ003';
    END IF;
    IF NEW.status = 'complete' THEN
      NEW.completed_at := now();
    ELSE
      NEW.completed_at := OLD.completed_at;
    END IF;
  ELSE
    NEW.completed_at := OLD.completed_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c_status_guard BEFORE INSERT OR UPDATE ON clustering_run
  FOR EACH ROW EXECUTE FUNCTION clustering_run_status_guard();

CREATE TABLE cluster (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  clustering_run_id  uuid NOT NULL REFERENCES clustering_run ON DELETE RESTRICT,
  cluster_number     integer NOT NULL,
  centroid           vector,
  size               integer CHECK (size >= 0),
  parent_cluster_id  uuid,
  metadata           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_by         uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL,
  UNIQUE (clustering_run_id, cluster_number),
  UNIQUE (id, clustering_run_id),
  CHECK (parent_cluster_id <> id),
  -- parent cluster must belong to the same run
  FOREIGN KEY (parent_cluster_id, clustering_run_id) REFERENCES cluster (id, clustering_run_id) ON DELETE RESTRICT
);
CREATE INDEX cluster_parent_idx ON cluster (parent_cluster_id);

CREATE TABLE cluster_membership (
  clustering_run_id  uuid NOT NULL REFERENCES clustering_run ON DELETE RESTRICT,
  embedding_id       uuid NOT NULL REFERENCES embedding ON DELETE RESTRICT,
  cluster_id         uuid,  -- NULL = noise / unassigned
  distance           double precision,
  score              double precision,
  metadata           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_by         uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL,
  PRIMARY KEY (clustering_run_id, embedding_id),
  -- the cluster must belong to the membership's run
  FOREIGN KEY (cluster_id, clustering_run_id) REFERENCES cluster (id, clustering_run_id) ON DELETE RESTRICT
);
CREATE INDEX cluster_membership_embedding_idx ON cluster_membership (embedding_id);
CREATE INDEX cluster_membership_cluster_idx ON cluster_membership (cluster_id);

-- Statement-level: clusters/memberships may only be inserted while the run is open.
-- The run rows are locked FOR SHARE, so a concurrent completion waits for (or blocks) us.
CREATE FUNCTION cluster_check_run_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bad record;
BEGIN
  PERFORM 1 FROM clustering_run
   WHERE id IN (SELECT DISTINCT clustering_run_id FROM new_rows)
   ORDER BY id FOR SHARE;
  SELECT r.id, r.status INTO bad FROM clustering_run r
   WHERE r.id IN (SELECT DISTINCT clustering_run_id FROM new_rows) AND r.status <> 'open'
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'clustering run % is %; % can only be added while it is open',
      bad.id, bad.status, TG_TABLE_NAME USING ERRCODE = 'SZ003';
  END IF;

  IF TG_TABLE_NAME = 'cluster' THEN
    SELECT n.cluster_number, vector_dims(n.centroid) AS got, s.dimensions AS want INTO bad
      FROM new_rows n
      JOIN clustering_run r ON r.id = n.clustering_run_id
      JOIN embedding_space s ON s.id = r.embedding_space_id
     WHERE n.centroid IS NOT NULL AND vector_dims(n.centroid) <> s.dimensions
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'centroid of cluster % has % dimensions, space requires %',
        bad.cluster_number, bad.got, bad.want USING ERRCODE = 'SZ004';
    END IF;
  ELSE
    SELECT n.embedding_id INTO bad
      FROM new_rows n
      JOIN clustering_run r ON r.id = n.clustering_run_id
      JOIN embedding e ON e.id = n.embedding_id
     WHERE e.embedding_space_id <> r.embedding_space_id
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'embedding % is not in the clustering run''s embedding space', bad.embedding_id
        USING ERRCODE = 'SZ004';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER c_check_run_open AFTER INSERT ON cluster
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION cluster_check_run_open();
CREATE TRIGGER c_check_run_open AFTER INSERT ON cluster_membership
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION cluster_check_run_open();

CREATE TABLE label (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  cluster_id           uuid NOT NULL REFERENCES cluster ON DELETE RESTRICT,
  language             language_tag NOT NULL,
  label                text NOT NULL CHECK (length(btrim(label)) > 0),
  description          text,
  producer_kind        text NOT NULL CHECK (producer_kind IN ('model', 'human')),
  model                text,
  model_version        text,
  producer             jsonb CHECK (producer IS NULL OR is_valid_producer(producer)),
  supersedes_label_id  uuid,
  metadata             jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_by           uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL,
  CHECK (producer_kind <> 'model' OR (producer IS NOT NULL AND model IS NOT NULL)),
  CHECK (supersedes_label_id <> id),
  UNIQUE (id, cluster_id),
  -- a superseded label must belong to the same cluster
  FOREIGN KEY (supersedes_label_id, cluster_id) REFERENCES label (id, cluster_id) ON DELETE RESTRICT
);
CREATE INDEX label_cluster_idx ON label (cluster_id);
CREATE INDEX label_supersedes_idx ON label (supersedes_label_id);
CREATE INDEX label_language_idx ON label (language);

CREATE TABLE label_review (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  label_id     uuid NOT NULL REFERENCES label ON DELETE RESTRICT,
  reviewer_id  uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,  -- = the principal, set by trigger
  decision     text NOT NULL CHECK (decision IN ('accepted', 'rejected', 'needs_revision')),
  note         text,
  created_by   uuid NOT NULL REFERENCES app_user ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL
);
CREATE INDEX label_review_label_idx ON label_review (label_id, created_at);
CREATE INDEX label_review_reviewer_idx ON label_review (reviewer_id);

-- Derived triggers.
CREATE TRIGGER a_insert_only BEFORE UPDATE OR DELETE ON segmentation
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('withdrawn_at', 'withdrawn_reason');
CREATE TRIGGER a_insert_only BEFORE UPDATE OR DELETE ON chunk
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER a_insert_only BEFORE UPDATE OR DELETE ON embedding_space
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('withdrawn_at', 'withdrawn_reason');
CREATE TRIGGER a_insert_only BEFORE UPDATE OR DELETE ON embedding
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER a_insert_only BEFORE UPDATE OR DELETE ON clustering_run
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('status', 'completed_at');
CREATE TRIGGER a_insert_only BEFORE UPDATE OR DELETE ON cluster
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER a_insert_only BEFORE UPDATE OR DELETE ON cluster_membership
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER a_insert_only BEFORE UPDATE OR DELETE ON label
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER a_insert_only BEFORE UPDATE OR DELETE ON label_review
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER b_stamp BEFORE INSERT OR UPDATE ON segmentation FOR EACH ROW EXECUTE FUNCTION stamp_row();
CREATE TRIGGER b_stamp BEFORE INSERT ON chunk FOR EACH ROW EXECUTE FUNCTION stamp_created();
CREATE TRIGGER b_stamp BEFORE INSERT OR UPDATE ON embedding_space FOR EACH ROW EXECUTE FUNCTION stamp_row();
CREATE TRIGGER b_stamp BEFORE INSERT ON embedding FOR EACH ROW EXECUTE FUNCTION stamp_created();
CREATE TRIGGER b_stamp BEFORE INSERT OR UPDATE ON clustering_run FOR EACH ROW EXECUTE FUNCTION stamp_row();
CREATE TRIGGER b_stamp BEFORE INSERT ON cluster FOR EACH ROW EXECUTE FUNCTION stamp_created();
CREATE TRIGGER b_stamp BEFORE INSERT ON cluster_membership FOR EACH ROW EXECUTE FUNCTION stamp_created();
CREATE TRIGGER b_stamp BEFORE INSERT ON label FOR EACH ROW EXECUTE FUNCTION stamp_created();
CREATE TRIGGER b_stamp BEFORE INSERT ON label_review FOR EACH ROW EXECUTE FUNCTION stamp_row();

-- Row-level audit for the small derived tables; chunk, embedding, cluster and
-- cluster_membership are audited once per batch by the API (src/lib/batch-audit.ts).
CREATE TRIGGER z_audit AFTER INSERT OR UPDATE ON segmentation FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER z_audit AFTER INSERT OR UPDATE ON embedding_space FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER z_audit AFTER INSERT OR UPDATE ON clustering_run FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER z_audit AFTER INSERT ON label FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER z_audit AFTER INSERT ON label_review FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ---------------------------------------------------------------------------
-- Private schema: authentication and account PII.
-- The application role gets no table privileges here (see sql/roles.sql);
-- access goes through the SECURITY DEFINER functions below.
-- ---------------------------------------------------------------------------

CREATE SCHEMA private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;

CREATE TABLE private.auth_identity (
  issuer      text NOT NULL,
  subject     text NOT NULL,
  user_id     uuid NOT NULL REFERENCES public.app_user ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX auth_identity_user_idx ON private.auth_identity (user_id);

CREATE TABLE private.api_token (
  id            uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  user_id       uuid NOT NULL REFERENCES public.app_user ON DELETE RESTRICT,
  token_sha256  public.sha256_hex NOT NULL UNIQUE,
  name          text NOT NULL,
  created_by    uuid NOT NULL REFERENCES public.app_user ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX api_token_user_idx ON private.api_token (user_id);

CREATE TABLE private.user_pii (
  user_id       uuid PRIMARY KEY REFERENCES public.app_user ON DELETE RESTRICT,
  email         text,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Raises unless the current principal is an active admin (defence in depth:
-- the API also checks roles before calling these functions).
CREATE FUNCTION private.require_admin() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := public.app_actor_id();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_user
                  WHERE id = actor AND role = 'admin' AND status = 'active') THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END $$;

-- Resolves an API token hash to its principal. Revoked or expired tokens and
-- non-active users resolve to no row.
CREATE FUNCTION private.resolve_token(p_token_sha256 text)
RETURNS TABLE (user_id uuid, role text, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.role, u.kind
    FROM private.api_token t
    JOIN public.app_user u ON u.id = t.user_id
   WHERE t.token_sha256 = p_token_sha256
     AND t.revoked_at IS NULL
     AND (t.expires_at IS NULL OR t.expires_at > now())
     AND u.status = 'active'
$$;

-- Stores a new token hash for a user. The plaintext token never reaches the database.
CREATE FUNCTION private.create_api_token(p_user_id uuid, p_name text, p_token_sha256 text,
                                         p_expires_at timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := private.require_admin();
  new_id uuid;
BEGIN
  INSERT INTO private.api_token (user_id, token_sha256, name, created_by, expires_at)
  VALUES (p_user_id, p_token_sha256, p_name, actor, p_expires_at)
  RETURNING id INTO new_id;
  INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
  VALUES ('token_create', 'api_token', new_id,
          jsonb_build_object('user_id', p_user_id, 'expires_at', p_expires_at));
  RETURN new_id;
END $$;

-- Revokes a token. Returns false if no such token exists. Idempotent.
CREATE FUNCTION private.revoke_api_token(p_token_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  owner uuid;
BEGIN
  PERFORM private.require_admin();
  UPDATE private.api_token SET revoked_at = coalesce(revoked_at, now())
   WHERE id = p_token_id RETURNING user_id INTO owner;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
  VALUES ('token_revoke', 'api_token', p_token_id, jsonb_build_object('user_id', owner));
  RETURN true;
END $$;

-- Writes account PII. The audit event records which fields changed, never their values.
CREATE FUNCTION private.set_user_pii(p_user_id uuid, p_email text, p_display_name text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM private.require_admin();
  INSERT INTO private.user_pii (user_id, email, display_name)
  VALUES (p_user_id, p_email, p_display_name)
  ON CONFLICT (user_id) DO UPDATE
    SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = now();
  INSERT INTO public.audit_event (action, entity_type, entity_id, changes)
  VALUES ('pii_update', 'user_pii', p_user_id,
          jsonb_build_object('fields',
            to_jsonb(array_remove(ARRAY[CASE WHEN p_email IS NOT NULL THEN 'email' END,
                                        CASE WHEN p_display_name IS NOT NULL THEN 'display_name' END],
                                  NULL))));
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Bootstrap: the fixed system principal used by the CLI and migrations.
-- ---------------------------------------------------------------------------

SELECT set_config('app.user_id', '00000000-0000-7000-8000-000000000000', true);
SELECT set_config('app.request_id', 'migration:0001_init', true);
INSERT INTO app_user (id, kind, role) VALUES ('00000000-0000-7000-8000-000000000000', 'service', 'admin');
