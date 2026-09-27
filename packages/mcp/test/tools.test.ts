/**
 * The MCP HTTP surface against a stub Sermonize API: discovery, the 401 challenge, the registered
 * tools and their annotations, and per-user token mapping (a user's own token goes upstream;
 * users without one get a clear error).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_API_TOKEN_MESSAGE, TOOL_ROLES } from '../src/mcp/server.js';
import { call, callJson, PUBLIC_URL, startMcpServer, type McpTestServer } from './helpers.js';

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

let stub: FastifyInstance;
let mcp: McpTestServer;
const seenAuth: (string | undefined)[] = [];

beforeAll(async () => {
  stub = Fastify();
  stub.addHook('onRequest', async (request) => {
    seenAuth.push(request.headers.authorization);
  });
  stub.get('/me', async (request) => ({ user_id: `id-for-${request.headers.authorization}`, role: 'reader', kind: 'human' }));
  stub.post('/search', async (request) => ({ echo: request.body }));
  await stub.listen({ host: '127.0.0.1', port: 0 });
  const address = stub.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  mcp = await startMcpServer(`http://127.0.0.1:${address.port}`);
  mcp.addUser('alice', 'alice-api-token');
  mcp.addUser('bob', 'bob-api-token');
  mcp.addUser('carol');
});

afterAll(async () => {
  await mcp?.close();
  await stub?.close();
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
});

describe('tools', () => {
  it('registers exactly the documented tools with read/write annotations', async () => {
    const client = await mcp.connect('alice');
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

  it("relays with the calling user's own API token", async () => {
    const alice = await mcp.connect('alice');
    const bob = await mcp.connect('bob');
    seenAuth.length = 0;
    expect(await callJson(alice, 'whoami')).toMatchObject({ user_id: 'id-for-Bearer alice-api-token' });
    expect(await callJson(bob, 'whoami')).toMatchObject({ user_id: 'id-for-Bearer bob-api-token' });
    expect(seenAuth).toEqual(['Bearer alice-api-token', 'Bearer bob-api-token']);
  });

  it('passes arguments through and drops unknown ones', async () => {
    const alice = await mcp.connect('alice');
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
    const alice = await mcp.connect('alice');
    seenAuth.length = 0;
    const res = await call(alice, 'get_person', { person_id: 'not-a-uuid' });
    expect(res.isError).toBe(true);
    expect(seenAuth).toEqual([]);
  });

  it('returns a clear error for users without a linked API token', async () => {
    const carol = await mcp.connect('carol');
    seenAuth.length = 0;
    const res = await call(carol, 'whoami');
    expect(res).toEqual({ isError: true, text: NO_API_TOKEN_MESSAGE });
    expect(seenAuth).toEqual([]);
  });

  it('treats a user deleted after sign-in like a user without a token', async () => {
    const ghost = await mcp.connect('ghost-user');
    const res = await call(ghost, 'whoami');
    expect(res).toEqual({ isError: true, text: NO_API_TOKEN_MESSAGE });
  });
});
