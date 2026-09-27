import { Type, type FastifyPluginAsyncTypebox, type Static } from '@fastify/type-provider-typebox';
import { withTransaction } from '../../db/transaction.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { keyset, Page, toPage } from '../../lib/pagination.js';
import { insertSql, SqlParams, type Db } from '../../lib/sql.js';
import { principalOf, requireRole } from '../../plugins/auth.js';
import {
  AuditFields,
  errorResponses,
  IdParams,
  JsonObject,
  LanguageTag,
  Nullable,
  Uuid,
  WithdrawnFields,
  Year,
} from '../schemas.js';
import { assertUnique, ListQueryBase, lockRow, patchRow, WithdrawBody, withdrawRow } from './common.js';

export const Genre = Type.Union([
  Type.Literal('treatise'),
  Type.Literal('sermon'),
  Type.Literal('letter'),
  Type.Literal('confession'),
  Type.Literal('commentary'),
  Type.Literal('homily'),
  Type.Literal('hymn'),
  Type.Literal('other'),
]);

const WorkPersonRole = Type.Union([
  Type.Literal('author'),
  Type.Literal('attributed_author'),
  Type.Literal('pseudonymous_author'),
  Type.Literal('compiler'),
]);

const Certainty = Type.Union([
  Type.Literal('certain'),
  Type.Literal('probable'),
  Type.Literal('disputed'),
  Type.Literal('spurious'),
]);

const WORK_COLUMNS = [
  'title',
  'title_variants',
  'genre',
  'original_languages',
  'part_of_work_id',
  'year_from',
  'year_to',
  'date_note',
  'external_ids',
  'metadata',
] as const;

const workFields = {
  title: Type.String({ minLength: 1, maxLength: 2000 }),
  title_variants: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }))),
  genre: Genre,
  original_languages: Type.Optional(
    Nullable(Type.Array(LanguageTag, { description: 'null = unknown; [] is stored as given.' })),
  ),
  part_of_work_id: Type.Optional(Nullable(Uuid)),
  year_from: Type.Optional(Nullable(Year)),
  year_to: Type.Optional(Nullable(Year)),
  date_note: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  external_ids: Type.Optional(JsonObject),
  metadata: Type.Optional(JsonObject),
};

const WorkPersonInput = Type.Object({
  person_id: Uuid,
  role: WorkPersonRole,
  certainty: Type.Optional(Certainty),
  note: Type.Optional(Nullable(Type.String({ maxLength: 4000 }))),
});
const WorkPersonsBody = Type.Array(WorkPersonInput, { maxItems: 1000 });

const NullableText = Type.Optional(Nullable(Type.String({ maxLength: 1000 })));
const OccasionBody = Type.Object({
  preached_on: Type.Optional(Nullable(Type.String({ format: 'date' }))),
  church_year_day: NullableText,
  lectionary: NullableText,
  lectionary_year: NullableText,
  pericopes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }))),
  place: NullableText,
  metadata: Type.Optional(JsonObject),
});

const CreateWorkBody = Type.Object({
  id: Type.Optional(Uuid),
  ...workFields,
  persons: Type.Optional(WorkPersonsBody),
  occasion: Type.Optional(OccasionBody),
});
const PatchWorkBody = Type.Partial(Type.Object(workFields));

const WorkPersonSchema = Type.Object({
  person_id: Uuid,
  display_name: Type.String(),
  role: WorkPersonRole,
  certainty: Certainty,
  note: Nullable(Type.String()),
});

const OccasionSchema = Type.Object({
  preached_on: Nullable(Type.String({ format: 'date' })),
  church_year_day: Nullable(Type.String()),
  lectionary: Nullable(Type.String()),
  lectionary_year: Nullable(Type.String()),
  pericopes: Type.Array(Type.String()),
  place: Nullable(Type.String()),
  metadata: JsonObject,
});

const workColumns = {
  id: Uuid,
  title: Type.String(),
  title_variants: Type.Array(Type.String()),
  genre: Genre,
  original_languages: Nullable(Type.Array(Type.String())),
  part_of_work_id: Nullable(Uuid),
  year_from: Nullable(Type.Integer()),
  year_to: Nullable(Type.Integer()),
  date_note: Nullable(Type.String()),
  external_ids: JsonObject,
  metadata: JsonObject,
  ...WithdrawnFields,
  ...AuditFields,
};

/** List item: the work's own columns. */
export const WorkSummarySchema = Type.Object(workColumns);
/** GET by id: plus persons and (for sermons) the occasion. */
export const WorkSchema = Type.Object({
  ...workColumns,
  persons: Type.Array(WorkPersonSchema),
  occasion: Nullable(OccasionSchema),
});

