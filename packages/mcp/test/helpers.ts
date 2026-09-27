import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { decodeJwt } from 'jose';
import { buildMcpApp, type AppConfig, type McpApp } from '../src/app.js';

export const PUBLIC_URL = 'http://mcp.test';
/** The CIMD client the test resolver knows (no network access: see `resolveClient` below). */
export const CLIENT_ID = 'https://client.example/oauth/client.json';
export const REDIRECT_URI = 'https://client.example/oauth/callback';

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface FormResponse {
  status: number;
  body: string;
  headers: Headers;
}

export interface McpTestServer {
  url: string;
  config: AppConfig;
  app: McpApp;
  /** A second connection to the SQLite file, for assertions. */
  db: DatabaseSync;
  /** GET /oauth/authorize with a fresh PKCE pair; returns the sign-in page's `oauth` value. */
  authorizePage(): Promise<{ oauth: string; verifier: string; page: FormResponse }>;
  /** POSTs the sign-in form. On success the consent page (with its ticket) is returned. */
  submitCredentials(oauth: string, email: string, password: string, headers?: Record<string, string>): Promise<FormResponse & { ticket?: string }>;
  /** POSTs the consent form; returns the redirect's status and location. */
  consent(oauth: string, ticket: string, action?: 'approve' | 'deny'): Promise<{ status: number; location: URL | null }>;
  /** POST /oauth/token (form-encoded). */
  token(form: Record<string, string>): Promise<{ status: number; body: any }>;
  /** The whole code + PKCE flow for a Sermonize account; throws unless every step succeeds. */
  signIn(email: string, password: string, headers?: Record<string, string>): Promise<Tokens>;
  /** A connected MCP client using this access token. */
  connect(accessToken: string): Promise<Client>;
  /** POST /mcp tools/list with this access token (raw HTTP, to observe 401s). */
  rawMcp(accessToken: string): Promise<Response>;
  close(): Promise<void>;
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };

/** Starts the MCP HTTP server on an ephemeral port, relaying to `sermonizeApiUrl`. */
export async function startMcpServer(
  sermonizeApiUrl: string,
  opts: { trustProxy?: boolean | string; publicUrl?: string } = {},
): Promise<McpTestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'sermonize-mcp-test-'));
  const publicUrl = opts.publicUrl ?? PUBLIC_URL;
  const config: AppConfig = {
    publicUrl,
    jwtSecret: randomBytes(32),
    storagePath: join(dir, 'app.sqlite'),
    sermonizeApiUrl,
    tokenKey: randomBytes(32),
    requestTimeoutMs: 5_000,
    trustProxy: opts.trustProxy ?? false,
  };
  const app = await buildMcpApp(config, {
    sweepIntervalMs: 0,
    resolveClient: async (clientId) => {
      if (clientId !== CLIENT_ID) throw new Error('unknown client');
      return { client_id: CLIENT_ID, client_name: 'Test Client', redirect_uris: [REDIRECT_URI] };
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const url = `http://127.0.0.1:${address.port}`;
  const db = new DatabaseSync(config.storagePath);
  const clients: Client[] = [];

  async function read(res: Response): Promise<FormResponse> {
    return { status: res.status, body: await res.text(), headers: res.headers };
  }

  const server: McpTestServer = {
    url,
    config,
    app,
    db,
    async authorizePage() {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'state-123',
        scope: 'mcp',
        resource: publicUrl + '/mcp',
      });
      const page = await read(await fetch(`${url}/oauth/authorize?${query}`));
      const oauth = /name="oauth" value="([^"]+)"/.exec(page.body)?.[1];
      if (page.status !== 200 || !oauth) throw new Error(`authorize page failed: ${page.status}`);
      return { oauth, verifier, page };
    },
    async submitCredentials(oauth, email, password, headers = {}) {
      const res = await read(
        await fetch(`${url}/oauth/authorize`, {
          method: 'POST',
          headers: { ...FORM_HEADERS, ...headers },
          body: form({ oauth, email, password }),
        }),
      );
      const ticket = /name="ticket" value="([^"]+)"/.exec(res.body)?.[1];
      return ticket ? { ...res, ticket } : res;
    },
    async consent(oauth, ticket, action = 'approve') {
      const res = await fetch(`${url}/oauth/authorize`, {
        method: 'POST',
        headers: FORM_HEADERS,
        body: form({ oauth, ticket, action }),
        redirect: 'manual',
      });
      await res.text();
      const location = res.headers.get('location');
      return { status: res.status, location: location ? new URL(location) : null };
    },
    async token(fields) {
      const res = await fetch(`${url}/oauth/token`, { method: 'POST', headers: FORM_HEADERS, body: form(fields) });
      return { status: res.status, body: await res.json() };
    },
    async signIn(email, password, headers) {
      const { oauth, verifier } = await server.authorizePage();
      const signIn = await server.submitCredentials(oauth, email, password, headers);
      if (!signIn.ticket) throw new Error(`sign-in failed: ${signIn.status}`);
      const { status, location } = await server.consent(oauth, signIn.ticket);
      const code = location?.searchParams.get('code');
      if (status !== 302 || !code) throw new Error(`consent failed: ${status}`);
      const res = await server.token({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      if (res.status !== 200) throw new Error(`token exchange failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body as Tokens;
    },
    async connect(accessToken) {
      const transport = new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      const client = new Client({ name: 'sermonize-mcp-test', version: '0.0.0' });
      await client.connect(transport);
      clients.push(client);
      return client;
    },
    rawMcp(accessToken) {
      return fetch(url + '/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    },
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return server;
}

/** The grant id (`sid`) inside an access token. */
export function grantIdOf(accessToken: string): string {
  const sid = decodeJwt(accessToken).sid;
  if (typeof sid !== 'string') throw new Error('access token without sid');
  return sid;
}

/** Calls a tool and returns its text content and error flag. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  return { isError: res.isError === true, text, meta: res._meta };
}

/** Calls a tool that must succeed and parses its JSON result. */
export async function callJson<T = Record<string, any>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { isError, text } = await call(client, name, args);
  if (isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as T;
}
