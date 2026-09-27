import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { withTransaction } from '../../db/transaction.js';
import { notFound } from '../../lib/errors.js';
import { keyset, Page, toPage } from '../../lib/pagination.js';
import { insertSql, SqlParams, type Db } from '../../lib/sql.js';
import { principalOf, requireRole } from '../../plugins/auth.js';
import { AuditFields, DateTime, errorResponses, IdParams, JsonObject, Nullable, Uuid, WithdrawnFields, Year } from '../schemas.js';
import { ListQueryBase, patchRow, WithdrawBody, withdrawRow } from './common.js';

export const AccessLevel = Type.Union([Type.Literal('public'), Type.Literal('restricted')]);

export const SourceKind = Type.Union([
  Type.Literal('print_edition'),
  Type.Literal('digital_edition'),
  Type.Literal('manuscript'),
  Type.Literal('recording_transcript'),
  Type.Literal('author_submission'),
  Type.Literal('other'),
]);

const SOURCE_COLUMNS = [
  'kind',
  'citation',
  'editor',
  'title',
  'series',
  'volume',
  'publisher',
  'place',
  'year',
  'url',
  'retrieved_at',
  'license',
  'rights_holder',
  'access_level',
  'metadata',
] as const;

const OptionalText = Type.Optional(Nullable(Type.String({ maxLength: 4000 })));

const sourceFields = {
  kind: SourceKind,
  citation: Type.String({ minLength: 1, maxLength: 4000 }),
  editor: OptionalText,
  title: OptionalText,
  series: OptionalText,
  volume: OptionalText,
  publisher: OptionalText,
  place: OptionalText,
  year: Type.Optional(Nullable(Year)),
  url: OptionalText,
  retrieved_at: Type.Optional(Nullable(DateTime)),
  license: OptionalText,
  rights_holder: OptionalText,
  access_level: Type.Optional(AccessLevel),
  metadata: Type.Optional(JsonObject),
};

const CreateSourceBody = Type.Object({ id: Type.Optional(Uuid), ...sourceFields });
const PatchSourceBody = Type.Partial(Type.Object(sourceFields));

const NullableString = Nullable(Type.String());

export const SourceSchema = Type.Object({
  id: Uuid,
  kind: SourceKind,
  citation: Type.String(),
  editor: NullableString,
  title: NullableString,
  series: NullableString,
  volume: NullableString,
  publisher: NullableString,
  place: NullableString,
  year: Nullable(Type.Integer()),
  url: NullableString,
  retrieved_at: Nullable(DateTime),
  license: NullableString,
  rights_holder: NullableString,
  access_level: AccessLevel,
  metadata: JsonObject,
  ...WithdrawnFields,
  ...AuditFields,
});

async function getSource(db: Db, id: string) {
  const { rows } = await db.query('SELECT * FROM source WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('source not found');
  return rows[0];
}

export const sourceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/sources',
    {
      preHandler: requireRole('contributor'),
      schema: { body: CreateSourceBody, response: { 201: SourceSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const source = await withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const sql = insertSql('source', ['id', ...SOURCE_COLUMNS], request.body);
        const { rows } = await client.query(sql.text, sql.values);
        return getSource(client, rows[0].id);
      });
      return reply.status(201).send(source);
    },
  );

  app.get(
    '/sources',
    {
      preHandler: requireRole('reader'),
      schema: {
        querystring: Type.Object(ListQueryBase),
        response: { 200: Page(SourceSchema), ...errorResponses },
      },
    },
    async (request) => {
      const q = request.query;
      const p = new SqlParams();
      const where: string[] = [];
      if (!q.include_withdrawn) where.push('withdrawn_at IS NULL');
      const page = keyset(p, q, 'id');
      where.push(...page.where);
      const { rows } = await app.pg.query(
        `SELECT * FROM source WHERE ${where.join(' AND ') || 'true'} ORDER BY id ${page.limitSql}`,
        p.values,
      );
      return toPage(rows, page.limit);
    },
  );

  app.get(
    '/sources/:id',
    {
      preHandler: requireRole('reader'),
      schema: { params: IdParams, response: { 200: SourceSchema, ...errorResponses } },
    },
    async (request) => getSource(app.pg, request.params.id),
  );

  app.patch(
    '/sources/:id',
    {
      preHandler: requireRole('curator'),
      schema: { params: IdParams, body: PatchSourceBody, response: { 200: SourceSchema, ...errorResponses } },
    },
    async (request) =>
      withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        await patchRow(client, 'source', SOURCE_COLUMNS, request.params.id, request.body);
        return getSource(client, request.params.id);
      }),
  );

  app.post(
    '/sources/:id/withdraw',
    {
      preHandler: requireRole('curator'),
      schema: { params: IdParams, body: WithdrawBody, response: { 200: SourceSchema, ...errorResponses } },
    },
    async (request) =>
      withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        await withdrawRow(client, 'source', request.params.id, request.body.reason);
        return getSource(client, request.params.id);
      }),
  );
};
