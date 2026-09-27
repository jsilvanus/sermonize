/**
 * The MCP HTTP surface against a stub Sermonize API: discovery, the 401 challenge, sign-in through
 * the API (`POST /auth/login`, client mcp) with error mapping and X-Forwarded-For, grants and their
 * upstream tokens, the registered tools and their annotations, and ending grants.
 */
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SIGN_IN_AGAIN } from '../src/connector.js';
import { issueAccessToken } from '../src/oauth/jwt.js';
import { TOOL_ROLES } from '../src/mcp/server.js';
import { call, callJson, CLIENT_ID, grantIdOf, PUBLIC_URL, REDIRECT_URI, startMcpServer, type McpTestServer } from './helpers.js';

const READ_TOOLS = [
  'whoami',
  'search_persons',
  'get_person',
  'list_works',
  'get_work',
  'list_sources',
  'get_source',
  'list_texts',
  'get_text',
  'get_text_body',
  'get_chunk',
  'get_chunk_provenance',
  'list_embedding_spaces',
  'get_embedding_space',
  'semantic_search',
  'list_clustering_runs',
  'get_clustering_run',
  'list_run_clusters',
  'get_cluster',
  'list_cluster_members',
  'list_cluster_labels',
  'get_cluster_provenance',
];
const WRITE_TOOLS = ['create_person', 'create_work', 'create_source', 'create_text', 'propose_label', 'review_label'];

const PASSWORD = 'right password, long enough';
let stub: FastifyInstance;
let stubUrl: string;
let mcp: McpTestServer;
let proxied: McpTestServer; // TRUST_PROXY=true
const seenAuth: (string | undefined)[] = [];
const logins: { body: any; forwardedFor: string | undefined }[] = [];
const logouts: string[] = [];
/** Tokens the stub API rejects with 401 (revoked / user disabled). */
const rejected = new Set<string>();
let tokenSeq = 0;

beforeAll(async () => {
  stub = Fastify();
  stub.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/auth/')) seenAuth.push(request.headers.authorization);
  });
  stub.post('/auth/login', async (request, reply) => {
    const body = request.body as { email: string; password: string; client?: string };
    logins.push({ body, forwardedFor: request.headers['x-forwarded-for'] as string | undefined });
    const local = body.email.split('@')[0]!;
    if (local === 'limited') return reply.code(429).send({ error: { code: 'rate_limited', message: 'too many requests' } });
    if (local === 'broken') return reply.code(500).send({ error: { code: 'internal', message: 'boom' } });
    if (body.password !== PASSWORD) return reply.code(401).send({ error: { code: 'invalid_credentials', message: 'invalid email or password' } });
    const hours = local === 'short' ? 2 : 720;
    return {
      token: `${local}-api-token-${++tokenSeq}`,
      expires_at: new Date(Date.now() + hours * 3_600_000).toISOString(),
      user_id: `uid-${local}`,
      role: 'reader',
    };
  });
  stub.post('/auth/logout', async (request, reply) => {
    logouts.push(String(request.headers.authorization).replace('Bearer ', ''));
    return reply.code(204).send();
  });
  stub.get('/me', async (request, reply) => {
    const token = String(request.headers.authorization).replace('Bearer ', '');
    if (rejected.has(token)) return reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid or expired token' } });
    return { user_id: `id-for-${token.replace(/-\d+$/, '')}`, role: 'reader', kind: 'human' };
  });
  stub.post('/search', async (request) => ({ echo: request.body }));
  await stub.listen({ host: '127.0.0.1', port: 0 });
  const address = stub.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  stubUrl = `http://127.0.0.1:${address.port}`;
  mcp = await startMcpServer(stubUrl);
  proxied = await startMcpServer(stubUrl, { trustProxy: true });
});

afterAll(async () => {
  await mcp?.close();
  await proxied?.close();
  await stub?.close();
});

beforeEach(() => {
  logins.length = 0;
  logouts.length = 0;
});

