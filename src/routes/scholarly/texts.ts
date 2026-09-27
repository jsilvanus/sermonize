import { Type, type FastifyPluginAsyncTypebox, type Static } from '@fastify/type-provider-typebox';
import { withTransaction } from '../../db/transaction.js';
import { forbidden, immutable, notFound, unprocessable } from '../../lib/errors.js';
import { keyset, Page, toPage } from '../../lib/pagination.js';
import { hasRole } from '../../lib/principal.js';
import { insertSql, pickColumns, SqlParams, type Db } from '../../lib/sql.js';
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
import { AccessLevel } from './sources.js';

const Relation = Type.Union([Type.Literal('original'), Type.Literal('translation'), Type.Literal('adaptation')]);
const Coverage = Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('excerpt')]);
const TextPersonRole = Type.Union([
  Type.Literal('translator'),
  Type.Literal('editor'),
  Type.Literal('transcriber'),
  Type.Literal('reviser'),
]);

/** Metadata columns a client may write. `body` is accepted by POST only (it is immutable). */
const TEXT_COLUMNS = [
  'work_id',
  'source_id',
  'language',
  'relation',
  'translated_from_language',
  'base_text_id',
  'base_note',
  'coverage',
  'coverage_note',
  'year_from',
  'year_to',
  'date_note',
  'title',
  'supersedes_text_id',
  'access_level',
  'metadata',
] as const;

const NullableNote = Type.Optional(Nullable(Type.String({ maxLength: 4000 })));

const textFields = {
  work_id: Uuid,
  source_id: Type.Optional(Nullable(Uuid)),
  language: LanguageTag,
  relation: Relation,
  translated_from_language: Type.Optional(Nullable(LanguageTag)),
  base_text_id: Type.Optional(Nullable(Uuid)),
  base_note: NullableNote,
  coverage: Type.Optional(Coverage),
  coverage_note: NullableNote,
  year_from: Type.Optional(Nullable(Year)),
  year_to: Type.Optional(Nullable(Year)),
  date_note: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  title: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  supersedes_text_id: Type.Optional(Nullable(Uuid)),
  access_level: Type.Optional(AccessLevel),
  metadata: Type.Optional(JsonObject),
};

const TextPersonInput = Type.Object({
  person_id: Uuid,
  role: TextPersonRole,
  note: Type.Optional(Nullable(Type.String({ maxLength: 4000 }))),
});
const TextPersonsBody = Type.Array(TextPersonInput, { maxItems: 1000 });

const CreateTextBody = Type.Object({
  id: Type.Optional(Uuid),
  ...textFields,
  body: Type.String({ minLength: 1, description: 'NFC-normalised, \\n line endings. Immutable.' }),
  persons: Type.Optional(TextPersonsBody),
});
// `body` is not listed; a PATCH that includes it is rejected explicitly (409 immutable).
const PatchTextBody = Type.Partial(Type.Object(textFields));

const NullableString = Nullable(Type.String());
const textColumns = {
  id: Uuid,
  work_id: Uuid,
  source_id: Nullable(Uuid),
  language: Type.String(),
  relation: Relation,
  translated_from_language: NullableString,
  base_text_id: Nullable(Uuid),
  base_note: NullableString,
  coverage: Coverage,
  coverage_note: NullableString,
  year_from: Nullable(Type.Integer()),
  year_to: Nullable(Type.Integer()),
  date_note: NullableString,
  title: NullableString,
  content_sha256: Type.String(),
  char_length: Type.Integer({ description: 'Length of body in Unicode code points.' }),
  supersedes_text_id: Nullable(Uuid),
  access_level: AccessLevel,
  effective_access_level: Type.Union([Type.Literal('public'), Type.Literal('restricted')], {
    description: 'Most restrictive of the text and its source access levels.',
  }),
  metadata: JsonObject,
  ...WithdrawnFields,
  ...AuditFields,
};

export const TextSummarySchema = Type.Object(textColumns);
export const TextSchema = Type.Object({
  ...textColumns,
  persons: Type.Array(
    Type.Object({ person_id: Uuid, display_name: Type.String(), role: TextPersonRole, note: NullableString }),
  ),
});

const BodyQuery = Type.Object({
  start: Type.Optional(Type.Integer({ minimum: 0, description: 'Code-point offset (inclusive), default 0.' })),
  end: Type.Optional(Type.Integer({ minimum: 0, description: 'Code-point offset (exclusive), default char_length.' })),
});
const BodySchema = Type.Object({ text_id: Uuid, start: Type.Integer(), end: Type.Integer(), content: Type.String() });

