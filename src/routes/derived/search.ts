import { Type, type FastifyPluginAsyncTypebox, type Static } from '@fastify/type-provider-typebox';
import { withTransaction } from '../../db/transaction.js';
import { conflict, forbidden, unprocessable } from '../../lib/errors.js';
import { hasRole } from '../../lib/principal.js';
import { SqlParams, type Db } from '../../lib/sql.js';
import { castType, DISTANCE_OPERATOR, toVectorLiteral, vectorProblem, type Metric } from '../../lib/vector.js';
import { principalOf, requireRole } from '../../plugins/auth.js';
import { Genre } from '../scholarly/works.js';
import { EFFECTIVE_ACCESS_SQL } from '../scholarly/texts.js';
import { errorResponses, LanguageTag, Nullable, Uuid, Year } from '../schemas.js';
import { loadSpace, MetricSchema, type SpaceRow } from './embeddings.js';

export const MAX_SEARCH_LIMIT = 200;
export const DEFAULT_SEARCH_LIMIT = 10;

const Relation = Type.Union([Type.Literal('original'), Type.Literal('translation'), Type.Literal('adaptation')]);

const SearchFilters = Type.Object({
  /** Effective chunk language: the chunk's language override, else the text language. */
  language: Type.Optional(LanguageTag),
  work_id: Type.Optional(Uuid),
  /** Works linked to this person through work_person (any role). */
  person_id: Type.Optional(Uuid),
  year_from: Type.Optional(Year),
  year_to: Type.Optional(Year),
  date_basis: Type.Optional(
    Type.Union([Type.Literal('text'), Type.Literal('work')], {
      description:
        "Which date the year filters use: 'text' (default; the date of this text/edition/translation/preaching) " +
        "or 'work' (the work's date). Ranges overlap-match; undated records are excluded.",
    }),
  ),
  relation: Type.Optional(Relation),
  genre: Type.Optional(Genre),
  include_restricted: Type.Optional(
    Type.Boolean({ description: 'Include chunks of restricted texts (requires contributor or higher).' }),
  ),
});
export type SearchFilters = Static<typeof SearchFilters>;

const SearchBody = Type.Object({
  embedding_space_id: Uuid,
  vector: Type.Array(Type.Number(), { minItems: 1, maxItems: 16000 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT, default: DEFAULT_SEARCH_LIMIT })),
  filters: Type.Optional(SearchFilters),
});

const NullableString = Nullable(Type.String());
const NullableInt = Nullable(Type.Integer());
const SearchHit = Type.Object({
  embedding_id: Uuid,
  distance: Type.Number({
    description: 'Value of the metric operator: cosine distance (<=>), NEGATIVE inner product (<#>) or L2 distance (<->). Lower is closer.',
  }),
  similarity: Nullable(
    Type.Number({ description: 'cosine: 1 - distance; inner_product: the inner product (-distance); l2: null.' }),
  ),
  chunk: Type.Object({
    id: Uuid,
    segmentation_id: Uuid,
    sequence: Type.Integer(),
    start_offset: Type.Integer(),
    end_offset: Type.Integer(),
    text: Type.String(),
    locus: NullableString,
    language: Type.String({ description: 'Effective language (chunk override, else text language).' }),
  }),
  text: Type.Object({
    id: Uuid,
    language: Type.String(),
    relation: Relation,
    title: NullableString,
    year_from: NullableInt,
    year_to: NullableInt,
    effective_access_level: Type.Union([Type.Literal('public'), Type.Literal('restricted')]),
  }),
  work: Type.Object({
    id: Uuid,
    title: Type.String(),
    genre: Genre,
    year_from: NullableInt,
    year_to: NullableInt,
  }),
  authors: Type.Array(
    Type.Object({ person_id: Uuid, display_name: Type.String(), role: Type.String(), certainty: Type.String() }),
  ),
});
const SearchResponse = Type.Object({
  embedding_space_id: Uuid,
  metric: MetricSchema,
  items: Type.Array(SearchHit),
});

export interface SearchInput {
  space: Pick<SpaceRow, 'id' | 'dimensions' | 'metric'>;
  vector: readonly number[];
  limit: number;
  filters?: SearchFilters;
  includeRestricted: boolean;
}

/**
 * Builds the nearest-neighbour query. The ORDER BY expression is
 * `(e.vector::<type>(N)) <op> $query` and the space id is inlined as a
 * literal (`e.embedding_space_id = '<uuid>'`), so the planner can match the
 * space's partial HNSW expression index (see src/lib/vector-index.ts). The
 * inner CTE may come back slightly out of order under
 * `hnsw.iterative_scan = relaxed_order`; the outer query re-sorts.
 */