describe('HTTP surface', () => {
  it('serves protected resource metadata', async () => {
    const res = await fetch(mcp.url + '/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resource: PUBLIC_URL + '/mcp', authorization_servers: [PUBLIC_URL] });
  });

  it('answers /mcp without a valid token with 401 + WWW-Authenticate', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const anonymous = await fetch(mcp.url + '/mcp', { method: 'POST', headers, body });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain(`resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`);

    const invalid = await fetch(mcp.url + '/mcp', { method: 'POST', headers: { ...headers, authorization: 'Bearer nope' }, body });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('rejects correctly signed access tokens without an active grant', async () => {
    const withoutGrant = await issueAccessToken(mcp.config.jwtSecret, PUBLIC_URL, PUBLIC_URL + '/mcp', 'uid-x', CLIENT_ID, 'mcp');
    expect((await mcp.rawMcp(withoutGrant)).status).toBe(401);
    const unknownGrant = await issueAccessToken(mcp.config.jwtSecret, PUBLIC_URL, PUBLIC_URL + '/mcp', 'uid-x', CLIENT_ID, 'mcp', {
      grantId: 'no-such-grant',
    });
    expect((await mcp.rawMcp(unknownGrant)).status).toBe(401);
  });
});

describe('sign-in through the Sermonize API', () => {
  it('renders the sign-in page with a CSP', async () => {
    const { page } = await mcp.authorizePage();
    expect(page.body).toContain('Sermonize account');
    expect(page.body).toContain('name="password"');
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self'");
  });

  it('verifies email + password with POST /auth/login (client mcp); the subject is the API user id', async () => {
    const tokens = await mcp.signIn('alice@example.org', PASSWORD);
    expect(logins).toHaveLength(1);
    expect(logins[0]!.body).toEqual({ email: 'alice@example.org', password: PASSWORD, client: 'mcp' });
    const claims = decodeJwt(tokens.access_token);
    expect(claims).toMatchObject({ sub: 'uid-alice', iss: PUBLIC_URL, aud: PUBLIC_URL + '/mcp', client_id: CLIENT_ID, scope: 'mcp' });
    expect(claims.sid).toEqual(expect.any(String));
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, refresh_token: expect.any(String) });

    // Neither the password nor the API token is stored in plain text.
    const file = readFileSync(mcp.config.storagePath);
    expect(file.includes(PASSWORD)).toBe(false);
    expect(file.includes('alice-api-token')).toBe(false);
  });

  it('shows a generic error for wrong credentials and a friendly one for 429 and API failures', async () => {
    const { oauth } = await mcp.authorizePage();
    const wrong = await mcp.submitCredentials(oauth, 'alice@example.org', 'wrong password');
    expect(wrong.status).toBe(401);
    expect(wrong.body).toContain('Invalid email or password.');
    expect(wrong.body).toContain('value="alice@example.org"');
    expect(wrong.body).not.toContain('wrong password');
    expect(wrong.ticket).toBeUndefined();

    const limited = await mcp.submitCredentials(oauth, 'limited@example.org', PASSWORD);
    expect(limited.status).toBe(429);
    expect(limited.body).toContain('Too many sign-in attempts');

    const broken = await mcp.submitCredentials(oauth, 'broken@example.org', PASSWORD);
    expect(broken.status).toBe(503);
    expect(broken.body).toContain('cannot be reached');

    const empty = await mcp.submitCredentials(oauth, '', '');
    expect(empty.status).toBe(400);
    expect(mcp.db.prepare('SELECT count(*) AS n FROM grants').get()).toEqual({ n: 1 }); // only alice's, from the test above
  });

  it('forwards the client IP as X-Forwarded-For, trusting proxies only with TRUST_PROXY', async () => {
    const xff = { 'x-forwarded-for': '203.0.113.7' };
    const direct = await mcp.authorizePage();
    await mcp.submitCredentials(direct.oauth, 'nobody@example.org', 'x', xff);
    const viaProxy = await proxied.authorizePage();
    await proxied.submitCredentials(viaProxy.oauth, 'nobody@example.org', 'x', xff);
    // Without TRUST_PROXY the header is ignored and the socket address is forwarded.
    expect(logins.map((l) => l.forwardedFor)).toEqual(['127.0.0.1', '203.0.113.7']);
  });

  it('denying at the consent step redirects with access_denied and revokes the API token', async () => {
    const { oauth } = await mcp.authorizePage();
    const signIn = await mcp.submitCredentials(oauth, 'dora@example.org', PASSWORD);
    expect(signIn.status).toBe(200);
    expect(signIn.body).toContain('Test Client');
    expect(signIn.body).toContain('dora@example.org');
    expect(signIn.headers.get('content-security-policy')).toContain('form-action \'self\' https://client.example');
    const { status, location } = await mcp.consent(oauth, signIn.ticket!, 'deny');
    expect(status).toBe(302);
    expect(location?.origin + location!.pathname).toBe(REDIRECT_URI);
    expect(location?.searchParams.get('error')).toBe('access_denied');
    expect(location?.searchParams.get('state')).toBe('state-123');
    expect(logouts).toEqual([expect.stringMatching(/^dora-api-token-/)]);
    // The ticket is single-use.
    expect((await mcp.consent(oauth, signIn.ticket!)).status).toBe(400);
  });

  it('a ticket only works for the OAuth request it was issued for', async () => {
    const first = await mcp.authorizePage();
    const second = await mcp.authorizePage();
    const signIn = await mcp.submitCredentials(first.oauth, 'erin@example.org', PASSWORD);
    expect((await mcp.consent(second.oauth, signIn.ticket!)).status).toBe(400);
    expect((await mcp.consent(first.oauth, 'forged-ticket')).status).toBe(400);
    expect((await mcp.consent(first.oauth, signIn.ticket!)).status).toBe(302);
  });

  it('sweeps sign-ins that were never approved and revokes their API tokens', async () => {
    const { oauth } = await mcp.authorizePage();
    const signIn = await mcp.submitCredentials(oauth, 'frank@example.org', PASSWORD);
    expect(signIn.ticket).toBeDefined();
    expect(await mcp.app.sessions.sweep()).toBe(0);
    expect(await mcp.app.sessions.sweep(Date.now() + 11 * 60_000)).toBeGreaterThanOrEqual(1);
    expect(logouts).toContainEqual(expect.stringMatching(/^frank-api-token-/));
    expect((await mcp.consent(oauth, signIn.ticket!)).status).toBe(400);
  });

  it('caps the refresh token and access token at the API token expiry', async () => {
    const tokens = await mcp.signIn('short@example.org', PASSWORD); // the stub issues a 2-hour API token
    const apiExpires = Date.now() + 2 * 3_600_000;
    const row = mcp.db.prepare('SELECT expires FROM refresh_tokens WHERE token = ?').get(tokens.refresh_token) as { expires: number };
    expect(row.expires).toBeLessThanOrEqual(apiExpires);
    expect(row.expires).toBeGreaterThan(apiExpires - 60_000);
    const refreshed = await mcp.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLIENT_ID });
    expect(refreshed.status).toBe(200);
    expect(decodeJwt(refreshed.body.access_token).sid).toBe(grantIdOf(tokens.access_token));

    // Past the grant's end the refresh token is refused and the API token revoked.
    await mcp.app.sessions.sweep(Date.now() + 3 * 3_600_000);
    expect(logouts).toContainEqual(expect.stringMatching(/^short-api-token-/));
    const late = await mcp.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLIENT_ID });
    expect(late).toEqual({ status: 400, body: { error: 'invalid_grant' } });
  });
});

