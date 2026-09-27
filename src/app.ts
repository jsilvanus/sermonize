import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Pool } from 'pg';
import { authPlugin } from './plugins/auth.js';
import { dbPlugin } from './plugins/db.js';
import { registerErrorHandlers } from './plugins/errors.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { scholarlyRoutes } from './routes/scholarly/index.js';

export interface BuildAppOptions {
  /** Connection pool; owned by the caller (not closed by app.close()). */
  pool: Pool;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp({ pool, logger = false }: BuildAppOptions) {
  const app = Fastify({
    logger,
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024 * 1024, // batch endpoints (Phase 3) post large arrays
  })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  registerErrorHandlers(app);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(dbPlugin, { pool });
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(adminRoutes);
  await app.register(scholarlyRoutes);

  await app.ready();
  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
