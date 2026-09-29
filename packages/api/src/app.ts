import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import { parsePublicBasePath, parseRegistrationRole, type AuthConfig } from './config.js';
import { ApiError } from './lib/errors.js';
import { authPlugin } from './plugins/auth.js';
import { dbPlugin } from './plugins/db.js';
import { openApiPlugin } from './plugins/openapi.js';
import { registerErrorHandlers } from './plugins/errors.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { derivedRoutes } from './routes/derived/index.js';
import { scholarlyRoutes } from './routes/scholarly/index.js';
import { statsRoutes } from './routes/stats.js';

export interface BuildAppOptions {
  /** Connection pool; owned by the caller (not closed by app.close()). */
  pool: Pool;
  logger?: FastifyServerOptions['logger'];
  /** Maximum items per batch request (MAX_BATCH_ITEMS); default 5000. */
  maxBatchItems?: number;
  /**
   * Registration/login settings. Defaults: registration closed, role reader, 12 h web,
   * 720 h (30 days) MCP and 12 h CLI login tokens, no rate limit, OIDC off (the server passes the env-based
   * config, see config.ts).
   */
  auth?: Partial<AuthConfig>;
  /** Fastify `trustProxy` (TRUST_PROXY); decides `request.ip` for the auth rate limit. */
  trustProxy?: boolean | string;
  /**
   * Public path prefix added by a reverse proxy (PUBLIC_BASE_PATH, e.g. '/api'); default '' (served at the root).
   * Sets the OpenAPI `servers` entry and the Swagger UI asset URLs; the routes themselves stay at the root.
   */
  publicBasePath?: string;
}

const DEFAULT_AUTH: AuthConfig = {
  registrationOpen: false,
  registrationDefaultRole: 'reader',
  loginTokenTtlHours: 12,
  mcpLoginTokenTtlHours: 720,
  cliLoginTokenTtlHours: 12,
  rateLimit: null,
  oidc: null,
};

export async function buildApp({
  pool,
  logger = false,
  maxBatchItems = 5000,
  auth,
  trustProxy = false,
  publicBasePath = '',
}: BuildAppOptions) {
  const authConfig: AuthConfig = { ...DEFAULT_AUTH, ...auth };
  const basePath = parsePublicBasePath(publicBasePath); // normalises and validates
  // Fail at startup, not at the first registration.
  parseRegistrationRole(authConfig.registrationDefaultRole);
  for (const key of ['loginTokenTtlHours', 'mcpLoginTokenTtlHours', 'cliLoginTokenTtlHours'] as const) {
    if (!Number.isInteger(authConfig[key]) || !(authConfig[key] > 0)) throw new Error(`${key} must be a positive integer`);
  }
  if (authConfig.oidc && (!authConfig.oidc.issuer || authConfig.oidc.clientIds.length === 0)) {
    throw new Error('OIDC needs an issuer and at least one client id (OIDC_ISSUER, OIDC_CLIENT_IDS)');
  }

  const app = Fastify({
    logger,
    trustProxy,
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024 * 1024, // batch endpoints post large arrays
  })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  registerErrorHandlers(app);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    // Behind a prefix-stripping proxy, root-relative redirects (e.g. Swagger UI's
    // /docs/static/index.html -> /docs/) must point back under the prefix. Done here rather than in the
    // proxy so every proxy (nginx, Traefik's stripprefix) behaves the same.
    if (basePath) {
      const location = reply.getHeader('location');
      if (typeof location === 'string' && location.startsWith('/') && !location.startsWith('//')) {
        reply.header('location', basePath + location);
      }
    }
  });

  await app.register(dbPlugin, { pool });
  await app.register(authPlugin);
  await app.register(openApiPlugin, { publicBasePath: basePath }); // before the routes it documents
  if (authConfig.rateLimit) {
    // Only routes with `config.rateLimit` (register/login/oidc) are limited; in-memory, per IP.
    await app.register(rateLimit, {
      global: false,
      errorResponseBuilder: (_request, context) =>
        new ApiError(429, 'rate_limited', `too many requests; retry in ${context.after}`),
    });
  }

  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(authRoutes, { auth: authConfig });
  await app.register(statsRoutes);
  await app.register(adminRoutes);
  await app.register(scholarlyRoutes);
  await app.register(derivedRoutes, { maxBatchItems });

  await app.ready();
  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