export function buildSearchSql(input: SearchInput): { text: string; values: unknown[] } {
  const { space, filters = {} } = input;
  if (!/^[0-9a-f-]{36}$/i.test(space.id)) throw new Error(`invalid space id ${space.id}`);
  const cast = castType(space.dimensions);
  const op = DISTANCE_OPERATOR[space.metric];
  const p = new SqlParams();
  const query = p.add(toVectorLiteral(input.vector));
  const where = [
    `e.embedding_space_id = '${space.id.toLowerCase()}'`,
    'sg.withdrawn_at IS NULL',
    't.withdrawn_at IS NULL',
    'w.withdrawn_at IS NULL',
  ];
  if (!input.includeRestricted) {
    where.push(`t.access_level = 'public'`, `(s.access_level IS NULL OR s.access_level = 'public')`);
  }
  if (filters.language !== undefined) where.push(`coalesce(c.language, t.language)::text = ${p.add(filters.language)}`);
  if (filters.work_id !== undefined) where.push(`t.work_id = ${p.add(filters.work_id)}`);
  if (filters.person_id !== undefined) {
    where.push(`EXISTS (SELECT 1 FROM work_person wp WHERE wp.work_id = t.work_id AND wp.person_id = ${p.add(filters.person_id)})`);
  }
  const dated = filters.date_basis === 'work' ? 'w' : 't';
  if (filters.year_from !== undefined) where.push(`coalesce(${dated}.year_to, ${dated}.year_from) >= ${p.add(filters.year_from)}`);
  if (filters.year_to !== undefined) where.push(`coalesce(${dated}.year_from, ${dated}.year_to) <= ${p.add(filters.year_to)}`);
  if (filters.relation !== undefined) where.push(`t.relation = ${p.add(filters.relation)}`);
  if (filters.genre !== undefined) where.push(`w.genre = ${p.add(filters.genre)}`);
  const limit = p.add(input.limit);

  const text = `
    WITH hits AS MATERIALIZED (
      SELECT e.id AS embedding_id, e.chunk_id, (e.vector::${cast}) ${op} ${query}::${cast} AS distance
        FROM embedding e
        JOIN chunk c ON c.id = e.chunk_id
        JOIN segmentation sg ON sg.id = c.segmentation_id
        JOIN text t ON t.id = c.text_id
        LEFT JOIN source s ON s.id = t.source_id
        JOIN work w ON w.id = t.work_id
       WHERE ${where.join('\n         AND ')}
       ORDER BY distance
       LIMIT ${limit}
    )
    SELECT h.embedding_id, h.distance,
           c.id AS chunk_id, c.segmentation_id, c.sequence, c.start_offset, c.end_offset, c.text AS chunk_text,
           c.locus, coalesce(c.language, t.language)::text AS chunk_language,
           t.id AS text_id, t.language::text AS text_language, t.relation, t.title AS text_title,
           t.year_from AS text_year_from, t.year_to AS text_year_to,
           ${EFFECTIVE_ACCESS_SQL} AS effective_access_level,
           w.id AS work_id, w.title AS work_title, w.genre, w.year_from AS work_year_from, w.year_to AS work_year_to,
           coalesce((SELECT json_agg(json_build_object('person_id', p.id, 'display_name', p.display_name,
                                                       'role', wp.role, 'certainty', wp.certainty)
                                     ORDER BY wp.role, p.display_name, p.id)
                       FROM work_person wp JOIN person p ON p.id = wp.person_id
                      WHERE wp.work_id = w.id), '[]') AS authors
      FROM hits h
      JOIN chunk c ON c.id = h.chunk_id
      JOIN text t ON t.id = c.text_id
      LEFT JOIN source s ON s.id = t.source_id
      JOIN work w ON w.id = t.work_id
     ORDER BY h.distance, h.chunk_id`;
  return { text, values: p.values };
}

function similarity(metric: Metric, distance: number): number | null {
  if (metric === 'cosine') return 1 - distance;
  if (metric === 'inner_product') return -distance;
  return null;
}

/**
 * Runs a search. Must be called inside a transaction (the hnsw settings are
 * SET LOCAL). Callers may set further planner settings beforehand (tests).
 */
export async function runSearch(db: Db, input: SearchInput) {
  const efSearch = Math.min(1000, Math.max(40, input.limit));
  await db.query(
    `SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true), set_config('hnsw.ef_search', $1, true)`,
    [String(efSearch)],
  );
  const sql = buildSearchSql(input);
  const { rows } = await db.query(sql.text, sql.values);
  return rows.map((r) => ({
    embedding_id: r.embedding_id,
    distance: r.distance,
    similarity: similarity(input.space.metric, r.distance),
    chunk: {
      id: r.chunk_id,
      segmentation_id: r.segmentation_id,
      sequence: r.sequence,
      start_offset: r.start_offset,
      end_offset: r.end_offset,
      text: r.chunk_text,
      locus: r.locus,
      language: r.chunk_language,
    },
    text: {
      id: r.text_id,
      language: r.text_language,
      relation: r.relation,
      title: r.text_title,
      year_from: r.text_year_from,
      year_to: r.text_year_to,
      effective_access_level: r.effective_access_level,
    },
    work: {
      id: r.work_id,
      title: r.work_title,
      genre: r.genre,
      year_from: r.work_year_from,
      year_to: r.work_year_to,
    },
    authors: r.authors,
  }));
}

export const searchRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/search',
    {
      preHandler: requireRole('reader'),
      schema: { body: SearchBody, response: { 200: SearchResponse, ...errorResponses } },
    },
    async (request) => {
      const body = request.body;
      const principal = principalOf(request);
      const includeRestricted = body.filters?.include_restricted === true;
      if (includeRestricted && !hasRole(principal, 'contributor')) {
        throw forbidden('include_restricted requires role contributor or higher');
      }
      const filters = body.filters ?? {};
      if (filters.year_from !== undefined && filters.year_to !== undefined && filters.year_from > filters.year_to) {
        throw unprocessable('filters.year_from must be <= filters.year_to');
      }
      const space = await loadSpace(app.pg, body.embedding_space_id);
      if (space.withdrawn_at) throw conflict('embedding space is withdrawn');
      const problem = vectorProblem(body.vector, space, { checkNormalized: false });
      if (problem) throw unprocessable(`invalid query vector: ${problem}`);
      // A transaction for SET LOCAL; the search itself writes nothing.
      const items = await withTransaction(app.pg, principal, request.id, (client) =>
        runSearch(client, {
          space,
          vector: body.vector,
          limit: body.limit ?? DEFAULT_SEARCH_LIMIT,
          filters,
          includeRestricted,
        }),
      );
      return { embedding_space_id: space.id, metric: space.metric, items };
    },
  );
};
