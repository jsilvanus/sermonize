import { Type, type FastifyPluginAsyncTypebox, type Static } from '@fastify/type-provider-typebox';
import { withTransaction } from '../../db/transaction.js';
import { writeBatchAudit } from '../../lib/batch-audit.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { keyset, Page, PaginationQuery, toPage } from '../../lib/pagination.js';
import { hasRole } from '../../lib/principal.js';
import { insertSql, SqlParams, type Db } from '../../lib/sql.js';
import { toVectorLiteral, vectorProblem } from '../../lib/vector.js';
import { principalOf, requireRole } from '../../plugins/auth.js';
import { WithdrawBody } from '../scholarly/common.js';
import { DateTime, errorResponses, IdParams, JsonObject, Nullable, Uuid } from '../schemas.js';
import {
  assertCanReadRun,
  BatchResult,
  batchConflictError,
  batchValidationError,
  duplicateErrors,
  Producer,
  type DerivedOptions,
  type ItemError,
  type RunStatus,
} from './common.js';

const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

export const RunStatusSchema = Type.Union([Type.Literal('open'), Type.Literal('complete'), Type.Literal('withdrawn')]);

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const RUN_COLUMNS = [
  'id',
  'embedding_space_id',
  'algorithm',
  'parameters',
  'metric',
  'input_filter',
  'producer',
  'metadata',
] as const;

const CreateRunBody = Type.Object({
  id: Type.Optional(Uuid),
  embedding_space_id: Uuid,
  algorithm: Type.String({ minLength: 1, maxLength: 500, pattern: '\\S', description: 'e.g. hdbscan, kmeans, agglomerative.' }),
  parameters: Type.Optional(JsonObject),
  metric: Type.Optional(
    Type.String({ minLength: 1, maxLength: 100, description: "Distance used by the algorithm; default: the space's metric." }),
  ),
  input_filter: Type.Optional(
    Type.Object({}, { additionalProperties: true, description: 'Descriptive only: how the input set was selected.' }),
  ),
  producer: Producer,
  metadata: Type.Optional(JsonObject),
});

const runColumns = {
  id: Uuid,
  embedding_space_id: Uuid,
  algorithm: Type.String(),
  parameters: JsonObject,
  metric: Type.String(),
  input_filter: JsonObject,
  producer: JsonObject,
  status: RunStatusSchema,
  completed_at: Nullable(DateTime),
  withdrawn_reason: Nullable(Type.String()),
  metadata: JsonObject,
  created_by: Uuid,
  created_at: DateTime,
};
export const RunSummary = Type.Object(runColumns);
export const RunCounts = {
  cluster_count: Type.Integer(),
  input_size: Type.Integer({ description: 'Number of memberships (the full input set of the run).' }),
  noise_count: Type.Integer({ description: 'Memberships without a cluster (noise/unassigned).' }),
};
const RunSchema = Type.Object({ ...runColumns, ...RunCounts });

export const RUN_FIELDS_SQL = Object.keys(runColumns)
  .map((c) => `r.${c}`)
  .join(', ');
export const RUN_COUNTS_SQL = `
  (SELECT count(*)::int FROM cluster c WHERE c.clustering_run_id = r.id) AS cluster_count,
  (SELECT count(*)::int FROM cluster_membership m WHERE m.clustering_run_id = r.id) AS input_size,
  (SELECT count(*)::int FROM cluster_membership m WHERE m.clustering_run_id = r.id AND m.cluster_id IS NULL) AS noise_count`;

async function getRun(db: Db, id: string) {
  const { rows } = await db.query(`SELECT ${RUN_FIELDS_SQL}, ${RUN_COUNTS_SQL} FROM clustering_run r WHERE r.id = $1`, [id]);
  if (!rows[0]) throw notFound('clustering run not found');
  return rows[0];
}

interface OpenRun {
  status: RunStatus;
  embedding_space_id: string;
  dimensions: number;
  space_withdrawn_at: Date | null;
}

