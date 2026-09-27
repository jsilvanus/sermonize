import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { withTransaction } from '../../db/transaction.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { keyset, Page, PaginationQuery, toPage } from '../../lib/pagination.js';
import { hasRole } from '../../lib/principal.js';
import { insertSql, SqlParams, type Db } from '../../lib/sql.js';
import { parseVector } from '../../lib/vector.js';
import { principalOf, requireRole } from '../../plugins/auth.js';
import { EFFECTIVE_ACCESS_SQL } from '../scholarly/texts.js';
import { DateTime, errorResponses, IdParams, JsonObject, LanguageTag, Nullable, Uuid } from '../schemas.js';
import { CLUSTER_FIELDS_SQL, clusterColumns, RunStatusSchema } from './clustering.js';
import { assertCanReadRun, Producer, type RunStatus } from './common.js';

// ---------------------------------------------------------------------------
// Labels and reviews
// ---------------------------------------------------------------------------

export const LabelStatus = Type.Union(
  [Type.Literal('proposed'), Type.Literal('accepted'), Type.Literal('rejected'), Type.Literal('needs_revision')],
  { description: "Decision of the latest review (by created_at, id); 'proposed' if never reviewed." },
);
const Decision = Type.Union([Type.Literal('accepted'), Type.Literal('rejected'), Type.Literal('needs_revision')]);
const ProducerKind = Type.Union([Type.Literal('model'), Type.Literal('human')]);

const LABEL_COLUMNS = [
  'id',
  'cluster_id',
  'language',
  'label',
  'description',
  'producer_kind',
  'model',
  'model_version',
  'producer',
  'supersedes_label_id',
  'metadata',
] as const;

const CreateLabelBody = Type.Object({
  id: Type.Optional(Uuid),
  language: LanguageTag,
  label: Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }),
  description: Type.Optional(Nullable(Type.String({ maxLength: 20000 }))),
  producer_kind: ProducerKind,
  model: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 500, description: "Required when producer_kind is 'model'." }))),
  model_version: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 500 }))),
  producer: Type.Optional(Nullable(Producer)),
  supersedes_label_id: Type.Optional(Nullable(Uuid)),
  metadata: Type.Optional(JsonObject),
});

export const ReviewSchema = Type.Object({
  id: Uuid,
  label_id: Uuid,
  reviewer_id: Uuid,
  decision: Decision,
  note: Nullable(Type.String()),
  created_at: DateTime,
});
const REVIEW_FIELDS_SQL = 'lr.id, lr.label_id, lr.reviewer_id, lr.decision, lr.note, lr.created_at';

const labelColumns = {
  id: Uuid,
  cluster_id: Uuid,
  language: Type.String(),
  label: Type.String(),
  description: Nullable(Type.String()),
  producer_kind: ProducerKind,
  model: Nullable(Type.String()),
  model_version: Nullable(Type.String()),
  producer: Nullable(JsonObject),
  supersedes_label_id: Nullable(Uuid),
  metadata: JsonObject,
  created_by: Uuid,
  created_at: DateTime,
  status: LabelStatus,
  superseded: Type.Boolean({ description: 'True if another label supersedes this one.' }),
  superseded_by: Type.Array(Uuid),
  review_count: Type.Integer(),
};
export const LabelSchema = Type.Object(labelColumns);
const LabelDetailSchema = Type.Object({ ...labelColumns, reviews: Type.Array(ReviewSchema) });

/** Label columns plus derived status for SELECT from `label l`. */
export const LABEL_FIELDS_SQL = `l.id, l.cluster_id, l.language::text AS language, l.label, l.description, l.producer_kind,
  l.model, l.model_version, l.producer, l.supersedes_label_id, l.metadata, l.created_by, l.created_at,
  coalesce((SELECT lr.decision FROM label_review lr WHERE lr.label_id = l.id
             ORDER BY lr.created_at DESC, lr.id DESC LIMIT 1), 'proposed') AS status,
  EXISTS (SELECT 1 FROM label s WHERE s.supersedes_label_id = l.id) AS superseded,
  ARRAY(SELECT s.id FROM label s WHERE s.supersedes_label_id = l.id ORDER BY s.created_at, s.id) AS superseded_by,
  (SELECT count(*)::int FROM label_review lr WHERE lr.label_id = l.id) AS review_count`;

/** Reviews of the given labels, ordered by (created_at, id). */
export async function reviewsOf(db: Db, labelIds: string[]) {
  const { rows } = await db.query(
    `SELECT ${REVIEW_FIELDS_SQL} FROM label_review lr WHERE lr.label_id = ANY($1::uuid[]) ORDER BY lr.created_at, lr.id`,
    [labelIds],
  );
  return rows;
}

