import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

export const DOCS_PREFIX = '/docs';

/** Groups operations in the UI by the first path segment (`/clustering-runs/:id` -> clustering-runs). */
function tagOf(url: string): string {
  const first = url.split('/').find((s) => s.length > 0) ?? 'root';
  return first === 'admin' ? 'admin' : first;
}

export interface OpenApiOptions {
  /**
   * Path prefix under which a reverse proxy publishes the API (e.g. '/api'), normalised by
   * `parsePublicBasePath`; '' when the API is served at the root. It becomes the document's
   * `servers` entry (so "Try it out" and generated clients call `/api/...`) and the prefix of the
   * Swagger UI asset URLs on `/docs` (the page is then reached as `<prefix>/docs`).
   */
  publicBasePath?: string;
}

/**
 * OpenAPI 3 document generated from the route schemas (@fastify/swagger) and
 * Swagger UI at /docs (JSON at /docs/json). The documentation routes are public;
 * every other route requires a bearer token unless marked `config.public`.
 * Must be registered before the routes it documents.
 */
export const openApiPlugin = fp(
  async (app: FastifyInstance, opts: OpenApiOptions) => {
    const basePath = opts.publicBasePath ?? '';
    // The docs routes are registered by swagger-ui; mark them public for the auth hook.
    app.addHook('onRoute', (route) => {
      if (route.url === DOCS_PREFIX || route.url.startsWith(`${DOCS_PREFIX}/`)) {
        route.config = { ...(route.config ?? {}), public: true };
      }
    });

    await app.register(swagger, {
      openapi: {
        openapi: '3.0.3',
        info: {
          title: 'Sermonize API',
          version: '1.0.0',
          description:
            'Multilingual theological-text corpus and semantic research API (data only). ' +
            'Every route except /health, /docs, /stats, /auth/config, /auth/register and /auth/login ' +
            'requires `Authorization: Bearer <token>`. ' +
            'Errors: `{ "error": { "code", "message", "details"? } }`.',
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', description: 'API token (create with the CLI or POST /admin/users/:id/tokens).' },
          },
        },
        security: [{ bearerAuth: [] }],
        ...(basePath ? { servers: [{ url: basePath, description: 'this deployment (behind a reverse proxy)' }] } : {}),
      },
      transform: ({ schema, url, route }) => {
        const isPublic = (route.config as { public?: boolean } | undefined)?.public === true;
        const transformed = {
          ...(schema ?? {}),
          tags: [tagOf(url)],
          ...(isPublic ? { security: [] } : {}),
        };
        return { schema: transformed, url };
      },
    });

    // `indexPrefix` only changes the absolute asset URLs of `GET /docs` (no trailing slash) to
    // `<basePath>/docs/static/...`; `/docs/` uses relative URLs and `./json` is resolved in the browser.
    await app.register(swaggerUi, { routePrefix: DOCS_PREFIX, ...(basePath ? { indexPrefix: basePath } : {}) });
  },
  { name: 'openapi' },
);
