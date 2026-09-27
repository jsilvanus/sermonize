import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';

export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/health',
    {
      config: { public: true },
      schema: {
        response: {
          200: Type.Object({ status: Type.Literal('ok'), database: Type.Literal('ok') }),
        },
      },
    },
    async () => {
      await app.pg.query('SELECT 1');
      return { status: 'ok' as const, database: 'ok' as const };
    },
  );
};