async function getLabel(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT ${LABEL_FIELDS_SQL}, r.status AS run_status
       FROM label l JOIN cluster cl ON cl.id = l.cluster_id JOIN clustering_run r ON r.id = cl.clustering_run_id
      WHERE l.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('label not found');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Clusters and members
// ---------------------------------------------------------------------------

const ClusterSchema = Type.Object({
  ...clusterColumns,
  run_status: RunStatusSchema,
  embedding_space_id: Uuid,
  label_count: Type.Integer(),
  centroid: Type.Optional(Nullable(Type.Array(Type.Number()))),
});

/** The cluster's run status (for access checks); 404 if the cluster does not exist. */
async function clusterRunStatus(db: Db, clusterId: string): Promise<RunStatus> {
  const { rows } = await db.query(
    'SELECT r.status FROM cluster cl JOIN clustering_run r ON r.id = cl.clustering_run_id WHERE cl.id = $1',
    [clusterId],
  );
  if (!rows[0]) throw notFound('cluster not found');
  return rows[0].status;
}

const MemberSchema = Type.Object({
  embedding_id: Uuid,
  distance: Nullable(Type.Number()),
  score: Nullable(Type.Number()),
  metadata: JsonObject,
  chunk: Type.Object({
    id: Uuid,
    segmentation_id: Uuid,
    sequence: Type.Integer(),
    start_offset: Type.Integer(),
    end_offset: Type.Integer(),
    locus: Nullable(Type.String()),
    language: Type.String({ description: 'Effective language (chunk override, else text language).' }),
    content_sha256: Type.String(),
    text: Nullable(Type.String({ description: 'null when the chunk is restricted and the caller is a reader.' })),
    restricted: Type.Boolean({ description: 'The effective access level of the text is restricted.' }),
    withdrawn: Type.Boolean({ description: 'The segmentation, text or work was withdrawn after the run.' }),
  }),
  text: Type.Object({ id: Uuid, language: Type.String(), relation: Type.String(), title: Nullable(Type.String()) }),
  work: Type.Object({ id: Uuid, title: Type.String(), genre: Type.String() }),
});

export const clusterRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/clusters/:id',
    {
      preHandler: requireRole('reader'),
      schema: {
        params: IdParams,
        querystring: Type.Object({
          include_centroid: Type.Optional(Type.Boolean({ description: 'Return the centroid vector (contributor or higher).' })),
        }),
        response: { 200: ClusterSchema, ...errorResponses },
      },
    },
    async (request) => {
      const principal = principalOf(request);
      const withCentroid = request.query.include_centroid === true;
      if (withCentroid && !hasRole(principal, 'contributor')) {
        throw forbidden('centroids require role contributor or higher');
      }
      const { rows } = await app.pg.query(
        `SELECT ${CLUSTER_FIELDS_SQL}, r.status AS run_status, r.embedding_space_id,
                (SELECT count(*)::int FROM label l WHERE l.cluster_id = cl.id) AS label_count
                ${withCentroid ? ', cl.centroid::text AS centroid' : ''}
           FROM cluster cl JOIN clustering_run r ON r.id = cl.clustering_run_id
          WHERE cl.id = $1`,
        [request.params.id],
      );
      const cluster = rows[0];
      if (!cluster) throw notFound('cluster not found');
      assertCanReadRun(principal, cluster.run_status);
      if (withCentroid) cluster.centroid = cluster.centroid === null ? null : parseVector(cluster.centroid);
      return cluster;
    },
  );

  app.get(
    '/clusters/:id/members',
    {
      preHandler: requireRole('reader'),
      schema: {
        params: IdParams,
        querystring: Type.Object(PaginationQuery),
        response: { 200: Page(MemberSchema), ...errorResponses },
      },
    },
    async (request) => {
      const principal = principalOf(request);
      assertCanReadRun(principal, await clusterRunStatus(app.pg, request.params.id));
      const canReadRestricted = hasRole(principal, 'contributor');
      const p = new SqlParams();
      const where = [`m.cluster_id = ${p.add(request.params.id)}`];
      const page = keyset(p, request.query, 'm.embedding_id');
      where.push(...page.where);
      const { rows } = await app.pg.query(
        `SELECT m.embedding_id, m.distance, m.score, m.metadata,
                c.id AS chunk_id, c.segmentation_id, c.sequence, c.start_offset, c.end_offset, c.locus,
                coalesce(c.language, t.language)::text AS chunk_language, c.content_sha256, c.text AS chunk_text,
                ${EFFECTIVE_ACCESS_SQL} = 'restricted' AS restricted,
                (sg.withdrawn_at IS NOT NULL OR t.withdrawn_at IS NOT NULL OR w.withdrawn_at IS NOT NULL) AS withdrawn,
                t.id AS text_id, t.language::text AS text_language, t.relation, t.title AS text_title,
                w.id AS work_id, w.title AS work_title, w.genre
           FROM cluster_membership m
           JOIN embedding e ON e.id = m.embedding_id
           JOIN chunk c ON c.id = e.chunk_id
           JOIN segmentation sg ON sg.id = c.segmentation_id
           JOIN text t ON t.id = c.text_id
           LEFT JOIN source s ON s.id = t.source_id
           JOIN work w ON w.id = t.work_id
          WHERE ${where.join(' AND ')}
          ORDER BY m.embedding_id ${page.limitSql}`,
        p.values,
      );
      const items = rows.map((r) => ({
        embedding_id: r.embedding_id,
        distance: r.distance,
        score: r.score,
        metadata: r.metadata,
        chunk: {
          id: r.chunk_id,
          segmentation_id: r.segmentation_id,
          sequence: r.sequence,
          start_offset: r.start_offset,
          end_offset: r.end_offset,
          locus: r.locus,
          language: r.chunk_language,
          content_sha256: r.content_sha256,
          text: r.restricted && !canReadRestricted ? null : r.chunk_text,
          restricted: r.restricted,
          withdrawn: r.withdrawn,
        },
        text: { id: r.text_id, language: r.text_language, relation: r.relation, title: r.text_title },
        work: { id: r.work_id, title: r.work_title, genre: r.genre },
      }));
      return toPage(items, page.limit, (r) => r.embedding_id);
    },
  );

  app.post(
    '/clusters/:id/labels',
    {
      preHandler: requireRole('contributor'),
      schema: { params: IdParams, body: CreateLabelBody, response: { 201: LabelSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const body = request.body;
      const clusterId = request.params.id;
      if (body.producer_kind === 'model' && (body.model == null || body.producer == null)) {
        throw unprocessable("labels with producer_kind 'model' require model and producer");
      }
      if (body.producer_kind === 'human' && (body.model != null || body.model_version != null)) {
        throw unprocessable("model and model_version are only allowed when producer_kind is 'model'");
      }
      const label = await withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const { rows } = await client.query(
          `SELECT r.status FROM cluster cl JOIN clustering_run r ON r.id = cl.clustering_run_id
            WHERE cl.id = $1 FOR SHARE OF r`,
          [clusterId],
        );
        if (!rows[0]) throw notFound('cluster not found');
        if (rows[0].status !== 'complete') {
          throw conflict(`clustering run is ${rows[0].status}; labels can only be added to clusters of complete runs`);
        }
        if (body.supersedes_label_id != null) {
          const sup = await client.query('SELECT cluster_id FROM label WHERE id = $1', [body.supersedes_label_id]);
          if (!sup.rows[0] || sup.rows[0].cluster_id !== clusterId) {
            throw unprocessable('supersedes_label_id must reference a label of the same cluster');
          }
        }
        const sql = insertSql('label', LABEL_COLUMNS, { ...body, cluster_id: clusterId });
        const inserted = await client.query(sql.text, sql.values);
        return getLabel(client, inserted.rows[0].id);
      });
      return reply.status(201).send(label);
    },
  );

  app.get(
    '/clusters/:id/labels',
    {
      preHandler: requireRole('reader'),
      schema: {
        params: IdParams,
        querystring: Type.Object({ ...PaginationQuery, language: Type.Optional(LanguageTag) }),
        response: { 200: Page(LabelSchema), ...errorResponses },
      },
    },
    async (request) => {
      assertCanReadRun(principalOf(request), await clusterRunStatus(app.pg, request.params.id));
      const p = new SqlParams();
      const where = [`l.cluster_id = ${p.add(request.params.id)}`];
      if (request.query.language !== undefined) where.push(`l.language::text = ${p.add(request.query.language)}`);
      const page = keyset(p, request.query, 'l.id');
      where.push(...page.where);
      const { rows } = await app.pg.query(
        `SELECT ${LABEL_FIELDS_SQL} FROM label l WHERE ${where.join(' AND ')} ORDER BY l.id ${page.limitSql}`,
        p.values,
      );
      return toPage(rows, page.limit);
    },
  );

  app.get(
    '/labels/:id',
    {
      preHandler: requireRole('reader'),
      schema: { params: IdParams, response: { 200: LabelDetailSchema, ...errorResponses } },
    },
    async (request) => {
      const label = await getLabel(app.pg, request.params.id);
      assertCanReadRun(principalOf(request), label.run_status);
      return { ...label, reviews: await reviewsOf(app.pg, [label.id]) };
    },
  );

  app.post(
    '/labels/:id/reviews',
    {
      preHandler: requireRole('curator'),
      schema: {
        params: IdParams,
        body: Type.Object({ decision: Decision, note: Type.Optional(Nullable(Type.String({ maxLength: 20000 }))) }),
        response: { 201: ReviewSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const review = await withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const { rows } = await client.query(
          `SELECT r.status FROM label l JOIN cluster cl ON cl.id = l.cluster_id
             JOIN clustering_run r ON r.id = cl.clustering_run_id WHERE l.id = $1 FOR SHARE OF r`,
          [request.params.id],
        );
        if (!rows[0]) throw notFound('label not found');
        if (rows[0].status === 'withdrawn') throw conflict('clustering run is withdrawn; its labels cannot be reviewed');
        // reviewer_id and created_by are set to the caller by the database.
        const { rows: inserted } = await client.query(
          `INSERT INTO label_review AS lr (label_id, decision, note) VALUES ($1, $2, $3) RETURNING ${REVIEW_FIELDS_SQL}`,
          [request.params.id, request.body.decision, request.body.note ?? null],
        );
        return inserted[0];
      });
      return reply.status(201).send(review);
    },
  );
};
