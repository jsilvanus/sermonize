import { Type, type FastifyPluginAsyncTypebox, type Static } from '@fastify/type-provider-typebox';
import { withTransaction } from '../../db/transaction.js';
import { writeBatchAudit } from '../../lib/batch-audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { keyset, Page, PaginationQuery, toPage } from '../../lib/pagination.js';
import { insertSql, SqlParams, type Db } from '../../lib/sql.js';
import { indexStatus } from '../../lib/vector-index.js';
import { toVectorLiteral, vectorProblem, type Metric } from '../../lib/vector.js';
import { principalOf, requireRole } from '../../plugins/auth.js';
import { DateTime, errorResponses, IdParams, JsonObject, Nullable, Uuid, WithdrawnFields } from '../schemas.js';
import {
  BatchResult,
  batchConflictError,
  batchValidationError,
  duplicateErrors,
  Producer,
  type DerivedOptions,
  type ItemError,
} from './common.js';

export const MetricSchema = Type.Union([Type.Literal('cosine'), Type.Literal('inner_product'), Type.Literal('l2')]);
const ElementType = Type.Union([Type.Literal('float32'), Type.Literal('float16')]);

const SPACE_COLUMNS = [
  'id',
  'name',
  'model',
  'revision',
  'dimensions',
  'element_type',
  'metric',
  'normalized',
  'document_prefix',
  'query_prefix',
  'max_tokens',
  'truncation',
  'pooling',
  'is_multilingual',
  'producer',
  'metadata',
] as const;

const OptionalText = Type.Optional(Nullable(Type.String({ maxLength: 4000 })));

const CreateSpaceBody = Type.Object({
  id: Type.Optional(Uuid),
  name: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' }),
  model: Type.String({ minLength: 1, maxLength: 500 }),
  revision: Type.String({ minLength: 1, maxLength: 500 }),
  dimensions: Type.Integer({ minimum: 1, maximum: 16000 }),
  element_type: Type.Optional(ElementType),
  metric: MetricSchema,
  normalized: Type.Boolean(),
  document_prefix: OptionalText,
  query_prefix: OptionalText,
  max_tokens: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 2147483647 }))),
  truncation: OptionalText,
  pooling: OptionalText,
  is_multilingual: Type.Optional(Type.Boolean()),
  producer: Producer,
  metadata: Type.Optional(JsonObject),
});

const NullableString = Nullable(Type.String());
const spaceColumns = {
  id: Uuid,
  name: Type.String(),
  model: Type.String(),
  revision: Type.String(),
  dimensions: Type.Integer(),
  element_type: ElementType,
  metric: MetricSchema,
  normalized: Type.Boolean(),
  document_prefix: NullableString,
  query_prefix: NullableString,
  max_tokens: Nullable(Type.Integer()),
  truncation: NullableString,
  pooling: NullableString,
  is_multilingual: Type.Boolean(),
  producer: JsonObject,
  metadata: JsonObject,
  ...WithdrawnFields,
  created_by: Uuid,
  created_at: DateTime,
};
export const SpaceSummary = Type.Object(spaceColumns);
const SpaceSchema = Type.Object({
  ...spaceColumns,
  hnsw_index: Type.Union([Type.Literal('absent'), Type.Literal('valid'), Type.Literal('invalid')], {
    description: 'State of the per-space HNSW index (created with the CLI `create-index`).',
  }),
});

export const SPACE_FIELDS_SQL = [...SPACE_COLUMNS, 'withdrawn_at', 'withdrawn_by', 'withdrawn_reason', 'created_by', 'created_at']
  .map((c) => `es.${c}`)
  .join(', ');

export interface SpaceRow {
  id: string;
  dimensions: number;
  metric: Metric;
  normalized: boolean;
  withdrawn_at: Date | null;
}