/** Loads a run for a batch insert (locked FOR SHARE); 404 if absent, 409 unless open. */
async function loadOpenRun(db: Db, id: string): Promise<OpenRun> {
  const { rows } = await db.query<OpenRun>(
    `SELECT r.status, r.embedding_space_id, s.dimensions, s.withdrawn_at AS space_withdrawn_at
       FROM clustering_run r JOIN embedding_space s ON s.id = r.embedding_space_id
      WHERE r.id = $1 FOR SHARE OF r`,
    [id],
  );
  const run = rows[0];
  if (!run) throw notFound('clustering run not found');
  if (run.status !== 'open') throw conflict(`clustering run is ${run.status}; clusters and memberships can only be added while it is open`);
  return run;
}

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

const ClusterNumber = Type.Integer({ minimum: INT4_MIN, maximum: INT4_MAX });

const ClusterInput = Type.Object({
  id: Type.Optional(Uuid),
  cluster_number: ClusterNumber,
  centroid: Type.Optional(Nullable(Type.Array(Type.Number(), { minItems: 1, maxItems: 16000 }))),
  size: Type.Optional(
    Nullable(
      Type.Integer({
        minimum: 0,
        maximum: INT4_MAX,
        description: 'Memberships in this cluster and its descendants; verified (or filled if null) on complete.',
      }),
    ),
  ),
  parent_cluster_number: Type.Optional(
    Nullable(Type.Integer({ minimum: INT4_MIN, maximum: INT4_MAX, description: 'A cluster of the same run (stored or in this batch).' })),
  ),
  metadata: Type.Optional(JsonObject),
});
type ClusterInput = Static<typeof ClusterInput>;

export const clusterColumns = {
  id: Uuid,
  clustering_run_id: Uuid,
  cluster_number: Type.Integer(),
  size: Nullable(Type.Integer()),
  parent_cluster_id: Nullable(Uuid),
  parent_cluster_number: Nullable(Type.Integer()),
  metadata: JsonObject,
  created_by: Uuid,
  created_at: DateTime,
  member_count: Type.Integer({ description: 'Memberships assigned directly to this cluster.' }),
};
export const ClusterSummary = Type.Object(clusterColumns);

/** Cluster columns for SELECT from `cluster cl` (without centroid). */
export const CLUSTER_FIELDS_SQL = `cl.id, cl.clustering_run_id, cl.cluster_number, cl.size, cl.parent_cluster_id,
  (SELECT pc.cluster_number FROM cluster pc WHERE pc.id = cl.parent_cluster_id) AS parent_cluster_number,
  cl.metadata, cl.created_by, cl.created_at,
  (SELECT count(*)::int FROM cluster_membership m WHERE m.cluster_id = cl.id) AS member_count`;