/**
 * Work columns for SELECT. original_languages is a domain array (language_tag[]),
 * which node-postgres does not parse, so it is cast to text[].
 */
const WORK_FIELDS_SQL = [...WORK_COLUMNS, 'id', 'withdrawn_at', 'withdrawn_by', 'withdrawn_reason', 'created_by',
  'created_at', 'updated_by', 'updated_at']
  .map((c) => (c === 'original_languages' ? 'w.original_languages::text[] AS original_languages' : `w.${c}`))
  .join(', ');

async function getWork(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT ${WORK_FIELDS_SQL},
       coalesce((SELECT json_agg(json_build_object('person_id', wp.person_id, 'display_name', p.display_name,
                                                   'role', wp.role, 'certainty', wp.certainty, 'note', wp.note)
                                 ORDER BY wp.role, p.display_name, wp.person_id)
                   FROM work_person wp JOIN person p ON p.id = wp.person_id
                  WHERE wp.work_id = w.id), '[]') AS persons,
       (SELECT json_build_object('preached_on', so.preached_on, 'church_year_day', so.church_year_day,
                                 'lectionary', so.lectionary, 'lectionary_year', so.lectionary_year,
                                 'pericopes', so.pericopes, 'place', so.place, 'metadata', so.metadata)
          FROM sermon_occasion so WHERE so.work_id = w.id) AS occasion
     FROM work w WHERE w.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('work not found');
  return rows[0];
}

/** Replaces the work's person links: removes missing ones, inserts new ones, updates changed ones. */
async function replaceWorkPersons(db: Db, workId: string, persons: Static<typeof WorkPersonsBody>): Promise<void> {
  assertUnique(persons, (p) => `${p.person_id} ${p.role}`, 'person_id and role');
  const personIds = persons.map((p) => p.person_id);
  const roles = persons.map((p) => p.role);
  await db.query(
    `DELETE FROM work_person wp
      WHERE wp.work_id = $1
        AND NOT EXISTS (SELECT 1 FROM unnest($2::uuid[], $3::text[]) AS n(person_id, role)
                         WHERE n.person_id = wp.person_id AND n.role = wp.role)`,
    [workId, personIds, roles],
  );
  if (persons.length === 0) return;
  await db.query(
    `INSERT INTO work_person (work_id, person_id, role, certainty, note)
     SELECT $1, n.person_id, n.role, n.certainty, n.note
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[]) AS n(person_id, role, certainty, note)
     ON CONFLICT (work_id, person_id, role) DO UPDATE
        SET certainty = EXCLUDED.certainty, note = EXCLUDED.note
      WHERE (work_person.certainty, work_person.note) IS DISTINCT FROM (EXCLUDED.certainty, EXCLUDED.note)`,
    [workId, personIds, roles, persons.map((p) => p.certainty ?? 'certain'), persons.map((p) => p.note ?? null)],
  );
}

/** Creates or fully replaces the sermon occasion (omitted fields are cleared). */
async function putOccasion(db: Db, workId: string, genre: string, o: Static<typeof OccasionBody>): Promise<void> {
  if (genre !== 'sermon') throw unprocessable('a sermon occasion is only allowed for works of genre sermon');
  await db.query(
    `INSERT INTO sermon_occasion (work_id, preached_on, church_year_day, lectionary, lectionary_year, pericopes, place, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (work_id) DO UPDATE
        SET preached_on = EXCLUDED.preached_on, church_year_day = EXCLUDED.church_year_day,
            lectionary = EXCLUDED.lectionary, lectionary_year = EXCLUDED.lectionary_year,
            pericopes = EXCLUDED.pericopes, place = EXCLUDED.place, metadata = EXCLUDED.metadata`,
    [
      workId,
      o.preached_on ?? null,
      o.church_year_day ?? null,
      o.lectionary ?? null,
      o.lectionary_year ?? null,
      o.pericopes ?? [],
      o.place ?? null,
      o.metadata ?? {},
    ],
  );
}

