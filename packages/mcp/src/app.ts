import Fastify, { type FastifyServerOptions } from 'fastify';
import formbody from '@fastify/formbody';
import { hash } from '@node-rs/argon2';
import type { McpConfig } from './config.js';
import { SermonizeClient } from './connector.js';
import { mountMcpHttp } from './mcp/http.js';
import { mountOAuthMetadata } from './oauth-metadata.js';
import { mountAuthorizationServer } from './oauth/authorization-server.js';
import { SqliteApiTokenStore } from './storage/api-tokens.js';
import { SqliteAuthStore, SqliteUserStore } from './storage/sqlite.js';

export type AppConfig = Pick<
  McpConfig,
  'publicUrl' | 'jwtSecret' | 'storagePath' | 'defaultUser' | 'sermonizeApiUrl' | 'tokenKey' | 'requestTimeoutMs'
>;

/** Builds the MCP server (OAuth AS + protected /mcp resource); the caller listens and closes. */
export async function buildMcpApp(config: AppConfig, logger: FastifyServerOptions['logger'] = false) {
  const store = new SqliteAuthStore(config.storagePath);
  const users = new SqliteUserStore(store.getDatabase());
  const apiTokens = new SqliteApiTokenStore(store.getDatabase(), config.tokenKey);

  const { id, email, password } = config.defaultUser;
  if (!users.getUser(id)) {
    users.createUser({ id, name: 'Demo User', email, passwordHash: await hash(password, { algorithm: 2 }), createdAt: Date.now() });
  }

  const app = Fastify({ logger });
  await app.register(formbody);

  const resource = config.publicUrl + '/mcp';
  await mountOAuthMetadata(app, config.publicUrl);
  await mountAuthorizationServer(app, config.publicUrl, resource, config.jwtSecret, store, users);
  await mountMcpHttp(app, {
    client: new SermonizeClient({ baseUrl: config.sermonizeApiUrl, timeoutMs: config.requestTimeoutMs }),
    apiTokens,
    publicUrl: config.publicUrl,
    jwtSecret: config.jwtSecret,
    resource,
  });

  app.get('/health', async () => ({ ok: true }));
  app.addHook('onClose', async () => store.getDatabase().close());
  return app;
}
