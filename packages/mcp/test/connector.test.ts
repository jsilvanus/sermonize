/**
 * SermonizeClient against a stub HTTP server: auth header passthrough, query/path encoding,
 * JSON bodies, and mapping of API error JSON / transport failures to SermonizeApiError.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { describeApiError, SermonizeApiError, SermonizeClient, toQueryString } from '../src/connector.js';

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  forwardedFor?: string | string[] | undefined;
  body: unknown;
}

let stub: FastifyInstance;
let baseUrl: string;
let seen: Seen[] = [];
const ctx = { apiToken: 'smz_test_token_123' };

beforeAll(async () => {
  stub = Fastify();
  stub.addHook('onRequest', async (request) => {
    seen.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
      forwardedFor: request.headers['x-forwarded-for'],
      body: undefined,
    });
  });
  stub.addHook('preHandler', async (request) => {
    seen[seen.length - 1]!.body = request.body;
  });
  stub.get('/me', async () => ({ user_id: 'u1', role: 'reader', kind: 'human' }));
  stub.get('/persons', async () => ({ items: [], next_cursor: null }));
  stub.get('/texts/:id/body', async () => ({ text_id: 't', start: 0, end: 1, content: 'x' }));
  stub.get('/clusters/:id/labels', async () => ({ items: [], next_cursor: null }));
  stub.post('/persons', async (request, reply) => reply.code(201).send({ id: 'p1', ...(request.body as object) }));
  stub.post('/clusters/:id/labels', async (_request, reply) =>
    reply.code(403).send({ error: { code: 'forbidden', message: 'requires role contributor or higher' } }),
  );
  stub.post('/labels/:id/reviews', async (_request, reply) =>
    reply.code(422).send({ error: { code: 'validation_failed', message: 'bad review', details: { field: 'decision' } } }),
  );
  stub.get('/works/:id', async (_request, reply) => reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid, expired or revoked token' } }));
  stub.get('/sources/:id', async (_request, reply) => reply.code(502).type('text/html').send('<html>bad gateway</html>'));
  stub.post('/auth/login', async (request) => ({
    token: 'sz_login',
    expires_at: '2030-01-01T00:00:00.000Z',
    user_id: 'u1',
    role: 'reader',
    echo: request.body,
  }));
  stub.post('/auth/logout', async (_request, reply) => reply.code(204).send());
  stub.get('/slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {};
  });
  await stub.listen({ host: '127.0.0.1', port: 0 });
  const address = stub.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}/`; // trailing slash on purpose
});

afterAll(async () => {
  await stub.close();
});

beforeEach(() => {
  seen = [];
});

describe('SermonizeClient', () => {
  const client = () => new SermonizeClient({ baseUrl, timeoutMs: 2_000 });

  it('passes the user API token as a Bearer header and parses JSON', async () => {
    const me = await client().me(ctx);
    expect(me).toEqual({ user_id: 'u1', role: 'reader', kind: 'human' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/me', authorization: 'Bearer smz_test_token_123' });
  });

  it('encodes query parameters, omitting undefined ones', async () => {
    await client().listPersons(ctx, { q: 'Mel & anchthon/ä', include_withdrawn: true, limit: 5, cursor: undefined });
    const url = new URL(seen[0]!.url, 'http://x');
    expect(url.pathname).toBe('/persons');
    expect([...url.searchParams.entries()]).toEqual([
      ['q', 'Mel & anchthon/ä'],
      ['include_withdrawn', 'true'],
      ['limit', '5'],
    ]);

    await client().getTextBody(ctx, 'abc', { start: 0, end: 37 });
    expect(seen[1]!.url).toBe('/texts/abc/body?start=0&end=37');

    await client().listClusterLabels(ctx, 'c1', { language: 'fi', cursor: undefined, limit: undefined });
    expect(seen[2]!.url).toBe('/clusters/c1/labels?language=fi');
  });

  it('encodes path segments', async () => {
    await expect(client().getWork(ctx, '../admin?x=1')).rejects.toBeInstanceOf(SermonizeApiError);
    expect(seen[0]!.url).toBe('/works/..%2Fadmin%3Fx%3D1');
  });

  it('toQueryString', () => {
    expect(toQueryString(undefined)).toBe('');
    expect(toQueryString({ a: undefined })).toBe('');
    expect(toQueryString({ a: false, b: 0, c: 'x y' })).toBe('?a=false&b=0&c=x+y');
  });

  it('sends JSON bodies', async () => {
    const person = await client().createPerson(ctx, { display_name: 'Philipp Melanchthon', year_from: 1497 });
    expect(person).toEqual({ id: 'p1', display_name: 'Philipp Melanchthon', year_from: 1497 });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/persons',
      contentType: 'application/json',
      authorization: 'Bearer smz_test_token_123',
      body: { display_name: 'Philipp Melanchthon', year_from: 1497 },
    });
  });

  it('maps API error JSON to SermonizeApiError (403 explained)', async () => {
    const error = await client()
      .proposeLabel(ctx, 'c1', { language: 'fi', label: 'x', producer_kind: 'human' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SermonizeApiError);
    expect(error).toMatchObject({ status: 403, code: 'forbidden', message: 'requires role contributor or higher' });
    const text = describeApiError(error);
    expect(text).toContain('Sermonize API error forbidden (HTTP 403): requires role contributor or higher');
    expect(text).toContain('reader < contributor < curator < admin');
  });

  it('includes details and explains 401 without echoing the token', async () => {
    const e422 = await client().reviewLabel(ctx, 'l1', { decision: 'accepted' }).catch((e: unknown) => e);
    expect(e422).toMatchObject({ status: 422, code: 'validation_failed', details: { field: 'decision' } });
    expect(describeApiError(e422)).toContain('details: {"field":"decision"}');

    const e401 = await client().getWork(ctx, 'w1').catch((e: unknown) => e);
    expect(e401).toMatchObject({ status: 401, code: 'unauthorized' });
    const text = describeApiError(e401);
    expect(text).toContain('Please sign in again');
    expect(text).not.toContain(ctx.apiToken);
  });

  it("login posts client 'mcp' without a Bearer header and forwards the client IP; logout sends the token", async () => {
    const res = await client().login({ email: 'a@example.org', password: 'pw' }, '203.0.113.9');
    expect(res).toMatchObject({ token: 'sz_login', user_id: 'u1', role: 'reader' });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/auth/login', authorization: undefined, forwardedFor: '203.0.113.9' });
    expect(seen[0]!.body).toEqual({ email: 'a@example.org', password: 'pw', client: 'mcp' });
    await client().logout('sz_login');
    expect(seen[1]).toMatchObject({ method: 'POST', url: '/auth/logout', authorization: 'Bearer sz_login' });
  });

  it('maps non-JSON error responses to http_<status>', async () => {
    const error = await client().getSource(ctx, 's1').catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: 'http_502' });
  });

  it('times out', async () => {
    const slow = new SermonizeClient({ baseUrl, timeoutMs: 100 });
    const error = await slow.request(ctx, 'GET', '/slow').catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: 'timeout' });
  });

  it('reports an unreachable API', async () => {
    const down = new SermonizeClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 });
    const error = await down.me(ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: 'upstream_unavailable' });
    expect(describeApiError(error)).not.toContain(ctx.apiToken);
  });
});
