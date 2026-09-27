import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

const Count = Type.Integer({ minimum: 0 });

const StatsSchema = Type.Object({
  persons: Count,
  works: Count,
  works_by_genre: Type.Record(Type.String(), Count),
  sermons: Count,
  texts: Count,
  texts_by_language: Type.Record(Type.String(), Count),
  sources: Count,
  segmentations: Count,
  chunks: Count,
  embedding_spaces: Count,
  embeddings: Count,
  complete_clustering_runs: Count,
  clusters: Count,
  labels: Count,
});

/**
 * GET /stats (public): aggregate corpus counts. No PII and no per-record data.
 *
 * Withdrawn records are excluded: persons, works, texts, sources, segmentations and
 * embedding spaces by their own withdrawn_at; chunks of withdrawn segmentations;
 * embeddings of withdrawn spaces. Clusters and labels are counted for complete
 * runs only (what readers can see). Restricted texts are counted too (the counts
 * reveal nothing of their content).
 *
 * Exact count(*) for now; very large tables (chunk, embedding) may later need
 * estimates (pg_class.reltuples) or a cache.
 */
export const statsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/stats',
    { config: { public: true }, schema: { response: { 200: StatsSchema } } },
    async () => {
      const [totals, genres, languages] = await Promise.all([
        app.pg.query<Record<string, string>>(`
          SELECT
            (SELECT count(*) FROM person WHERE withdrawn_at IS NULL) AS persons,
            (SELECT count(*) FROM work WHERE withdrawn_at IS NULL) AS works,
            (SELECT count(*) FROM text WHERE withdrawn_at IS NULL) AS texts,
            (SELECT count(*) FROM source WHERE withdrawn_at IS NULL) AS sources,
            (SELECT count(*) FROM segmentation WHERE withdrawn_at IS NULL) AS segmentations,
            (SELECT count(*) FROM chunk c JOIN segmentation s ON s.id = c.segmentation_id
              WHERE s.withdrawn_at IS NULL) AS chunks,
            (SELECT count(*) FROM embedding_space WHERE withdrawn_at IS NULL) AS embedding_spaces,
            (SELECT count(*) FROM embedding e JOIN embedding_space s ON s.id = e.embedding_space_id
              WHERE s.withdrawn_at IS NULL) AS embeddings,
            (SELECT count(*) FROM clustering_run WHERE status = 'complete') AS complete_clustering_runs,
            (SELECT count(*) FROM cluster c JOIN clustering_run r ON r.id = c.clustering_run_id
              WHERE r.status = 'complete') AS clusters,
            (SELECT count(*) FROM label l JOIN cluster c ON c.id = l.cluster_id
               JOIN clustering_run r ON r.id = c.clustering_run_id
              WHERE r.status = 'complete') AS labels`),
        app.pg.query<{ key: string; n: string }>(
          'SELECT genre AS key, count(*) AS n FROM work WHERE withdrawn_at IS NULL GROUP BY genre ORDER BY genre',
        ),
        app.pg.query<{ key: string; n: string }>(
          'SELECT language AS key, count(*) AS n FROM text WHERE withdrawn_at IS NULL GROUP BY language ORDER BY language',
        ),
      ]);
      const t = totals.rows[0]!;
      const n = (key: string) => Number(t[key]);
      const byKey = (rows: { key: string; n: string }[]) => Object.fromEntries(rows.map((r) => [r.key, Number(r.n)]));
      const worksByGenre = byKey(genres.rows);
      return {
        persons: n('persons'),
        works: n('works'),
        works_by_genre: worksByGenre,
        sermons: worksByGenre.sermon ?? 0,
        texts: n('texts'),
        texts_by_language: byKey(languages.rows),
        sources: n('sources'),
        segmentations: n('segmentations'),
        chunks: n('chunks'),
        embedding_spaces: n('embedding_spaces'),
        embeddings: n('embeddings'),
        complete_clustering_runs: n('complete_clustering_runs'),
        clusters: n('clusters'),
        labels: n('labels'),
      };
    },
  );
};
