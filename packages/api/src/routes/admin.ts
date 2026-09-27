import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { PoolClient } from 'pg';
import { withTransaction } from '../db/transaction.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { decodeCursor, encodeCursor, PaginationQuery, DEFAULT_PAGE_LIMIT } from '../lib/pagination.js';
import { checkPasswordLength, hashPassword } from '../lib/passwords.js';
import { SYSTEM_USER_ID, type Role } from '../lib/principal.js';
import { escapeLike, updateSql } from '../lib/sql.js';
import {
  createUser,
  getUser,
  issueToken,
  listAdminUsers,
  listUserTokens,
  revokeToken,
  setUserPassword,
  updateUserPii,
  type AdminUser,
} from '../lib/users.js';
import { principalOf, requireRole } from '../plugins/auth.js';
import { DateTime, errorResponses, IdParams, Nullable, RoleSchema, UserKindSchema, Uuid } from './schemas.js';

const UserStatus = Type.Union([Type.Literal('active'), Type.Literal('disabled')]);

const AppUserSchema = Type.Object({
  id: Uuid,
  kind: UserKindSchema,
  role: RoleSchema,
  status: UserStatus,
  created_by: Uuid,
  created_at: DateTime,
  updated_by: Uuid,
  updated_at: DateTime,
});

/** Admin view of an account: includes PII (admins manage accounts), never password hashes. */
const AdminUserSchema = Type.Object({
  id: Uuid,
  kind: UserKindSchema,
  role: RoleSchema,
  status: UserStatus,
  email: Nullable(Type.String()),
  display_name: Nullable(Type.String()),
  has_password: Type.Boolean(),
  created_at: DateTime,
  updated_at: DateTime,
});

const TokenSummarySchema = Type.Object({
  total: Type.Integer(),
  active: Type.Integer(),
  expired: Type.Integer(),
  revoked: Type.Integer(),
});

const TokenInfoSchema = Type.Object({
  id: Uuid,
  name: Type.String(),
  created_by: Uuid,
  created_at: DateTime,
  expires_at: Nullable(DateTime),
  revoked_at: Nullable(DateTime),
  state: Type.Union([Type.Literal('active'), Type.Literal('expired'), Type.Literal('revoked')]),
});

const Password = Type.String({
  minLength: 1,
  maxLength: 1024,
  description: '12 to 256 characters (code points), like POST /auth/register. Hashed with argon2id; never stored or logged in clear.',
});

// PII is stored in private.user_pii (never in public tables or audit events).
const CreateUserBody = Type.Object({
  kind: UserKindSchema,
  role: RoleSchema,
  status: Type.Optional(UserStatus),
  email: Type.Optional(Type.String({ format: 'email', maxLength: 320 })),
  display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  password: Type.Optional(Password),
});

const UpdateUserBody = Type.Object({
  role: Type.Optional(RoleSchema),
  status: Type.Optional(UserStatus),
  email: Type.Optional(Type.String({ format: 'email', maxLength: 320 })),
  display_name: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 200 }))),
});

const SetPasswordBody = Type.Object({
  password: Password,
  revoke_tokens: Type.Optional(Type.Boolean({ description: "Also revoke all of the user's tokens." })),
});

const ListUsersQuery = Type.Object({
  role: Type.Optional(RoleSchema),
  status: Type.Optional(UserStatus),
  kind: Type.Optional(UserKindSchema),
  q: Type.Optional(
    Type.String({ minLength: 1, maxLength: 320, description: 'Case-insensitive substring of email or display name.' }),
  ),
  ...PaginationQuery,
});

const CreateTokenBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  expires_at: Type.Optional(Type.String({ format: 'date-time' })),
});

const TokenSchema = Type.Object({
  id: Uuid,
  user_id: Uuid,
  name: Type.String(),
  expires_at: Nullable(DateTime),
  token: Type.String({ description: 'Shown once. Only its SHA-256 is stored.' }),
});

/** Cursor key of GET /admin/users: `<created_at, µs, UTC>|<id>`. */
const USER_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

