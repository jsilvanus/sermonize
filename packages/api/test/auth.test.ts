import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, asSystem, createUser, setupTestApp, type TestContext, type TestUser } from './helpers.js';
import { revokeToken } from '../src/lib/users.js';

describe('authentication and roles', () => {
  let ctx: TestContext;
  let reader: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    ctx = await setupTestApp();
    reader = await createUser(ctx.pool, { role: 'reader' });
    admin = await createUser(ctx.pool, { role: 'admin' });
  });
  afterAll(() => ctx.close());

  it('GET /health is public', async () => {
    const res = await api(ctx.app, null, { method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('missing token -> 401 with the standard error format', async () => {
    const res = await api(ctx.app, null, { method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
  });

  it('unknown routes also require authentication', async () => {
    expect((await api(ctx.app, null, { method: 'GET', url: '/nope' })).statusCode).toBe(401);
    const res = await api(ctx.app, reader, { method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('malformed Authorization header -> 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Basic abc' } });
    expect(res.statusCode).toBe(401);
  });

  it('invalid token -> 401, even on public routes', async () => {
    expect((await api(ctx.app, 'sz_not-a-real-token', { method: 'GET', url: '/me' })).statusCode).toBe(401);
    expect((await api(ctx.app, 'sz_not-a-real-token', { method: 'GET', url: '/health' })).statusCode).toBe(401);
  });

  it('valid token -> principal', async () => {
    const res = await api(ctx.app, reader, { method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user_id: reader.id, role: 'reader', kind: 'human' });
  });

  it('revoked token -> 401', async () => {
    const user = await createUser(ctx.pool, { role: 'contributor' });
    expect((await api(ctx.app, user, { method: 'GET', url: '/me' })).statusCode).toBe(200);
    await asSystem(ctx.pool, (c) => revokeToken(c, user.tokenId));
    expect((await api(ctx.app, user, { method: 'GET', url: '/me' })).statusCode).toBe(401);
  });

  it('expired token -> 401', async () => {
    const user = await createUser(ctx.pool, { role: 'reader', tokenExpiresAt: '2000-01-01T00:00:00Z' });
    expect((await api(ctx.app, user, { method: 'GET', url: '/me' })).statusCode).toBe(401);
  });

  it('disabled user -> 401', async () => {
    const user = await createUser(ctx.pool, { role: 'admin', status: 'disabled' });
    expect((await api(ctx.app, user, { method: 'GET', url: '/me' })).statusCode).toBe(401);
  });

  it('insufficient role -> 403', async () => {
    for (const role of ['reader', 'contributor', 'curator'] as const) {
      const user = role === 'reader' ? reader : await createUser(ctx.pool, { role });
      const res = await api(ctx.app, user, {
        method: 'POST',
        url: '/admin/users',
        payload: { kind: 'human', role: 'reader' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    }
  });

  it('admin passes the role check', async () => {
    const res = await api(ctx.app, admin, {
      method: 'POST',
      url: '/admin/users',
      payload: { kind: 'service', role: 'contributor' },
    });
    expect(res.statusCode).toBe(201);
  });
});