export const workRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/works',
    {
      preHandler: requireRole('contributor'),
      schema: { body: CreateWorkBody, response: { 201: WorkSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const body = request.body;
      const work = await withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const sql = insertSql('work', ['id', ...WORK_COLUMNS], body);
        const { rows } = await client.query(sql.text, sql.values);
        const id: string = rows[0].id;
        if (body.persons) await replaceWorkPersons(client, id, body.persons);
        if (body.occasion) await putOccasion(client, id, body.genre, body.occasion);
        return getWork(client, id);
      });
      return reply.status(201).send(work);
    },
  );

  app.get(
    '/works',
    {
      preHandler: requireRole('reader'),
      schema: {
        querystring: Type.Object({
          ...ListQueryBase,
          genre: Type.Optional(Genre),
          person_id: Type.Optional(Uuid),
          year_from: Type.Optional(Year),
          year_to: Type.Optional(Year),
          part_of_work_id: Type.Optional(Uuid),
        }),
        response: { 200: Page(WorkSummarySchema), ...errorResponses },
      },
    },
    async (request) => {
      const q = request.query;
      const p = new SqlParams();
      const where: string[] = [];
      if (!q.include_withdrawn) where.push('w.withdrawn_at IS NULL');
      if (q.genre !== undefined) where.push(`w.genre = ${p.add(q.genre)}`);
      if (q.part_of_work_id !== undefined) where.push(`w.part_of_work_id = ${p.add(q.part_of_work_id)}`);
      if (q.person_id !== undefined) {
        where.push(`EXISTS (SELECT 1 FROM work_person wp WHERE wp.work_id = w.id AND wp.person_id = ${p.add(q.person_id)})`);
      }
      // Year filters select works whose date range overlaps [year_from, year_to]; undated works are excluded.
      if (q.year_from !== undefined) where.push(`coalesce(w.year_to, w.year_from) >= ${p.add(q.year_from)}`);
      if (q.year_to !== undefined) where.push(`coalesce(w.year_from, w.year_to) <= ${p.add(q.year_to)}`);
      const page = keyset(p, q, 'w.id');
      where.push(...page.where);
      const { rows } = await app.pg.query(
        `SELECT ${WORK_FIELDS_SQL} FROM work w WHERE ${where.join(' AND ') || 'true'} ORDER BY w.id ${page.limitSql}`,
        p.values,
      );
      return toPage(rows, page.limit);
    },
  );

  app.get(
    '/works/:id',
    {
      preHandler: requireRole('reader'),
      schema: { params: IdParams, response: { 200: WorkSchema, ...errorResponses } },
    },
    async (request) => getWork(app.pg, request.params.id),
  );

  app.patch(
    '/works/:id',
    {
      preHandler: requireRole('curator'),
      schema: { params: IdParams, body: PatchWorkBody, response: { 200: WorkSchema, ...errorResponses } },
    },
    async (request) =>
      withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const id = request.params.id;
        await lockRow(client, 'work', id);
        const parent = request.body.part_of_work_id;
        if (parent) {
          // part_of_work_id must not create a cycle (the new parent may not be the work or one of its parts).
          const { rows } = await client.query(
            `WITH RECURSIVE up(id) AS (
               SELECT $1::uuid
               UNION SELECT w.part_of_work_id FROM work w JOIN up ON w.id = up.id WHERE w.part_of_work_id IS NOT NULL)
             SELECT 1 FROM up WHERE id = $2`,
            [parent, id],
          );
          if (rows[0]) throw unprocessable('part_of_work_id would create a cycle');
        }
        await patchRow(client, 'work', WORK_COLUMNS, id, request.body);
        return getWork(client, id);
      }),
  );

  app.post(
    '/works/:id/withdraw',
    {
      preHandler: requireRole('curator'),
      schema: { params: IdParams, body: WithdrawBody, response: { 200: WorkSchema, ...errorResponses } },
    },
    async (request) =>
      withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        await withdrawRow(client, 'work', request.params.id, request.body.reason);
        return getWork(client, request.params.id);
      }),
  );

  app.put(
    '/works/:id/persons',
    {
      preHandler: requireRole('curator'),
      schema: { params: IdParams, body: WorkPersonsBody, response: { 200: WorkSchema, ...errorResponses } },
    },
    async (request) =>
      withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        await lockRow(client, 'work', request.params.id);
        await replaceWorkPersons(client, request.params.id, request.body);
        return getWork(client, request.params.id);
      }),
  );

  app.put(
    '/works/:id/occasion',
    {
      preHandler: requireRole('curator'),
      schema: { params: IdParams, body: OccasionBody, response: { 200: WorkSchema, ...errorResponses } },
    },
    async (request) =>
      withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const work = await lockRow<{ genre: string }>(client, 'work', request.params.id, 'genre');
        await putOccasion(client, request.params.id, work.genre, request.body);
        return getWork(client, request.params.id);
      }),
  );
};