/** SQL for the effective access level of text `t` joined to its source `s`. */
export const EFFECTIVE_ACCESS_SQL = `CASE WHEN t.access_level = 'restricted' OR s.access_level = 'restricted'
  THEN 'restricted' ELSE 'public' END`;

/** Every text column except body (bodies are only returned by GET /texts/:id/body). */
const TEXT_FIELDS_SQL = `${[...TEXT_COLUMNS, 'id', 'content_sha256', 'char_length', 'withdrawn_at', 'withdrawn_by',
  'withdrawn_reason', 'created_by', 'created_at', 'updated_by', 'updated_at']
  .map((c) => `t.${c}`)
  .join(', ')}, ${EFFECTIVE_ACCESS_SQL} AS effective_access_level`;
const TEXT_FROM_SQL = 'FROM text t LEFT JOIN source s ON s.id = t.source_id';

async function getText(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT ${TEXT_FIELDS_SQL},
       coalesce((SELECT json_agg(json_build_object('person_id', tp.person_id, 'display_name', p.display_name,
                                                   'role', tp.role, 'note', tp.note)
                                 ORDER BY tp.role, p.display_name, tp.person_id)
                   FROM text_person tp JOIN person p ON p.id = tp.person_id
                  WHERE tp.text_id = t.id), '[]') AS persons
     ${TEXT_FROM_SQL} WHERE t.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('text not found');
  return rows[0];
}

/** API-side body checks, mirroring the database CHECKs with clearer messages. */
function checkBody(body: string): void {
  if (body.includes('\r')) {
    throw unprocessable('text body must use \\n line endings; \\r characters are not allowed');
  }
  if (body.normalize('NFC') !== body) {
    throw unprocessable('text body must be NFC-normalised (Unicode Normalization Form C)');
  }
}

interface TextRefs {
  work_id: string;
  relation: string;
  translated_from_language?: string | null;
  base_text_id?: string | null;
  supersedes_text_id?: string | null;
}

/** Cross-field rules checked before writing (the database enforces them too). */
async function checkTextRefs(db: Db, t: TextRefs): Promise<void> {
  if (t.relation === 'original' && t.translated_from_language != null) {
    throw unprocessable("translated_from_language is only allowed when relation is not 'original'");
  }
  for (const field of ['base_text_id', 'supersedes_text_id'] as const) {
    const ref = t[field];
    if (ref == null) continue;
    const { rows } = await db.query('SELECT work_id FROM text WHERE id = $1', [ref]);
    if (!rows[0]) throw unprocessable(`${field} does not reference an existing text`);
    if (rows[0].work_id !== t.work_id) throw unprocessable(`${field} must reference a text of the same work`);
  }
}

async function replaceTextPersons(db: Db, textId: string, persons: Static<typeof TextPersonsBody>): Promise<void> {
  assertUnique(persons, (p) => `${p.person_id} ${p.role}`, 'person_id and role');
  const personIds = persons.map((p) => p.person_id);
  const roles = persons.map((p) => p.role);
  await db.query(
    `DELETE FROM text_person tp
      WHERE tp.text_id = $1
        AND NOT EXISTS (SELECT 1 FROM unnest($2::uuid[], $3::text[]) AS n(person_id, role)
                         WHERE n.person_id = tp.person_id AND n.role = tp.role)`,
    [textId, personIds, roles],
  );
  if (persons.length === 0) return;
  await db.query(
    `INSERT INTO text_person (text_id, person_id, role, note)
     SELECT $1, n.person_id, n.role, n.note
       FROM unnest($2::uuid[], $3::text[], $4::text[]) AS n(person_id, role, note)
     ON CONFLICT (text_id, person_id, role) DO UPDATE SET note = EXCLUDED.note
      WHERE text_person.note IS DISTINCT FROM EXCLUDED.note`,
    [textId, personIds, roles, persons.map((p) => p.note ?? null)],
  );
}

