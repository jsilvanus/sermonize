import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { forbidden, unauthorized } from '../lib/errors.js';
import { hasRole, type Principal, type Role } from '../lib/principal.js';
import { hashToken } from '../lib/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated caller, or null for public routes called without a token. */
    principal: Principal | null;
  }
  interface FastifyContextConfig {
    /** Route is reachable without authentication (GET /health and the /docs routes). */
    public?: boolean;
  }
}

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/**
 * Resolves `Authorization: Bearer <token>` to `request.principal` through
 * private.resolve_token(). A present-but-invalid token is always a 401; a
 * missing token is a 401 on every route not marked `config: { public: true }`.
 */
export const authPlugin = fp(
  async (app) => {
    app.decorateRequest('principal', null);

    app.addHook('onRequest', async (request) => {
      const header = request.headers.authorization;
      if (header !== undefined) {
        const token = BEARER.exec(header)?.[1];
        if (!token) throw unauthorized('malformed Authorization header; expected "Bearer <token>"');
        const { rows } = await app.pg.query<{ user_id: string; role: Role; kind: Principal['kind'] }>(
          'SELECT user_id, role, kind FROM private.resolve_token($1)',
          [hashToken(token)],
        );
        const row = rows[0];
        if (!row) throw unauthorized('invalid, expired or revoked token');
        request.principal = { userId: row.user_id, role: row.role, kind: row.kind };
      }
      if (request.principal === null && request.routeOptions.config?.public !== true) {
        throw unauthorized();
      }
    });
  },
  { name: 'auth', dependencies: [] },
);

/** preHandler hook: requires an authenticated principal with at least `role`. */
export function requireRole(role: Role) {
  return async function checkRole(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.principal) throw unauthorized();
    if (!hasRole(request.principal, role)) throw forbidden(`requires role ${role} or higher`);
  };
}

/** The request's principal; throws 401 if absent (for handlers behind requireRole). */
export function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) throw unauthorized();
  return request.principal;
}
