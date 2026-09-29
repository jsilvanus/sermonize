import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import type { McpConfig } from './config.js';
import { SermonizeClient } from './connector.js';
import { UpstreamSessions } from './grants.js';
import { mountMcpHttp } from './mcp/http.js';
import { mountOAuthMetadata } from './oauth-metadata.js';
import { mountAuthorizationServer, type ClientResolver, type OidcOptions } from './oauth/authorization-server.js';
import { OidcRelyingParty, OidcStateStore } from './oauth/oidc.js';
import { SqliteGrantStore } from './storage/grants.js';
import { openDatabase, SqliteAuthStore } from './storage/sqlite.js';

export type AppConfig = Pick<
  McpConfig,
  'publicUrl' | 'jwtSecret' | 'storagePath' | 'sermonizeApiUrl' | 'tokenKey' | 'requestTimeoutMs'
> &
  Partial<Pick<McpConfig, 'trustProxy' | 'oidc'>>;

export interface BuildMcpAppOptions {
  logger?: FastifyServerOptions['logger'];
  /** Resolves CIMD client ids; tests inject one (the default fetches the public HTTPS document). */
  resolveClient?: ClientResolver;
  /** How often ended grants are removed and their API tokens revoked (default 10 minutes; 0 disables). */
  sweepIntervalMs?: number;
  /** Per-IP limit on /oidc/login and /oidc/callback (default 30 per minute; null disables it). */
  oidcRateLimit?: { max: number; timeWindow: number } | null;
}

/** The Fastify app plus its upstream sessions (exposed for tests and maintenance). */
export type McpApp = FastifyInstance & { sessions: UpstreamSessions };

/** Builds the MCP server (OAuth AS + protected /mcp resource); the caller listens and closes. */
export async function buildMcpApp(config: AppConfig, options: BuildMcpAppOptions = {}): Promise<McpApp> {
  const db = openDatabase(config.storagePath);
  const store = new SqliteAuthStore(db);

  const app = Fastify({ logger: options.logger ?? false, trustProxy: config.trustProxy ?? false });
  await app.register(formbody);

  const client = new SermonizeClient({ baseUrl: config.sermonizeApiUrl, timeoutMs: config.requestTimeoutMs });
  const sessions = new UpstreamSessions(new SqliteGrantStore(db, config.tokenKey), client, app.log);

  let oidc: OidcOptions | undefined;
  if (config.oidc) {
    const limit = options.oidcRateLimit === undefined ? { max: 30, timeWindow: 60_000 } : options.oidcRateLimit;
    // Only routes with `config.rateLimit` (the /oidc/* routes) are limited; in-memory, per IP.
    if (limit) await app.register(rateLimit, { global: false });
    oidc = {
      relyingParty: new OidcRelyingParty(config.oidc, config.publicUrl),
      states: new OidcStateStore(db),
      secureCookie: config.oidc.production || config.publicUrl.startsWith('https:'),
      rateLimit: limit ?? undefined,
    };
  }

  const resource = config.publicUrl + '/mcp';
  await mountOAuthMetadata(app, config.publicUrl);
  await mountAuthorizationServer(app, config.publicUrl, resource, config.jwtSecret, {
    authStore: store,
    sessions,
    oidc,
    ...(options.resolveClient ? { resolveClient: options.resolveClient } : {}),
  });
  await mountMcpHttp(app, {
    client,
    upstream: sessions,
    publicUrl: config.publicUrl,
    jwtSecret: config.jwtSecret,
    resource,
  });

  app.get('/health', async () => ({ ok: true }));

  const sweepIntervalMs = options.sweepIntervalMs ?? 10 * 60_000;
  if (sweepIntervalMs > 0) {
    app.addHook('onReady', async () => sessions.start(sweepIntervalMs));
  }
  app.addHook('onClose', async () => {
    sessions.stop();
    db.close();
  });
  return Object.assign(app as FastifyInstance, { sessions });
}
