import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpApp, type AppConfig } from '../src/app.js';
import { issueAccessToken } from '../src/oauth/jwt.js';
import { SqliteApiTokenStore } from '../src/storage/api-tokens.js';
import { SqliteAuthStore, SqliteUserStore } from '../src/storage/sqlite.js';

export const PUBLIC_URL = 'http://mcp.test';

export interface McpTestServer {
  url: string;
  config: AppConfig;
  /** Creates an MCP user, optionally linked to a Sermonize API token. */
  addUser(id: string, apiToken?: string): void;
  /** An access token as the embedded AS would issue it for `userId`. */
  accessToken(userId: string): Promise<string>;
  /** A connected MCP client for `userId`. */
  connect(userId: string): Promise<Client>;
  close(): Promise<void>;
}

/** Starts the MCP HTTP server on an ephemeral port, relaying to `sermonizeApiUrl`. */
export async function startMcpServer(sermonizeApiUrl: string): Promise<McpTestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'sermonize-mcp-test-'));
  const config: AppConfig = {
    publicUrl: PUBLIC_URL,
    jwtSecret: randomBytes(32),
    storagePath: join(dir, 'app.sqlite'),
    defaultUser: { id: 'demo-user', email: 'demo@example.com', password: 'demo-password' },
    sermonizeApiUrl,
    tokenKey: randomBytes(32),
    requestTimeoutMs: 5_000,
  };
  const app = await buildMcpApp(config);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const url = `http://127.0.0.1:${address.port}`;

  // A second connection to the same SQLite file, like the user CLI.
  const admin = new SqliteAuthStore(config.storagePath);
  const users = new SqliteUserStore(admin.getDatabase());
  const tokens = new SqliteApiTokenStore(admin.getDatabase(), config.tokenKey);
  const clients: Client[] = [];

  const server: McpTestServer = {
    url,
    config,
    addUser(id, apiToken) {
      users.createUser({ id, name: id, email: `${id}@example.org`, createdAt: Date.now() });
      if (apiToken !== undefined) tokens.set(id, apiToken);
    },
    accessToken(userId) {
      return issueAccessToken(config.jwtSecret, PUBLIC_URL, PUBLIC_URL + '/mcp', userId, 'https://client.example/cimd.json', 'mcp');
    },
    async connect(userId) {
      const token = await server.accessToken(userId);
      const transport = new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: 'sermonize-mcp-test', version: '0.0.0' });
      await client.connect(transport);
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
      await app.close();
      admin.getDatabase().close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return server;
}

/** Calls a tool and returns its text content and error flag. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  return { isError: res.isError === true, text };
}

/** Calls a tool that must succeed and parses its JSON result. */
export async function callJson<T = Record<string, any>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { isError, text } = await call(client, name, args);
  if (isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as T;
}