describe('tools', () => {
  it('registers exactly the documented tools with read/write annotations', async () => {
    const client = await mcp.connect((await mcp.signIn('alice@example.org', PASSWORD)).access_token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    for (const t of tools) {
      const write = WRITE_TOOLS.includes(t.name);
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: !write, destructiveHint: false, openWorldHint: false });
      expect(t.description, t.name).toContain(`Requires Sermonize role ${TOOL_ROLES[t.name]} or higher.`);
    }
    expect(TOOL_ROLES.review_label).toBe('curator');
    expect(TOOL_ROLES.create_text).toBe('contributor');
    expect(TOOL_ROLES.semantic_search).toBe('reader');
    const search = tools.find((t) => t.name === 'semantic_search')!;
    expect(search.description).toMatch(/never compute embeddings/);
    // No tool accepts a user identity or token as an argument.
    for (const t of tools) {
      expect(Object.keys(t.inputSchema.properties ?? {}), t.name).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/token|user_id|api_key/)]),
      );
    }
  });

  it("relays with the API token of the caller's own grant", async () => {
    const alice = await mcp.connect((await mcp.signIn('alice@example.org', PASSWORD)).access_token);
    const bob = await mcp.connect((await mcp.signIn('bob@example.org', PASSWORD)).access_token);
    seenAuth.length = 0;
    expect(await callJson(alice, 'whoami')).toMatchObject({ user_id: 'id-for-alice-api-token' });
    expect(await callJson(bob, 'whoami')).toMatchObject({ user_id: 'id-for-bob-api-token' });
    expect(seenAuth).toEqual([expect.stringMatching(/^Bearer alice-api-token-\d+$/), expect.stringMatching(/^Bearer bob-api-token-\d+$/)]);
  });

  it('passes arguments through and drops unknown ones', async () => {
    const alice = await mcp.connect((await mcp.signIn('alice@example.org', PASSWORD)).access_token);
    const res = await callJson(alice, 'semantic_search', {
      embedding_space_id: '0190a4d2-7b1c-7e3f-9a4b-2c1d0e9f8a7b',
      vector: [0.6, 0.8],
      filters: { genre: 'sermon' },
      user_id: 'someone-else',
    });
    expect(res).toEqual({
      echo: { embedding_space_id: '0190a4d2-7b1c-7e3f-9a4b-2c1d0e9f8a7b', vector: [0.6, 0.8], filters: { genre: 'sermon' } },
    });
  });

  it('validates arguments before calling the API', async () => {
    const alice = await mcp.connect((await mcp.signIn('alice@example.org', PASSWORD)).access_token);
    seenAuth.length = 0;
    const res = await call(alice, 'get_person', { person_id: 'not-a-uuid' });
    expect(res.isError).toBe(true);
    expect(seenAuth).toEqual([]);
  });

  it('an upstream 401 ends the grant: a sign-in-again error, then 401 on /mcp and invalid_grant on refresh', async () => {
    const tokens = await mcp.signIn('gina@example.org', PASSWORD);
    const gina = await mcp.connect(tokens.access_token);
    expect((await call(gina, 'whoami')).isError).toBe(false);

    const [apiToken] = seenAuth.slice(-1).map((h) => h!.replace('Bearer ', ''));
    rejected.add(apiToken!);
    const res = await call(gina, 'whoami');
    expect(res.isError).toBe(true);
    expect(res.text).toBe(SIGN_IN_AGAIN);
    expect((res.meta as Record<string, string[]>)['mcp/www_authenticate']![0]).toContain('error="invalid_token", error_description=');

    expect((await mcp.rawMcp(tokens.access_token)).status).toBe(401);
    const refreshed = await mcp.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLIENT_ID });
    expect(refreshed).toEqual({ status: 400, body: { error: 'invalid_grant' } });
    expect(mcp.db.prepare('SELECT count(*) AS n FROM grants WHERE id = ?').get(grantIdOf(tokens.access_token))).toEqual({ n: 0 });
  });
});
