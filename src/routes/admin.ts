import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { withTransaction } from '../db/transaction.js';
import { notFound } from '../lib/errors.js';
import { createUser, getUser, issueToken, revokeToken } from '../lib/users.js';
import { principalOf, requireRole } from '../plugins/auth.js';
import { errorResponses, IdParams, RoleSchema, UserKindSchema, Uuid } from './schemas.js';

const UserStatus = Type.Union([Type.Literal('active'), Type.Literal('disabled')]);

const AppUserSchema = Type.Object({
  id: Uuid,
  kind: UserKindSchema,
  role: RoleSchema,
  status: UserStatus,
  created_by: Uuid,
  created_at: Type.String({ format: 'date-time' }),
  updated_by: Uuid,
  updated_at: Type.String({ format: 'date-time' }),
});

// PII is accepted here and stored in private.user_pii; it is never returned.
const CreateUserBody = Type.Object({
  kind: UserKindSchema,
  role: RoleSchema,
  status: Type.Optional(UserStatus),
  email: Type.Optional(Type.String({ format: 'email', maxLength: 320 })),
  display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

const CreateTokenBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  expires_at: Type.Optional(Type.String({ format: 'date-time' })),
});

const TokenSchema = Type.Object({
  id: Uuid,
  user_id: Uuid,
  name: Type.String(),
  expires_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  token: Type.String({ description: 'Shown once. Only its SHA-256 is stored.' }),
});

export const adminRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', requireRole('admin'));

  app.post(
    '/admin/users',
    { schema: { body: CreateUserBody, response: { 201: AppUserSchema, ...errorResponses } } },
    async (request, reply) => {
      const { kind, role, status, email, display_name } = request.body;
      const user = await withTransaction(app.pg, principalOf(request), request.id, (client) =>
        createUser(client, { kind, role, status, email, displayName: display_name }),
      );
      return reply.status(201).send(user);
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