/** Parent cycles among the new clusters of a batch (stored clusters cannot point into a batch). */
function parentCycleErrors(items: readonly ClusterInput[]): ItemError[] {
  const parentOf = new Map<number, number | null | undefined>();
  for (const c of items) parentOf.set(c.cluster_number, c.parent_cluster_number);
  const errors: ItemError[] = [];
  items.forEach((c, index) => {
    if (c.parent_cluster_number === c.cluster_number) return; // reported as self_parent
    const seen = new Set<number>([c.cluster_number]);
    let cur = c.parent_cluster_number;
    while (cur != null && parentOf.has(cur)) {
      if (seen.has(cur)) {
        errors.push({
          index,
          cluster_number: c.cluster_number,
          reason: 'parent_cycle',
          message: 'parent_cluster_number forms a cycle within the batch',
        });
        return;
      }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  });
  return errors;
}

async function insertClusters(db: Parameters<typeof writeBatchAudit>[0], runId: string, items: ClusterInput[]) {
  const run = await loadOpenRun(db, runId);

  const errors: ItemError[] = [];
  items.forEach((c, index) => {
    if (c.centroid != null) {
      // Centroids are means: any finite vector of the space's dimension (no unit-length/zero checks).
      const problem = vectorProblem(c.centroid, { dimensions: run.dimensions, metric: 'l2', normalized: false });
      if (problem) errors.push({ index, cluster_number: c.cluster_number, reason: 'invalid_centroid', message: problem });
    }
    if (c.parent_cluster_number != null && c.parent_cluster_number === c.cluster_number) {
      errors.push({ index, cluster_number: c.cluster_number, reason: 'self_parent', message: 'a cluster cannot be its own parent' });
    }
  });
  errors.push(...parentCycleErrors(items));

  const numbers = items.map((c) => c.cluster_number);
  const parents = items.map((c) => c.parent_cluster_number ?? null);
  const { rows: missing } = await db.query<{ idx: string }>(
    `SELECT n.idx FROM unnest($2::int[]) WITH ORDINALITY AS n(parent, idx)
      WHERE n.parent IS NOT NULL AND n.parent <> ALL($3::int[])
        AND NOT EXISTS (SELECT 1 FROM cluster c WHERE c.clustering_run_id = $1 AND c.cluster_number = n.parent)`,
    [runId, parents, numbers],
  );
  for (const r of missing) {
    const index = Number(r.idx) - 1;
    errors.push({
      index,
      cluster_number: items[index]!.cluster_number,
      reason: 'parent_not_found',
      message: 'parent_cluster_number is neither in this batch nor a stored cluster of the run',
    });
  }
  if (errors.length) throw batchValidationError(errors, items.length);

  const values = [
    runId,
    items.map((c) => c.id ?? null),
    numbers,
    items.map((c) => (c.centroid == null ? null : toVectorLiteral(c.centroid))),
    items.map((c) => c.size ?? null),
    parents,
    items.map((c) => (c.metadata === undefined ? null : JSON.stringify(c.metadata))),
  ];
  const UNNEST = `unnest($2::uuid[], $3::int[], $4::text[], $5::int[], $6::int[], $7::text[])
                  WITH ORDINALITY AS n(id, cluster_number, centroid, size, parent_number, metadata, idx)`;
  // One statement: the self-referencing FK is checked at its end, so a parent may follow its child.
  // A parent that is already stored wins over a (skipped) copy of it in the batch.
  const inserted = await db.query<{ cluster_number: number }>(
    `WITH n AS MATERIALIZED (
       SELECT coalesce(n.id, uuid_generate_v7()) AS new_id, n.* FROM ${UNNEST}
     )
     INSERT INTO cluster (id, clustering_run_id, cluster_number, centroid, size, parent_cluster_id, metadata)
     SELECT n.new_id, $1, n.cluster_number, n.centroid::vector, n.size,
            CASE WHEN n.parent_number IS NULL THEN NULL ELSE coalesce(e.id, p.new_id) END,
            coalesce(n.metadata::jsonb, '{}')
       FROM n
       LEFT JOIN cluster e ON e.clustering_run_id = $1 AND e.cluster_number = n.parent_number
       LEFT JOIN n p ON p.cluster_number = n.parent_number
      ORDER BY n.idx
     ON CONFLICT (clustering_run_id, cluster_number) DO NOTHING
     RETURNING cluster_number`,
    values,
  );
  const insertedCount = inserted.rowCount ?? 0;
  const skippedCount = items.length - insertedCount;
  if (skippedCount > 0) {
    const { rows } = await db.query<{ idx: string; cluster_number: number; existing_id: string }>(
      `SELECT n.idx, n.cluster_number, c.id AS existing_id
         FROM ${UNNEST}
         JOIN cluster c ON c.clustering_run_id = $1 AND c.cluster_number = n.cluster_number
         LEFT JOIN cluster pc ON pc.id = c.parent_cluster_id
        WHERE n.cluster_number <> ALL($8::int[])
          AND NOT (c.centroid IS NOT DISTINCT FROM n.centroid::vector
                   AND c.size IS NOT DISTINCT FROM n.size
                   AND pc.cluster_number IS NOT DISTINCT FROM n.parent_number
                   AND c.metadata = coalesce(n.metadata::jsonb, '{}')
                   AND (n.id IS NULL OR n.id = c.id))`,
      [...values, inserted.rows.map((r) => r.cluster_number)],
    );
    if (rows.length) {
      throw batchConflictError(
        rows.map((r) => ({ index: Number(r.idx) - 1, cluster_number: r.cluster_number, existing_id: r.existing_id })),
        'clusters',
      );
    }
  }
  if (insertedCount > 0) {
    await writeBatchAudit(db, {
      entityType: 'cluster',
      parentId: runId,
      count: insertedCount,
      changes: { parent_type: 'clustering_run', skipped: skippedCount },
    });
  }
  return { inserted: insertedCount, skipped: skippedCount };
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

const MembershipInput = Type.Object({
  embedding_id: Uuid,
  cluster_number: Type.Union([ClusterNumber, Type.Null()], {
    description: 'A cluster of this run (post clusters first), or null for noise/unassigned.',
  }),
  distance: Type.Optional(Nullable(Type.Number())),
  score: Type.Optional(Nullable(Type.Number())),
  metadata: Type.Optional(JsonObject),
});
type MembershipInput = Static<typeof MembershipInput>;

const MEMBERSHIP_MESSAGES: Record<string, string> = {
  embedding_not_found: 'embedding_id does not reference an existing embedding',
  wrong_embedding_space: "the embedding is not in the clustering run's embedding space",
  chunk_withdrawn: "the embedding's chunk belongs to a withdrawn segmentation, text or work",
  cluster_not_found: 'cluster_number is not a cluster of this run',
};

async function insertMemberships(db: Parameters<typeof writeBatchAudit>[0], runId: string, items: MembershipInput[]) {
  const run = await loadOpenRun(db, runId);
  if (run.space_withdrawn_at) throw conflict('the embedding space of this run is withdrawn');

  const embeddingIds = items.map((m) => m.embedding_id);
  const clusterNumbers = items.map((m) => m.cluster_number);
  const { rows: bad } = await db.query<{ idx: string; reason: string }>(
    `SELECT idx, reason FROM (
       SELECT n.idx,
              CASE WHEN e.id IS NULL THEN 'embedding_not_found'
                   WHEN e.embedding_space_id <> $2 THEN 'wrong_embedding_space'
                   WHEN sg.withdrawn_at IS NOT NULL OR t.withdrawn_at IS NOT NULL OR w.withdrawn_at IS NOT NULL
                     THEN 'chunk_withdrawn'
                   WHEN n.cluster_number IS NOT NULL AND cl.id IS NULL THEN 'cluster_not_found'
              END AS reason
         FROM unnest($3::uuid[], $4::int[]) WITH ORDINALITY AS n(embedding_id, cluster_number, idx)
         LEFT JOIN embedding e ON e.id = n.embedding_id
         LEFT JOIN chunk c ON c.id = e.chunk_id
         LEFT JOIN segmentation sg ON sg.id = c.segmentation_id
         LEFT JOIN text t ON t.id = c.text_id
         LEFT JOIN work w ON w.id = t.work_id
         LEFT JOIN cluster cl ON cl.clustering_run_id = $1 AND cl.cluster_number = n.cluster_number
     ) x WHERE reason IS NOT NULL`,
    [runId, run.embedding_space_id, embeddingIds, clusterNumbers],
  );
  if (bad.length) {
    throw batchValidationError(
      bad.map((r) => {
        const index = Number(r.idx) - 1;
        return {
          index,
          embedding_id: items[index]!.embedding_id,
          reason: r.reason,
          message: MEMBERSHIP_MESSAGES[r.reason] ?? r.reason,
        };
      }),
      items.length,
    );
  }

  const values = [
    runId,
    embeddingIds,
    clusterNumbers,
    items.map((m) => m.distance ?? null),
    items.map((m) => m.score ?? null),
    items.map((m) => (m.metadata === undefined ? null : JSON.stringify(m.metadata))),
  ];
  const UNNEST = `unnest($2::uuid[], $3::int[], $4::float8[], $5::float8[], $6::text[])
                  WITH ORDINALITY AS n(embedding_id, cluster_number, distance, score, metadata, idx)`;
  const inserted = await db.query<{ embedding_id: string }>(
    `INSERT INTO cluster_membership (clustering_run_id, embedding_id, cluster_id, distance, score, metadata)
     SELECT $1, n.embedding_id, cl.id, n.distance, n.score, coalesce(n.metadata::jsonb, '{}')
       FROM ${UNNEST}
       LEFT JOIN cluster cl ON cl.clustering_run_id = $1 AND cl.cluster_number = n.cluster_number
      ORDER BY n.idx
     ON CONFLICT (clustering_run_id, embedding_id) DO NOTHING
     RETURNING embedding_id`,
    values,
  );
  const insertedCount = inserted.rowCount ?? 0;
  const skippedCount = items.length - insertedCount;
  if (skippedCount > 0) {
    const { rows } = await db.query<{ idx: string; embedding_id: string }>(
      `SELECT n.idx, n.embedding_id
         FROM ${UNNEST}
         JOIN cluster_membership m ON m.clustering_run_id = $1 AND m.embedding_id = n.embedding_id
         LEFT JOIN cluster cl ON cl.id = m.cluster_id
        WHERE n.embedding_id <> ALL($7::uuid[])
          AND NOT (cl.cluster_number IS NOT DISTINCT FROM n.cluster_number
                   AND m.distance IS NOT DISTINCT FROM n.distance
                   AND m.score IS NOT DISTINCT FROM n.score
                   AND m.metadata = coalesce(n.metadata::jsonb, '{}'))`,
      [...values, inserted.rows.map((r) => r.embedding_id)],
    );
    if (rows.length) {
      throw batchConflictError(
        rows.map((r) => ({ index: Number(r.idx) - 1, embedding_id: r.embedding_id })),
        'memberships',
      );
    }
  }
  if (insertedCount > 0) {
    await writeBatchAudit(db, {
      entityType: 'cluster_membership',
      parentId: runId,
      count: insertedCount,
      changes: { parent_type: 'clustering_run', skipped: skippedCount },
    });
  }
  return { inserted: insertedCount, skipped: skippedCount };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const StatusFilter = Type.Union(
  [Type.Literal('open'), Type.Literal('complete'), Type.Literal('withdrawn'), Type.Literal('all')],
  { description: 'Default complete. Anything but complete requires contributor or higher.' },
);

export const clusteringRoutes: FastifyPluginAsyncTypebox<DerivedOptions> = async (app, opts) => {
  app.post(
    '/clustering-runs',
    {
      preHandler: requireRole('contributor'),
      schema: { body: CreateRunBody, response: { 201: RunSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const body = request.body;
      const run = await withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const { rows } = await client.query('SELECT metric, withdrawn_at FROM embedding_space WHERE id = $1 FOR SHARE', [
          body.embedding_space_id,
        ]);
        if (!rows[0]) throw unprocessable('embedding_space_id does not reference an existing embedding space');
        if (rows[0].withdrawn_at) throw conflict('embedding space is withdrawn; clustering runs cannot be added');
        const sql = insertSql('clustering_run', RUN_COLUMNS, { ...body, metric: body.metric ?? rows[0].metric });
        const inserted = await client.query(sql.text, sql.values);
        return getRun(client, inserted.rows[0].id);
      });
      return reply.status(201).send(run);
    },
  );

  app.get(
    '/clustering-runs',
    {
      preHandler: requireRole('reader'),
      schema: {
        querystring: Type.Object({
          ...PaginationQuery,
          embedding_space_id: Type.Optional(Uuid),
          status: Type.Optional(StatusFilter),
        }),
        response: { 200: Page(RunSummary), ...errorResponses },
      },
    },
    async (request) => {
      const q = request.query;
      const status = q.status ?? 'complete';
      if (status !== 'complete' && !hasRole(principalOf(request), 'contributor')) {
        throw forbidden('listing runs that are not complete requires role contributor or higher');
      }
      const p = new SqlParams();
      const where: string[] = [];
      if (status !== 'all') where.push(`r.status = ${p.add(status)}`);
      if (q.embedding_space_id !== undefined) where.push(`r.embedding_space_id = ${p.add(q.embedding_space_id)}`);
      const page = keyset(p, q, 'r.id');
      where.push(...page.where);
      const { rows } = await app.pg.query(
        `SELECT ${RUN_FIELDS_SQL} FROM clustering_run r WHERE ${where.join(' AND ') || 'true'} ORDER BY r.id ${page.limitSql}`,
        p.values,
      );
      return toPage(rows, page.limit);
    },
  );

  app.get(
    '/clustering-runs/:id',
    {
      preHandler: requireRole('reader'),
      schema: { params: IdParams, response: { 200: RunSchema, ...errorResponses } },
    },
    async (request) => {
      const run = await getRun(app.pg, request.params.id);
      assertCanReadRun(principalOf(request), run.status);
      return run;
    },
  );

  app.get(
    '/clustering-runs/:id/clusters',
    {
      preHandler: requireRole('reader'),
      schema: {
        params: IdParams,
        querystring: Type.Object(PaginationQuery),
        response: { 200: Page(ClusterSummary), ...errorResponses },
      },
    },
    async (request) => {
      const { rows: runs } = await app.pg.query('SELECT status FROM clustering_run WHERE id = $1', [request.params.id]);
      if (!runs[0]) throw notFound('clustering run not found');
      assertCanReadRun(principalOf(request), runs[0].status);
      const p = new SqlParams();
      const where = [`cl.clustering_run_id = ${p.add(request.params.id)}`];
      const page = keyset(p, request.query, 'cl.cluster_number', { valid: (k) => /^-?\d{1,10}$/.test(k), cast: 'int' });
      where.push(...page.where);
      const { rows } = await app.pg.query(
        `SELECT ${CLUSTER_FIELDS_SQL} FROM cluster cl WHERE ${where.join(' AND ')} ORDER BY cl.cluster_number ${page.limitSql}`,
        p.values,
      );
      return toPage(rows, page.limit, (r) => r.cluster_number as number);
    },
  );

  app.post(
    '/clustering-runs/:id/clusters',
    {
      preHandler: requireRole('contributor'),
      schema: {
        params: IdParams,
        body: Type.Array(ClusterInput, { minItems: 1, maxItems: opts.maxBatchItems }),
        response: { 200: BatchResult, ...errorResponses },
      },
    },
    async (request) => {
      const items = request.body;
      const errors = [
        ...duplicateErrors(items, (c) => c.cluster_number, 'cluster_number'),
        ...duplicateErrors(items, (c) => c.id?.toLowerCase(), 'id'),
      ];
      if (errors.length) throw batchValidationError(errors, items.length);
      return withTransaction(app.pg, principalOf(request), request.id, (client) =>
        insertClusters(client, request.params.id, items),
      );
    },
  );

  app.post(
    '/clustering-runs/:id/memberships',
    {
      preHandler: requireRole('contributor'),
      schema: {
        params: IdParams,
        body: Type.Array(MembershipInput, { minItems: 1, maxItems: opts.maxBatchItems }),
        response: { 200: BatchResult, ...errorResponses },
      },
    },
    async (request) => {
      const items = request.body;
      const errors = duplicateErrors(items, (m) => m.embedding_id.toLowerCase(), 'embedding_id');
      if (errors.length) throw batchValidationError(errors, items.length);
      return withTransaction(app.pg, principalOf(request), request.id, (client) =>
        insertMemberships(client, request.params.id, items),
      );
    },
  );

  app.post(
    '/clustering-runs/:id/complete',
    {
      preHandler: requireRole('contributor'),
      schema: { params: IdParams, response: { 200: RunSchema, ...errorResponses } },
    },
    async (request) => {
      const id = request.params.id;
      return withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const { rows } = await client.query('SELECT status FROM clustering_run WHERE id = $1 FOR UPDATE', [id]);
        if (!rows[0]) throw notFound('clustering run not found');
        if (rows[0].status !== 'open') throw conflict(`clustering run is ${rows[0].status}; only open runs can be completed`);
        const members = await client.query('SELECT 1 FROM cluster_membership WHERE clustering_run_id = $1 LIMIT 1', [id]);
        if (!members.rowCount) throw conflict('clustering run has no memberships; post the full input set before completing it');
        const { rows: mismatches } = await client.query(
          `SELECT cluster_number, size, member_count FROM cluster_subtree_counts($1)
            WHERE size IS NOT NULL AND size <> member_count ORDER BY cluster_number LIMIT 1000`,
          [id],
        );
        if (mismatches.length) {
          throw conflict(
            `${mismatches.length} clusters have a size that differs from their membership count (including descendants)`,
            { mismatches },
          );
        }
        // The database fills NULL sizes and re-checks everything (clustering_run_transition_check in the migration).
        await client.query(`UPDATE clustering_run SET status = 'complete' WHERE id = $1`, [id]);
        return getRun(client, id);
      });
    },
  );

  app.post(
    '/clustering-runs/:id/withdraw',
    {
      preHandler: requireRole('curator'),
      schema: { params: IdParams, body: WithdrawBody, response: { 200: RunSchema, ...errorResponses } },
    },
    async (request) => {
      const id = request.params.id;
      return withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const { rows } = await client.query('SELECT status FROM clustering_run WHERE id = $1 FOR UPDATE', [id]);
        if (!rows[0]) throw notFound('clustering run not found');
        if (rows[0].status === 'withdrawn') throw conflict('clustering run is already withdrawn');
        await client.query(`UPDATE clustering_run SET status = 'withdrawn', withdrawn_reason = $2 WHERE id = $1`, [
          id,
          request.body.reason,
        ]);
        return getRun(client, id);
      });
    },
  );
};
