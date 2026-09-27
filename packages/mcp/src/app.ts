import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import formbody from '@fastify/formbody';
import type { McpConfig } from './config.js';
import { SermonizeClient } from './connector.js';
import { UpstreamSessions } from './grants.js';
import { mountMcpHttp } from './mcp/http.js';
import { mountOAuthMetadata } from './oauth-metadata.js';
import { mountAuthorizationServer, type ClientResolver } from './oauth/authorization-server.js';
import { SqliteGrantStore } from './storage/grants.js';
import { openDatabase, SqliteAuthStore } from './storage/sqlite.js';

export type AppConfig = Pick<
  McpConfig,
  'publicUrl' | 'jwtSecret' | 'storagePath' | 'sermonizeApiUrl' | 'tokenKey' | 'requestTimeoutMs'
> &
  Partial<Pick<McpConfig, 'trustProxy'>>;

export interface BuildMcpAppOptions {
  logger?: FastifyServerOptions['logger'];
  /** Resolves CIMD client ids; tests inject one (the default fetches the public HTTPS document). */
  resolveClient?: ClientResolver;
  /** How often ended grants are removed and their API tokens revoked (default 10 minutes; 0 disables). */
  sweepIntervalMs?: number;
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

  const resource = config.publicUrl + '/mcp';
  await mountOAuthMetadata(app, config.publicUrl);
  await mountAuthorizationServer(app, config.publicUrl, resource, config.jwtSecret, {
    authStore: store,
    sessions,
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
