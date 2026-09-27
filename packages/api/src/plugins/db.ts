import fp from 'fastify-plugin';
import type { Pool } from 'pg';

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared connection pool. Reads may use it directly; writes go through withTransaction(). */
    pg: Pool;
  }
}

/** Decorates the app with the pool. The caller owns the pool and must end it. */
export const dbPlugin = fp<{ pool: Pool }>(
  async (app, { pool }) => {
    app.decorate('pg', pool);
  },
  { name: 'db' },
);