/** Loads an embedding space (optionally locking it FOR SHARE); 404 if absent. */
export async function loadSpace(db: Db, id: string, lock = false): Promise<SpaceRow> {
  const { rows } = await db.query<SpaceRow>(
    `SELECT id, dimensions, metric, normalized, withdrawn_at FROM embedding_space WHERE id = $1${lock ? ' FOR SHARE' : ''}`,
    [id],
  );
  if (!rows[0]) throw notFound('embedding space not found');
  return rows[0];
}

async function getSpace(db: Db, id: string) {
  const { rows } = await db.query(`SELECT ${SPACE_FIELDS_SQL} FROM embedding_space es WHERE es.id = $1`, [id]);
  if (!rows[0]) throw notFound('embedding space not found');
  return rows[0];
}

const EmbeddingInput = Type.Object({
  id: Type.Optional(Uuid),
  chunk_id: Uuid,
  vector: Type.Array(Type.Number(), { minItems: 1, maxItems: 16000 }),
  metadata: Type.Optional(JsonObject),
});
type EmbeddingInput = Static<typeof EmbeddingInput>;

const CHUNK_MESSAGES: Record<string, string> = {
  chunk_not_found: 'chunk_id does not reference an existing chunk',
  chunk_withdrawn: 'the chunk belongs to a withdrawn segmentation, text or work',
};

async function insertEmbeddings(db: Parameters<typeof writeBatchAudit>[0], spaceId: string, items: EmbeddingInput[]) {
  const space = await loadSpace(db, spaceId, true);
  if (space.withdrawn_at) throw conflict('embedding space is withdrawn; embeddings cannot be added');

  const errors: ItemError[] = [];
  items.forEach((item, index) => {
    const problem = vectorProblem(item.vector, space);
    if (problem) errors.push({ index, chunk_id: item.chunk_id, reason: 'invalid_vector', message: problem });
  });
  const chunkIds = items.map((e) => e.chunk_id);
  const { rows: bad } = await db.query<{ idx: string; reason: string }>(
    `SELECT idx, reason FROM (
       SELECT n.idx,
              CASE WHEN c.id IS NULL THEN 'chunk_not_found'
                   WHEN sg.withdrawn_at IS NOT NULL OR t.withdrawn_at IS NOT NULL OR w.withdrawn_at IS NOT NULL
                     THEN 'chunk_withdrawn'
              END AS reason
         FROM unnest($1::uuid[]) WITH ORDINALITY AS n(chunk_id, idx)
         LEFT JOIN chunk c ON c.id = n.chunk_id
         LEFT JOIN segmentation sg ON sg.id = c.segmentation_id
         LEFT JOIN text t ON t.id = c.text_id
         LEFT JOIN work w ON w.id = t.work_id
     ) x WHERE reason IS NOT NULL`,
    [chunkIds],
  );
  for (const r of bad) {
    const index = Number(r.idx) - 1;
    errors.push({ index, chunk_id: items[index]!.chunk_id, reason: r.reason, message: CHUNK_MESSAGES[r.reason] ?? r.reason });
  }
  if (errors.length) throw batchValidationError(errors, items.length);

  const values = [
    spaceId,
    items.map((e) => e.id ?? null),
    chunkIds,
    items.map((e) => toVectorLiteral(e.vector)),
    items.map((e) => (e.metadata === undefined ? null : JSON.stringify(e.metadata))),
  ];
  const UNNEST = `unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[]) WITH ORDINALITY AS n(id, chunk_id, vector, metadata, idx)`;
  const inserted = await db.query<{ chunk_id: string }>(
    `INSERT INTO embedding (id, chunk_id, embedding_space_id, vector, metadata)
     SELECT coalesce(n.id, uuid_generate_v7()), n.chunk_id, $1, n.vector::vector, coalesce(n.metadata::jsonb, '{}')
       FROM ${UNNEST}
      ORDER BY n.idx
     ON CONFLICT (chunk_id, embedding_space_id) DO NOTHING
     RETURNING chunk_id`,
    values,
  );
  const insertedCount = inserted.rowCount ?? 0;
  const skippedCount = items.length - insertedCount;
  if (skippedCount > 0) {
    // Existing rows (including ones committed concurrently; ON CONFLICT waited for them) must match exactly.
    const { rows } = await db.query<{ idx: string; chunk_id: string; existing_id: string }>(
      `SELECT n.idx, n.chunk_id, e.id AS existing_id
         FROM ${UNNEST}
         JOIN embedding e ON e.chunk_id = n.chunk_id AND e.embedding_space_id = $1
        WHERE n.chunk_id <> ALL($6::uuid[])
          AND NOT (e.vector = n.vector::vector
                   AND e.metadata = coalesce(n.metadata::jsonb, '{}')
                   AND (n.id IS NULL OR n.id = e.id))`,
      [...values, inserted.rows.map((r) => r.chunk_id)],
    );
    if (rows.length) {
      throw batchConflictError(
        rows.map((r) => ({ index: Number(r.idx) - 1, chunk_id: r.chunk_id, existing_id: r.existing_id })),
        'embeddings',
      );
    }
  }
  if (insertedCount > 0) {
    await writeBatchAudit(db, {
      entityType: 'embedding',
      parentId: spaceId,
      count: insertedCount,
      changes: { parent_type: 'embedding_space', skipped: skippedCount },
    });
  }
  return { inserted: insertedCount, skipped: skippedCount };
}

