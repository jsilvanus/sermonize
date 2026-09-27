import { Type, type FastifyPluginAsyncTypebox, type Static } from '@fastify/type-provider-typebox';
import { withTransaction } from '../../db/transaction.js';
import { writeBatchAudit } from '../../lib/batch-audit.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { keyset, Page, PaginationQuery, toPage } from '../../lib/pagination.js';
import { insertSql, SqlParams, type Db } from '../../lib/sql.js';
import { parseVector } from '../../lib/vector.js';
import { principalOf, requireRole } from '../../plugins/auth.js';
import { EFFECTIVE_ACCESS_SQL } from '../scholarly/texts.js';
import {
  DateTime,
  errorResponses,
  IdParams,
  JsonObject,
  LanguageTag,
  Nullable,
  Uuid,
  WithdrawnFields,
} from '../schemas.js';
import {
  assertCanReadRestricted,
  BatchResult,
  batchConflictError,
  batchValidationError,
  duplicateErrors,
  Producer,
  type DerivedOptions,
  type ItemError,
} from './common.js';

const AccessLevelOut = Type.Union([Type.Literal('public'), Type.Literal('restricted')]);
const INT4_MAX = 2147483647;

// ---------------------------------------------------------------------------
// Segmentations
// ---------------------------------------------------------------------------

const SEGMENTATION_COLUMNS = ['id', 'text_id', 'method', 'parameters', 'producer'] as const;

const CreateSegmentationBody = Type.Object({
  id: Type.Optional(Uuid),
  text_id: Uuid,
  method: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }),
  parameters: Type.Optional(JsonObject),
  producer: Producer,
});

const segmentationColumns = {
  id: Uuid,
  text_id: Uuid,
  method: Type.String(),
  parameters: JsonObject,
  producer: JsonObject,
  ...WithdrawnFields,
  created_by: Uuid,
  created_at: DateTime,
};
const SegmentationSummary = Type.Object(segmentationColumns);
const SegmentationSchema = Type.Object({
  ...segmentationColumns,
  chunk_count: Type.Integer(),
});

const SEGMENTATION_FIELDS_SQL = [...SEGMENTATION_COLUMNS, 'withdrawn_at', 'withdrawn_by', 'withdrawn_reason', 'created_by', 'created_at']
  .map((c) => `sg.${c}`)
  .join(', ');