async function adminUser(client: PoolClient, id: string): Promise<AdminUser | null> {
  const [row] = await listAdminUsers(client, { id, limit: 1 });
  if (!row) return null;
  const { sortKey: _sortKey, ...user } = row;
  return user;
}

/**
 * Account administration (admin role only; every write is audited by triggers or
 * the private SECURITY DEFINER functions, reads of PII as `pii_read`):
 *   GET    /admin/users                 list with PII, filters, keyset pagination
 *   POST   /admin/users                 create (optional password)
 *   GET    /admin/users/:id             one user + token counts
 *   PATCH  /admin/users/:id             role, status, email, display_name (with guards)
 *   PUT    /admin/users/:id/password    set a password (optionally revoke tokens)
 *   GET    /admin/users/:id/tokens      token metadata
 *   POST   /admin/users/:id/tokens      issue a token (shown once)
 *   DELETE /admin/tokens/:id            revoke a token
 */
export const adminRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', requireRole('admin'));

  app.get(
    '/admin/users',
    {
      schema: {
        querystring: ListUsersQuery,
        response: {
          200: Type.Object({ items: Type.Array(AdminUserSchema), next_cursor: Nullable(Type.String()) }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { role, status, kind, q, cursor } = request.query;
      const limit = request.query.limit ?? DEFAULT_PAGE_LIMIT;
      let after: { createdAt: string; id: string } | undefined;
      if (cursor !== undefined) {
        const m = USER_CURSOR.exec(decodeCursor(cursor, (k) => USER_CURSOR.test(k)));
        after = { createdAt: m![1]!, id: m![2]! };
      }
      const rows = await withTransaction(app.pg, principalOf(request), request.id, (client) =>
        listAdminUsers(client, {
          role,
          status,
          kind,
          qPattern: q === undefined ? undefined : `%${escapeLike(q)}%`,
          after,
          limit: limit + 1,
        }),
      );
      const page = rows.slice(0, limit);
      const next_cursor = rows.length > limit ? encodeCursor(page[page.length - 1]!.sortKey) : null;
      return { items: page.map(({ sortKey: _sortKey, ...user }) => user), next_cursor };
    },
  );

  app.post(
    '/admin/users',
    { schema: { body: CreateUserBody, response: { 201: AppUserSchema, ...errorResponses } } },
    async (request, reply) => {
      const { kind, role, status, email, display_name, password } = request.body;
      let passwordHash: string | undefined;
      if (password !== undefined) {
        checkPasswordLength(password);
        if (kind !== 'human') throw unprocessable('service accounts cannot have a password (use API tokens)');
        if (email === undefined) throw unprocessable('a password needs an email address to sign in with');
        passwordHash = await hashPassword(password);
      }
      const user = await withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const created = await createUser(client, { kind, role, status, email, displayName: display_name });
        if (passwordHash) await setUserPassword(client, { userId: created.id, passwordHash });
        return created;
      });
      return reply.status(201).send(user);
    },
  );

  app.get(
    '/admin/users/:id',
    {
      schema: {
        params: IdParams,
        response: {
          200: Type.Intersect([AdminUserSchema, Type.Object({ tokens: TokenSummarySchema })]),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      return withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        const user = await adminUser(client, request.params.id);
        if (!user) throw notFound('user not found');
        const tokens = await listUserTokens(client, user.id);
        const count = (state: string) => tokens.filter((t) => t.state === state).length;
        return {
          ...user,
          tokens: { total: tokens.length, active: count('active'), expired: count('expired'), revoked: count('revoked') },
        };
      });
    },
  );

  app.patch(
    '/admin/users/:id',
    { schema: { params: IdParams, body: UpdateUserBody, response: { 200: AdminUserSchema, ...errorResponses } } },
    async (request) => {
      const { role, status, email, display_name } = request.body;
      if (role === undefined && status === undefined && email === undefined && display_name === undefined) {
        throw badRequest('nothing to update: give role, status, email or display_name');
      }
      const actor = principalOf(request);
      const id = request.params.id;
      return withTransaction(app.pg, actor, request.id, async (client) => {
        if (role !== undefined || status !== undefined) {
          // Lock every active admin first (in id order, so concurrent requests cannot deadlock),
          // then the target: two admins demoting each other cannot both succeed.
          await client.query(`SELECT id FROM app_user WHERE role = 'admin' AND status = 'active' ORDER BY id FOR UPDATE`);
        }
        const { rows } = await client.query<{ id: string; role: Role; status: 'active' | 'disabled' }>(
          'SELECT id, role, status FROM app_user WHERE id = $1 FOR UPDATE',
          [id],
        );
        const target = rows[0];
        if (!target) throw notFound('user not found');
        if (id === SYSTEM_USER_ID) {
          throw conflict('the system user cannot be changed', { reason: 'system_user' });
        }
        const losesAdmin =
          target.role === 'admin' &&
          target.status === 'active' &&
          ((role !== undefined && role !== 'admin') || status === 'disabled');
        if (losesAdmin) {
          if (id === actor.userId) {
            throw conflict('you cannot demote or disable your own account', { reason: 'self' });
          }
          const others = await client.query(
            `SELECT 1 FROM app_user WHERE role = 'admin' AND status = 'active' AND id <> $1 AND id <> $2 LIMIT 1`,
            [id, SYSTEM_USER_ID],
          );
          if (others.rowCount === 0) {
            throw conflict('cannot demote or disable the last active admin', { reason: 'last_admin' });
          }
        }
        const update = updateSql('app_user', ['role', 'status'], { role, status }, { id });
        if (update) await client.query(update.text, update.values);
        if (email !== undefined || display_name !== undefined) {
          await updateUserPii(client, id, {
            ...(email !== undefined && { email: email.trim() }),
            ...(display_name !== undefined && { displayName: display_name?.trim() || null }),
          });
        }
        return (await adminUser(client, id))!;
      });
    },
  );

  app.put(
    '/admin/users/:id/password',
    {
      schema: {
        params: IdParams,
        body: SetPasswordBody,
        response: { 200: Type.Object({ user_id: Uuid, revoked_tokens: Type.Integer() }), ...errorResponses },
      },
    },
    async (request) => {
      const { password, revoke_tokens } = request.body;
      checkPasswordLength(password);
      const id = request.params.id;
      const exists = await withTransaction(app.pg, principalOf(request), request.id, (c) => getUser(c, id));
      if (!exists) throw notFound('user not found');
      if (exists.kind !== 'human') throw unprocessable('service accounts cannot have a password (use API tokens)');
      const passwordHash = await hashPassword(password);
      const revoked = await withTransaction(app.pg, principalOf(request), request.id, (client) =>
        setUserPassword(client, { userId: id, passwordHash, revokeTokens: revoke_tokens ?? false }),
      );
      return { user_id: id, revoked_tokens: revoked };
    },
  );

  app.get(
    '/admin/users/:id/tokens',
    {
      schema: {
        params: IdParams,
        response: { 200: Type.Object({ items: Type.Array(TokenInfoSchema) }), ...errorResponses },
      },
    },
    async (request) => {
      return withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        if (!(await getUser(client, request.params.id))) throw notFound('user not found');
        return { items: await listUserTokens(client, request.params.id) };
      });
    },
  );

  app.post(
    '/admin/users/:id/tokens',
    {
      schema: { params: IdParams, body: CreateTokenBody, response: { 201: TokenSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const token = await withTransaction(app.pg, principalOf(request), request.id, async (client) => {
        if (!(await getUser(client, request.params.id))) throw notFound('user not found');
        return issueToken(client, {
          userId: request.params.id,
          name: request.body.name,
          expiresAt: request.body.expires_at ?? null,
        });
      });
      return reply.status(201).send(token);
    },
  );

  app.delete(
    '/admin/tokens/:id',
    { schema: { params: IdParams, response: { 204: Type.Null(), ...errorResponses } } },
    async (request, reply) => {
      const found = await withTransaction(app.pg, principalOf(request), request.id, (client) =>
        revokeToken(client, request.params.id),
      );
      if (!found) throw notFound('token not found');
      return reply.status(204).send(null);
    },
  );
};