export const embeddingRoutes: FastifyPluginAsyncTypebox<DerivedOptions> = async (app, opts) => {
  app.post(
    '/embedding-spaces',
    {
      preHandler: requireRole('contributor'),
      schema: { body: CreateSpaceBody, response: { 201: SpaceSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const space = await withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const sql = insertSql('embedding_space', SPACE_COLUMNS, request.body);
        const { rows } = await client.query(sql.text, sql.values);
        return getSpace(client, rows[0].id);
      });
      return reply.status(201).send({ ...space, hnsw_index: 'absent' });
    },
  );

  app.get(
    '/embedding-spaces',
    {
      preHandler: requireRole('reader'),
      schema: {
        querystring: Type.Object({
          ...PaginationQuery,
          include_withdrawn: Type.Optional(Type.Boolean({ description: 'Include withdrawn spaces (default false).' })),
        }),
        response: { 200: Page(SpaceSummary), ...errorResponses },
      },
    },
    async (request) => {
      const q = request.query;
      const p = new SqlParams();
      const where: string[] = [];
      if (!q.include_withdrawn) where.push('es.withdrawn_at IS NULL');
      const page = keyset(p, q, 'es.id');
      where.push(...page.where);
      const { rows } = await app.pg.query(
        `SELECT ${SPACE_FIELDS_SQL} FROM embedding_space es WHERE ${where.join(' AND ') || 'true'} ORDER BY es.id ${page.limitSql}`,
        p.values,
      );
      return toPage(rows, page.limit);
    },
  );

  app.get(
    '/embedding-spaces/:id',
    {
      preHandler: requireRole('reader'),
      schema: { params: IdParams, response: { 200: SpaceSchema, ...errorResponses } },
    },
    async (request) => {
      const space = await getSpace(app.pg, request.params.id);
      return { ...space, hnsw_index: await indexStatus(app.pg, space.id) };
    },
  );

  app.post(
    '/embedding-spaces/:id/embeddings',
    {
      preHandler: requireRole('contributor'),
      schema: {
        params: IdParams,
        body: Type.Array(EmbeddingInput, { minItems: 1, maxItems: opts.maxBatchItems }),
        response: { 200: BatchResult, ...errorResponses },
      },
    },
    async (request) => {
      const items = request.body;
      const errors = [
        ...duplicateErrors(items, (e) => e.chunk_id.toLowerCase(), 'chunk_id'),
        ...duplicateErrors(items, (e) => e.id?.toLowerCase(), 'id'),
      ];
      if (errors.length) throw batchValidationError(errors, items.length);
      return withTransaction(app.pg, principalOf(request), request.id, (client) =>
        insertEmbeddings(client, request.params.id, items),
      );
    },
  );
};
