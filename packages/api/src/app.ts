import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import { parseRegistrationRole, type AuthConfig } from './config.js';
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
   * Registration/login settings. Defaults: registration closed, role reader, 12 h login
   * tokens, no rate limit (the server passes the env-based config, see config.ts).
   */
  auth?: Partial<AuthConfig>;
  /** Fastify `trustProxy` (TRUST_PROXY); decides `request.ip` for the auth rate limit. */
  trustProxy?: boolean | string;
}

const DEFAULT_AUTH: AuthConfig = {
  registrationOpen: false,
  registrationDefaultRole: 'reader',
  loginTokenTtlHours: 12,
  rateLimit: null,
};

export async function buildApp({ pool, logger = false, maxBatchItems = 5000, auth, trustProxy = false }: BuildAppOptions) {
  const authConfig: AuthConfig = { ...DEFAULT_AUTH, ...auth };
  // Fail at startup, not at the first registration.
  parseRegistrationRole(authConfig.registrationDefaultRole);
  if (!(authConfig.loginTokenTtlHours > 0)) throw new Error('loginTokenTtlHours must be positive');

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
  });

  await app.register(dbPlugin, { pool });
  await app.register(authPlugin);
  await app.register(openApiPlugin); // before the routes it documents
  if (authConfig.rateLimit) {
    // Only routes with `config.rateLimit` (register/login) are limited; in-memory, per IP.
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
