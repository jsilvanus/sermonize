import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { notFound } from '../../lib/errors.js';
import { hasRole } from '../../lib/principal.js';
import { principalOf, requireRole } from '../../plugins/auth.js';
import { PersonSchema } from '../scholarly/persons.js';
import { getSource, SourceSchema } from '../scholarly/sources.js';
import { EFFECTIVE_ACCESS_SQL, getText, TextSchema } from '../scholarly/texts.js';
import { getWork, WorkSchema } from '../scholarly/works.js';
import { DateTime, errorResponses, IdParams, Nullable, Uuid } from '../schemas.js';
import { CLUSTER_FIELDS_SQL, ClusterSummary, RUN_COUNTS_SQL, RUN_FIELDS_SQL, RunStatusSchema, RunSummary } from './clustering.js';
import { LABEL_FIELDS_SQL, LabelSchema, ReviewSchema, reviewsOf } from './clusters.js';
import { assertCanReadRun } from './common.js';
import { SPACE_FIELDS_SQL, SpaceSummary } from './embeddings.js';
import { CHUNK_FIELDS_SQL, ChunkSchema, getSegmentation, SegmentationSchema } from './segmentations.js';

const AccessLevelOut = Type.Union([Type.Literal('public'), Type.Literal('restricted')]);

const ChunkProvenanceSchema = Type.Object({
  chunk: Type.Object({
    ...ChunkSchema.properties,
    text: Nullable(Type.String({ description: 'null when the chunk is restricted and the caller is a reader.' })),
    effective_access_level: AccessLevelOut,
  }),
  segmentation: SegmentationSchema,
  text: TextSchema,
  source: Nullable(SourceSchema),
  work: WorkSchema,
  persons: Type.Array(PersonSchema, { description: 'Every person linked to the work (work_person) or the text (text_person).' }),
  embeddings: Type.Array(
    Type.Object({ id: Uuid, created_by: Uuid, created_at: DateTime, embedding_space: SpaceSummary }),
  ),
  cluster_memberships: Type.Array(
    Type.Object({
      clustering_run_id: Uuid,
      run_status: RunStatusSchema,
      algorithm: Type.String(),
      embedding_id: Uuid,
      cluster_id: Nullable(Uuid),
      cluster_number: Nullable(Type.Integer()),
      distance: Nullable(Type.Number()),
      score: Nullable(Type.Number()),
    }),
    { description: "Memberships of the chunk's embeddings in runs the caller may read (readers: complete runs)." },
  ),
});

const LabelWithReviews = Type.Object({ ...LabelSchema.properties, reviews: Type.Array(ReviewSchema) });

const ClusterProvenanceSchema = Type.Object({
  cluster: ClusterSummary,
  run: RunSummary,
  embedding_space: SpaceSummary,
  input: Type.Object({
    size: Type.Integer({ description: 'Memberships of the run (its full input set).' }),
    noise_count: Type.Integer(),
    cluster_count: Type.Integer(),
  }),
  labels: Type.Array(LabelWithReviews, { description: 'All labels of the cluster (with derived status) and their reviews.' }),
});

export const provenanceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/chunks/:id/provenance',
    {
      preHandler: requireRole('reader'),
      schema: { params: IdParams, response: { 200: ChunkProvenanceSchema, ...errorResponses } },
    },
    async (request) => {
      const principal = principalOf(request);
      const db = app.pg;
      const { rows } = await db.query(
        `SELECT ${CHUNK_FIELDS_SQL}, ${EFFECTIVE_ACCESS_SQL} AS effective_access_level, t.work_id, t.source_id
           FROM chunk c JOIN text t ON t.id = c.text_id LEFT JOIN source s ON s.id = t.source_id
          WHERE c.id = $1`,
        [request.params.id],
      );
      const row = rows[0];
      if (!row) throw notFound('chunk not found');
      const { work_id: workId, source_id: sourceId, ...chunk } = row;
      // Metadata of restricted records is readable by everyone; the chunk text is not.
      if (chunk.effective_access_level === 'restricted' && !hasRole(principal, 'contributor')) chunk.text = null;

      const [segmentation, text, source, work] = await Promise.all([
        getSegmentation(db, chunk.segmentation_id),
        getText(db, chunk.text_id),
        sourceId ? getSource(db, sourceId) : Promise.resolve(null),
        getWork(db, workId),
      ]);
      const [persons, embeddings, memberships] = await Promise.all([
        db.query(
          `SELECT * FROM person p
            WHERE p.id IN (SELECT person_id FROM work_person WHERE work_id = $1
                           UNION SELECT person_id FROM text_person WHERE text_id = $2)
            ORDER BY p.display_name, p.id`,
          [workId, chunk.text_id],
        ),
        db.query(
          `SELECT e.id, e.created_by, e.created_at, row_to_json(x) AS embedding_space
             FROM embedding e
             JOIN LATERAL (SELECT ${SPACE_FIELDS_SQL} FROM embedding_space es WHERE es.id = e.embedding_space_id) x ON true
            WHERE e.chunk_id = $1
            ORDER BY x.name, e.id`,
          [chunk.id],
        ),
        db.query(
          `SELECT m.clustering_run_id, r.status AS run_status, r.algorithm, m.embedding_id, m.cluster_id,
                  cl.cluster_number, m.distance, m.score
             FROM embedding e
             JOIN cluster_membership m ON m.embedding_id = e.id
             JOIN clustering_run r ON r.id = m.clustering_run_id
             LEFT JOIN cluster cl ON cl.id = m.cluster_id
            WHERE e.chunk_id = $1 AND ($2 OR r.status = 'complete')
            ORDER BY m.clustering_run_id, m.embedding_id`,
          [chunk.id, hasRole(principal, 'contributor')],
        ),
      ]);
      return {
        chunk,
        segmentation,
        text,
        source,
        work,
        persons: persons.rows,
        embeddings: embeddings.rows,
        cluster_memberships: memberships.rows,
      };
    },
  );

  app.get(
    '/clusters/:id/provenance',
    {
      preHandler: requireRole('reader'),
      schema: { params: IdParams, response: { 200: ClusterProvenanceSchema, ...errorResponses } },
    },
    async (request) => {
      const db = app.pg;
      const { rows } = await db.query(
        `SELECT ${CLUSTER_FIELDS_SQL} FROM cluster cl WHERE cl.id = $1`,
        [request.params.id],
      );
      const cluster = rows[0];
      if (!cluster) throw notFound('cluster not found');
      const { rows: runs } = await db.query(
        `SELECT ${RUN_FIELDS_SQL}, ${RUN_COUNTS_SQL} FROM clustering_run r WHERE r.id = $1`,
        [cluster.clustering_run_id],
      );
      const { cluster_count, input_size, noise_count, ...run } = runs[0];
      assertCanReadRun(principalOf(request), run.status);
      const [space, labels] = await Promise.all([
        db.query(`SELECT ${SPACE_FIELDS_SQL} FROM embedding_space es WHERE es.id = $1`, [run.embedding_space_id]),
        db.query(`SELECT ${LABEL_FIELDS_SQL} FROM label l WHERE l.cluster_id = $1 ORDER BY l.created_at, l.id`, [cluster.id]),
      ]);
      const reviews = await reviewsOf(db, labels.rows.map((l) => l.id));
      return {
        cluster,
        run,
        embedding_space: space.rows[0],
        input: { size: input_size, noise_count, cluster_count },
        labels: labels.rows.map((l) => ({ ...l, reviews: reviews.filter((r) => r.label_id === l.id) })),
      };
    },
  );
};