export const textRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/texts',
    {
      preHandler: requireRole('contributor'),
      schema: { body: CreateTextBody, response: { 201: TextSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const body = request.body;
      checkBody(body.body);
      const text = await withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        await checkTextRefs(client, body);
        const sql = insertSql('text', ['id', ...TEXT_COLUMNS, 'body'], body);
        const { rows } = await client.query(sql.text, sql.values);
        const id: string = rows[0].id;
        if (body.persons) await replaceTextPersons(client, id, body.persons);
        return getText(client, id);
      });
      return reply.status(201).send(text);
    },
  );

  app.get(
    '/texts',
    {
      preHandler: requireRole('reader'),
      schema: {
        querystring: Type.Object({
          ...ListQueryBase,
          work_id: Type.Optional(Uuid),
          language: Type.Optional(LanguageTag),
          relation: Type.Optional(Relation),
          source_id: Type.Optional(Uuid),
        }),
        response: { 200: Page(TextSummarySchema), ...errorResponses },
      },
    },
    async (request) => {
      const q = request.query;
      const p = new SqlParams();
      const where: string[] = [];
      if (!q.include_withdrawn) where.push('t.withdrawn_at IS NULL');
      if (q.work_id !== undefined) where.push(`t.work_id = ${p.add(q.work_id)}`);
      if (q.language !== undefined) where.push(`t.language = ${p.add(q.language)}`);
      if (q.relation !== undefined) where.push(`t.relation = ${p.add(q.relation)}`);
      if (q.source_id !== undefined) where.push(`t.source_id = ${p.add(q.source_id)}`);
      const page = keyset(p, q, 't.id');
      where.push(...page.where);
      const { rows } = await app.pg.query(
        `SELECT ${TEXT_FIELDS_SQL} ${TEXT_FROM_SQL} WHERE ${where.join(' AND ') || 'true'} ORDER BY t.id ${page.limitSql}`,
        p.values,
      );
      return toPage(rows, page.limit);
    },
  );

  app.get(
    '/texts/:id',
    {
      preHandler: requireRole('reader'),
      schema: { params: IdParams, response: { 200: TextSchema, ...errorResponses } },
    },
    async (request) => getText(app.pg, request.params.id),
  );

  app.get(
    '/texts/:id/body',
    {
      preHandler: requireRole('reader'),
      schema: { params: IdParams, querystring: BodyQuery, response: { 200: BodySchema, ...errorResponses } },
    },
    async (request) => {
      const id = request.params.id;
      const { rows } = await app.pg.query(
        `SELECT t.char_length, ${EFFECTIVE_ACCESS_SQL} AS effective_access_level ${TEXT_FROM_SQL} WHERE t.id = $1`,
        [id],
      );
      const meta = rows[0] as { char_length: number; effective_access_level: string } | undefined;
      if (!meta) throw notFound('text not found');
      if (meta.effective_access_level === 'restricted' && !hasRole(principalOf(request), 'contributor')) {
        throw forbidden('restricted text bodies require role contributor or higher');
      }
      const start = request.query.start ?? 0;
      const end = request.query.end ?? meta.char_length;
      if (start > end || end > meta.char_length) {
        throw unprocessable('require 0 <= start <= end <= char_length (code points)', {
          start,
          end,
          char_length: meta.char_length,
        });
      }
      const content = await app.pg.query('SELECT substr(body, $2::int + 1, $3::int) AS content FROM text WHERE id = $1', [
        id,
        start,
        end - start,
      ]);
      return { text_id: id, start, end, content: content.rows[0].content as string };
    },
  );

  app.patch(
    '/texts/:id',
    {
      preHandler: requireRole('curator'),
      schema: { params: IdParams, body: PatchTextBody, response: { 200: TextSchema, ...errorResponses } },
    },
    async (request) => {
      if ('body' in request.body) {
        throw immutable('text body is immutable; create a new text with supersedes_text_id');
      }
      return withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const id = request.params.id;
        const current = await lockRow<TextRefs>(
          client,
          'text',
          id,
          'work_id, relation, translated_from_language, base_text_id, supersedes_text_id',
        );
        await checkTextRefs(client, { ...current, ...pickColumns(request.body, TEXT_COLUMNS) });
        await patchRow(client, 'text', TEXT_COLUMNS, id, request.body);
        return getText(client, id);
      });
    },
  );

  app.post(
    '/texts/:id/withdraw',
    {
      preHandler: requireRole('curator'),
      schema: { params: IdParams, body: WithdrawBody, response: { 200: TextSchema, ...errorResponses } },
    },
    async (request) =>
      withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        await withdrawRow(client, 'text', request.params.id, request.body.reason);
        return getText(client, request.params.id);
      }),
  );

  app.put(
    '/texts/:id/persons',
    {
      preHandler: requireRole('curator'),
      schema: { params: IdParams, body: TextPersonsBody, response: { 200: TextSchema, ...errorResponses } },
    },
    async (request) =>
      withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        await lockRow(client, 'text', request.params.id);
        await replaceTextPersons(client, request.params.id, request.body);
        return getText(client, request.params.id);
      }),
  );
};