async function getSegmentation(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT ${SEGMENTATION_FIELDS_SQL},
            (SELECT count(*)::int FROM chunk c WHERE c.segmentation_id = sg.id) AS chunk_count
       FROM segmentation sg WHERE sg.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('segmentation not found');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

const ChunkInput = Type.Object({
  id: Type.Optional(Uuid),
  sequence: Type.Integer({ minimum: 0, maximum: INT4_MAX }),
  start_offset: Type.Integer({ minimum: 0, maximum: INT4_MAX, description: 'Code points, inclusive.' }),
  end_offset: Type.Integer({ minimum: 1, maximum: INT4_MAX, description: 'Code points, exclusive.' }),
  text: Type.String({ minLength: 1, description: 'Must equal the body substring [start_offset, end_offset).' }),
  locus: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  language: Type.Optional(Nullable(LanguageTag)),
  metadata: Type.Optional(JsonObject),
});
type ChunkInput = Static<typeof ChunkInput>;

const chunkColumns = {
  id: Uuid,
  segmentation_id: Uuid,
  text_id: Uuid,
  sequence: Type.Integer(),
  start_offset: Type.Integer(),
  end_offset: Type.Integer(),
  text: Type.String(),
  locus: Nullable(Type.String()),
  language: Nullable(Type.String({ description: 'Override of the text language (mixed-language texts); null = text language.' })),
  content_sha256: Type.String(),
  metadata: JsonObject,
  created_by: Uuid,
  created_at: DateTime,
};
export const ChunkSchema = Type.Object(chunkColumns);

const ChunkEmbedding = Type.Object({
  id: Uuid,
  embedding_space_id: Uuid,
  space_name: Type.String(),
  dimensions: Type.Integer(),
  metric: Type.String(),
  created_at: DateTime,
  vector: Type.Optional(Type.Array(Type.Number())),
});
const ChunkDetailSchema = Type.Object({
  ...chunkColumns,
  effective_access_level: AccessLevelOut,
  embeddings: Type.Optional(Type.Array(ChunkEmbedding)),
});

/** Chunk columns for SELECT from `chunk c` (language is a domain: cast to text). */
export const CHUNK_FIELDS_SQL = Object.keys(chunkColumns)
  .map((c) => (c === 'language' ? 'c.language::text AS language' : `c.${c}`))
  .join(', ');

/** Column arrays for `unnest` (one array per column; null for absent optional values). */
function chunkArrays(items: readonly ChunkInput[]) {
  return {
    ids: items.map((c) => c.id ?? null),
    sequences: items.map((c) => c.sequence),
    starts: items.map((c) => c.start_offset),
    ends: items.map((c) => c.end_offset),
    texts: items.map((c) => c.text),
    loci: items.map((c) => c.locus ?? null),
    languages: items.map((c) => c.language ?? null),
    metadata: items.map((c) => (c.metadata === undefined ? null : JSON.stringify(c.metadata))),
  };
}

const OFFSET_MESSAGES: Record<string, string> = {
  offsets_out_of_range: 'end_offset exceeds the text char_length (code points)',
  length_mismatch: 'text length (code points) differs from end_offset - start_offset',
  text_mismatch: 'text differs from the text body substring [start_offset, end_offset)',
};

/**
 * Validates offsets and chunk texts against the body in SQL, so code-point
 * semantics are PostgreSQL's (`substr`/`char_length`), not JavaScript's
 * UTF-16. The body is detoasted once (`body || ''` in a materialised CTE).
 */
async function offsetErrors(db: Db, textId: string, items: readonly ChunkInput[]): Promise<ItemError[]> {
  const a = chunkArrays(items);
  const { rows } = await db.query<{ idx: string; reason: string }>(
    `WITH b AS MATERIALIZED (SELECT body || '' AS body, char_length AS len FROM text WHERE id = $1)
     SELECT idx, reason FROM (
       SELECT n.idx,
              CASE WHEN n.end_offset > b.len THEN 'offsets_out_of_range'
                   WHEN char_length(n.text) <> n.end_offset - n.start_offset THEN 'length_mismatch'
                   WHEN substr(b.body, n.start_offset + 1, n.end_offset - n.start_offset) <> n.text THEN 'text_mismatch'
              END AS reason
         FROM b, unnest($2::int[], $3::int[], $4::text[]) WITH ORDINALITY AS n(start_offset, end_offset, text, idx)
     ) x WHERE reason IS NOT NULL`,
    [textId, a.starts, a.ends, a.texts],
  );
  return rows.map((r) => {
    const index = Number(r.idx) - 1;
    const item = items[index]!;
    return {
      index,
      sequence: item.sequence,
      reason: r.reason,
      message: OFFSET_MESSAGES[r.reason] ?? r.reason,
    };
  });
}

/** Chunk batch ingestion; see POST /segmentations/:id/chunks. */
async function insertChunks(db: Parameters<typeof writeBatchAudit>[0], segmentationId: string, items: ChunkInput[]) {
  const { rows: segs } = await db.query(
    `SELECT sg.text_id, sg.withdrawn_at AS seg_withdrawn_at, t.withdrawn_at AS text_withdrawn_at
       FROM segmentation sg JOIN text t ON t.id = sg.text_id
      WHERE sg.id = $1 FOR SHARE OF sg, t`,
    [segmentationId],
  );
  const seg = segs[0] as { text_id: string; seg_withdrawn_at: Date | null; text_withdrawn_at: Date | null } | undefined;
  if (!seg) throw notFound('segmentation not found');
  if (seg.seg_withdrawn_at) throw conflict('segmentation is withdrawn; chunks cannot be added');
  if (seg.text_withdrawn_at) throw conflict('text is withdrawn; chunks cannot be added');

  const errors = await offsetErrors(db, seg.text_id, items);
  if (errors.length) throw batchValidationError(errors, items.length);

  const a = chunkArrays(items);
  const values = [segmentationId, seg.text_id, a.ids, a.sequences, a.starts, a.ends, a.texts, a.loci, a.languages, a.metadata];
  const UNNEST = `unnest($3::uuid[], $4::int[], $5::int[], $6::int[], $7::text[], $8::text[], $9::text[], $10::text[])
                  WITH ORDINALITY AS n(id, sequence, start_offset, end_offset, text, locus, language, metadata, idx)`;
  // Rows whose key already exists (committed, or committed concurrently: ON CONFLICT waits) are skipped here
  // and compared below; any difference rolls the whole batch back.
  const inserted = await db.query<{ sequence: number }>(
    `INSERT INTO chunk (id, segmentation_id, text_id, sequence, start_offset, end_offset, text, locus, language, metadata)
     SELECT coalesce(n.id, uuid_generate_v7()), $1, $2, n.sequence, n.start_offset, n.end_offset, n.text, n.locus,
            n.language, coalesce(n.metadata::jsonb, '{}')
       FROM ${UNNEST}
      ORDER BY n.idx
     ON CONFLICT (segmentation_id, sequence) DO NOTHING
     RETURNING sequence`,
    values,
  );
  const insertedCount = inserted.rowCount ?? 0;
  const skippedCount = items.length - insertedCount;
  if (skippedCount > 0) {
    const { rows } = await db.query<{ idx: string; sequence: number; existing_id: string }>(
      `SELECT n.idx, n.sequence, c.id AS existing_id
         FROM ${UNNEST}
         JOIN chunk c ON c.segmentation_id = $1 AND c.sequence = n.sequence
        WHERE c.text_id = $2
          AND n.sequence <> ALL($11::int[])
          AND NOT (c.start_offset = n.start_offset AND c.end_offset = n.end_offset AND c.text = n.text
                   AND c.locus IS NOT DISTINCT FROM n.locus
                   AND c.language::text IS NOT DISTINCT FROM n.language
                   AND c.metadata = coalesce(n.metadata::jsonb, '{}')
                   AND (n.id IS NULL OR n.id = c.id))`,
      [...values, inserted.rows.map((r) => r.sequence)],
    );
    if (rows.length) {
      throw batchConflictError(
        rows.map((r) => ({ index: Number(r.idx) - 1, sequence: r.sequence, existing_id: r.existing_id })),
        'chunks',
      );
    }
  }
  if (insertedCount > 0) {
    await writeBatchAudit(db, {
      entityType: 'chunk',
      parentId: segmentationId,
      count: insertedCount,
      changes: { parent_type: 'segmentation', skipped: skippedCount },
    });
  }
  return { inserted: insertedCount, skipped: skippedCount };
}

async function chunkAccess(db: Db, where: string, id: string) {
  const { rows } = await db.query(
    `SELECT ${EFFECTIVE_ACCESS_SQL} AS effective_access_level
       FROM text t LEFT JOIN source s ON s.id = t.source_id WHERE ${where}`,
    [id],
  );
  return rows[0]?.effective_access_level as 'public' | 'restricted' | undefined;
}

export const segmentationRoutes: FastifyPluginAsyncTypebox<DerivedOptions> = async (app, opts) => {
  app.post(
    '/segmentations',
    {
      preHandler: requireRole('contributor'),
      schema: { body: CreateSegmentationBody, response: { 201: SegmentationSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const body = request.body;
      const seg = await withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const { rows } = await client.query('SELECT withdrawn_at FROM text WHERE id = $1 FOR SHARE', [body.text_id]);
        if (!rows[0]) throw unprocessable('text_id does not reference an existing text');
        if (rows[0].withdrawn_at) throw conflict('text is withdrawn; segmentations cannot be added');
        const sql = insertSql('segmentation', SEGMENTATION_COLUMNS, body);
        const inserted = await client.query(sql.text, sql.values);
        return getSegmentation(client, inserted.rows[0].id);
      });
      return reply.status(201).send(seg);
    },
  );

  app.get(
    '/segmentations/:id',
    {
      preHandler: requireRole('reader'),
      schema: { params: IdParams, response: { 200: SegmentationSchema, ...errorResponses } },
    },
    async (request) => getSegmentation(app.pg, request.params.id),
  );

  app.get(
    '/texts/:id/segmentations',
    {
      preHandler: requireRole('reader'),
      schema: {
        params: IdParams,
        querystring: Type.Object({
          ...PaginationQuery,
          include_withdrawn: Type.Optional(Type.Boolean({ description: 'Include withdrawn segmentations (default false).' })),
        }),
        response: { 200: Page(SegmentationSummary), ...errorResponses },
      },
    },
    async (request) => {
      const q = request.query;
      const exists = await app.pg.query('SELECT 1 FROM text WHERE id = $1', [request.params.id]);
      if (!exists.rowCount) throw notFound('text not found');
      const p = new SqlParams();
      const where = [`sg.text_id = ${p.add(request.params.id)}`];
      if (!q.include_withdrawn) where.push('sg.withdrawn_at IS NULL');
      const page = keyset(p, q, 'sg.id');
      where.push(...page.where);
      const { rows } = await app.pg.query(
        `SELECT ${SEGMENTATION_FIELDS_SQL} FROM segmentation sg WHERE ${where.join(' AND ')} ORDER BY sg.id ${page.limitSql}`,
        p.values,
      );
      return toPage(rows, page.limit);
    },
  );

  app.post(
    '/segmentations/:id/chunks',
    {
      preHandler: requireRole('contributor'),
      schema: {
        params: IdParams,
        body: Type.Array(ChunkInput, { minItems: 1, maxItems: opts.maxBatchItems }),
        response: { 200: BatchResult, ...errorResponses },
      },
    },
    async (request) => {
      const items = request.body;
      const errors: ItemError[] = [
        ...duplicateErrors(items, (c) => c.sequence, 'sequence'),
        ...duplicateErrors(items, (c) => c.id?.toLowerCase(), 'id'),
      ];
      items.forEach((c, index) => {
        if (c.start_offset >= c.end_offset) {
          errors.push({
            index,
            sequence: c.sequence,
            reason: 'invalid_offsets',
            message: 'start_offset must be less than end_offset',
          });
        }
      });
      if (errors.length) throw batchValidationError(errors, items.length);
      return withTransaction(app.pg, principalOf(request), request.id, (client) =>
        insertChunks(client, request.params.id, items),
      );
    },
  );

  app.get(
    '/segmentations/:id/chunks',
    {
      preHandler: requireRole('reader'),
      schema: {
        params: IdParams,
        querystring: Type.Object(PaginationQuery),
        response: { 200: Page(ChunkSchema), ...errorResponses },
      },
    },
    async (request) => {
      const id = request.params.id;
      const access = await chunkAccess(
        app.pg,
        't.id = (SELECT text_id FROM segmentation WHERE id = $1)',
        id,
      );
      if (!access) throw notFound('segmentation not found');
      assertCanReadRestricted(principalOf(request), access, 'chunks');
      const p = new SqlParams();
      const where = [`c.segmentation_id = ${p.add(id)}`];
      const page = keyset(p, request.query, 'c.sequence', { valid: (k) => /^\d{1,10}$/.test(k), cast: 'int' });
      where.push(...page.where);
      const { rows } = await app.pg.query(
        `SELECT ${CHUNK_FIELDS_SQL} FROM chunk c WHERE ${where.join(' AND ')} ORDER BY c.sequence ${page.limitSql}`,
        p.values,
      );
      return toPage(rows, page.limit, (r) => r.sequence as number);
    },
  );

  app.get(
    '/chunks/:id',
    {
      preHandler: requireRole('reader'),
      schema: {
        params: IdParams,
        querystring: Type.Object({
          include_embeddings: Type.Optional(
            Type.Boolean({ description: 'List the embeddings of this chunk (space summaries, no vectors).' }),
          ),
          include_vectors: Type.Optional(
            Type.Boolean({ description: 'With include_embeddings: also return each vector (can be large).' }),
          ),
        }),
        response: { 200: ChunkDetailSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { rows } = await app.pg.query(
        `SELECT ${CHUNK_FIELDS_SQL}, ${EFFECTIVE_ACCESS_SQL} AS effective_access_level
           FROM chunk c JOIN text t ON t.id = c.text_id LEFT JOIN source s ON s.id = t.source_id
          WHERE c.id = $1`,
        [request.params.id],
      );
      const chunk = rows[0];
      if (!chunk) throw notFound('chunk not found');
      assertCanReadRestricted(principalOf(request), chunk.effective_access_level, 'chunks');
      if (request.query.include_embeddings) {
        const withVectors = request.query.include_vectors === true;
        const { rows: embeddings } = await app.pg.query(
          `SELECT e.id, e.embedding_space_id, es.name AS space_name, es.dimensions, es.metric, e.created_at
                  ${withVectors ? ', e.vector::text AS vector' : ''}
             FROM embedding e JOIN embedding_space es ON es.id = e.embedding_space_id
            WHERE e.chunk_id = $1 ORDER BY es.name, e.id`,
          [chunk.id],
        );
        chunk.embeddings = withVectors
          ? embeddings.map((e) => ({ ...e, vector: parseVector(e.vector as string) }))
          : embeddings;
      }
      return chunk;
    },
  );
};
