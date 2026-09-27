import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { withTransaction } from '../../db/transaction.js';
import { notFound } from '../../lib/errors.js';
import { keyset, Page, toPage } from '../../lib/pagination.js';
import { escapeLike, insertSql, SqlParams, type Db } from '../../lib/sql.js';
import { principalOf, requireRole } from '../../plugins/auth.js';
import {
  AuditFields,
  errorResponses,
  IdParams,
  JsonObject,
  Nullable,
  Uuid,
  WithdrawnFields,
  Year,
} from '../schemas.js';
import { ListQueryBase, patchRow, WithdrawBody, withdrawRow } from './common.js';

/** Columns a client may write (POST also accepts `id`). */
const PERSON_COLUMNS = [
  'display_name',
  'name_variants',
  'is_living',
  'year_from',
  'year_to',
  'date_note',
  'external_ids',
  'metadata',
] as const;

const personFields = {
  display_name: Type.String({ minLength: 1, maxLength: 1000 }),
  name_variants: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }))),
  is_living: Type.Optional(Nullable(Type.Boolean())),
  year_from: Type.Optional(Nullable(Year)),
  year_to: Type.Optional(Nullable(Year)),
  date_note: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  external_ids: Type.Optional(JsonObject),
  metadata: Type.Optional(JsonObject),
};

const CreatePersonBody = Type.Object({ id: Type.Optional(Uuid), ...personFields });
const PatchPersonBody = Type.Partial(Type.Object(personFields));

export const PersonSchema = Type.Object({
  id: Uuid,
  display_name: Type.String(),
  name_variants: Type.Array(Type.String()),
  is_living: Nullable(Type.Boolean()),
  year_from: Nullable(Type.Integer()),
  year_to: Nullable(Type.Integer()),
  date_note: Nullable(Type.String()),
  external_ids: JsonObject,
  metadata: JsonObject,
  ...WithdrawnFields,
  ...AuditFields,
});

async function getPerson(db: Db, id: string) {
  const { rows } = await db.query('SELECT * FROM person WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('person not found');
  return rows[0];
}

export const personRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/persons',
    {
      preHandler: requireRole('contributor'),
      schema: { body: CreatePersonBody, response: { 201: PersonSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const person = await withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const sql = insertSql('person', ['id', ...PERSON_COLUMNS], request.body);
        const { rows } = await client.query(sql.text, sql.values);
        return getPerson(client, rows[0].id);
      });
      return reply.status(201).send(person);
    },
  );

  app.get(
    '/persons',
    {
      preHandler: requireRole('reader'),
      schema: {
        querystring: Type.Object({
          ...ListQueryBase,
          q: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Name contains (case-insensitive).' })),
        }),
        response: { 200: Page(PersonSchema), ...errorResponses },
      },
    },
    async (request) => {
      const q = request.query;
      const p = new SqlParams();
      const where: string[] = [];
      if (!q.include_withdrawn) where.push('withdrawn_at IS NULL');
      if (q.q !== undefined) {
        const pattern = p.add(`%${escapeLike(q.q)}%`);
        where.push(`(display_name ILIKE ${pattern} OR EXISTS (SELECT 1 FROM unnest(name_variants) v WHERE v ILIKE ${pattern}))`);
      }
      const page = keyset(p, q, 'id');
      where.push(...page.where);
      const { rows } = await app.pg.query(
        `SELECT * FROM person WHERE ${where.join(' AND ') || 'true'} ORDER BY id ${page.limitSql}`,
        p.values,
      );
      return toPage(rows, page.limit);
    },
  );

  app.get(
    '/persons/:id',
    {
      preHandler: requireRole('reader'),
      schema: { params: IdParams, response: { 200: PersonSchema, ...errorResponses } },
    },
    async (request) => getPerson(app.pg, request.params.id),
  );

  app.patch(
    '/persons/:id',
    {
      preHandler: requireRole('curator'),
      schema: { params: IdParams, body: PatchPersonBody, response: { 200: PersonSchema, ...errorResponses } },
    },
    async (request) =>
      withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        await patchRow(client, 'person', PERSON_COLUMNS, request.params.id, request.body);
        return getPerson(client, request.params.id);
      }),
  );

  app.post(
    '/persons/:id/withdraw',
    {
      preHandler: requireRole('curator'),
      schema: { params: IdParams, body: WithdrawBody, response: { 200: PersonSchema, ...errorResponses } },
    },
    async (request) =>
      withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        await withdrawRow(client, 'person', request.params.id, request.body.reason);
        return getPerson(client, request.params.id);
      }),
  );
};
