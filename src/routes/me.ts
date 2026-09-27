import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { principalOf, requireRole } from '../plugins/auth.js';
import { errorResponses, RoleSchema, UserKindSchema, Uuid } from './schemas.js';

/** GET /me: the caller's own principal (lets scripts verify a token). */
export const meRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/me',
    {
      preHandler: requireRole('reader'),
      schema: {
        response: {
          200: Type.Object({ user_id: Uuid, role: RoleSchema, kind: UserKindSchema }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const p = principalOf(request);
      return { user_id: p.userId, role: p.role, kind: p.kind };
    },
  );
};
