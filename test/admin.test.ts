import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/tokens.js';
import { api, createUser, setupTestApp, type TestContext, type TestUser } from './helpers.js';

describe('admin routes', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await createUser(ctx.pool, { role: 'admin' });
    other = await createUser(ctx.pool, { role: 'curator' });
  });
  afterAll(() => ctx.close());

  it('POST /admin/users creates a user, ignores created_by and never returns PII', async () => {
    const res = await api(ctx.app, admin, {
      method: 'POST',
      url: '/admin/users',
      payload: {
        kind: 'human',
        role: 'contributor',
        email: 'scholar@example.org',
        display_name: 'A. Scholar',
        created_by: other.id, // must be ignored
        updated_by: other.id,
        id: '11111111-1111-4111-8111-111111111111',
      },
    });
    expect(res.statusCode).toBe(201);
    const user = res.json();
    expect(user).toMatchObject({ kind: 'human', role: 'contributor', status: 'active' });
    expect(user.created_by).toBe(admin.id);
    expect(user.updated_by).toBe(admin.id);
    expect(user.id).not.toBe('11111111-1111-4111-8111-111111111111');
    expect(res.body).not.toContain('scholar@example.org');
    expect(res.body).not.toContain('A. Scholar');

    const pii = await ctx.pool.query('SELECT email, display_name FROM private.user_pii WHERE user_id = $1', [user.id]);
    expect(pii.rows[0]).toEqual({ email: 'scholar@example.org', display_name: 'A. Scholar' });

    const audit = await ctx.pool.query(
      `SELECT action, entity_type, actor_id, request_id, changes FROM audit_event
        WHERE entity_id = $1 ORDER BY occurred_at, id`,
      [user.id],
    );
    expect(audit.rows.map((r) => [r.action, r.entity_type])).toEqual([
      ['insert', 'app_user'],
      ['pii_update', 'user_pii'],
    ]);
    for (const row of audit.rows) {
      expect(row.actor_id).toBe(admin.id);
      expect(row.request_id).toBe(res.headers['x-request-id']);
      expect(JSON.stringify(row.changes)).not.toMatch(/scholar@example\.org|A\. Scholar/);
    }
    expect(audit.rows[1].changes).toEqual({ fields: ['email', 'display_name'] });
  });

  it('POST /admin/users validates the body', async () => {
    const bad = [
      { kind: 'robot', role: 'reader' },
      { kind: 'human', role: 'superuser' },
      { kind: 'human', role: 'reader', email: 'not-an-email' },
      { role: 'reader' },
    ];
    for (const payload of bad) {
      const res = await api(ctx.app, admin, { method: 'POST', url: '/admin/users', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_failed');
    }
  });

  it('issues a token that authenticates, stores only its hash, and can be revoked', async () => {
    const created = await api(ctx.app, admin, {
      method: 'POST',
      url: '/admin/users',
      payload: { kind: 'service', role: 'contributor' },
    });
    const userId = created.json().id;

    const res = await api(ctx.app, admin, {
      method: 'POST',
      url: `/admin/users/${userId}/tokens`,
      payload: { name: 'embedding script' },
    });
    expect(res.statusCode).toBe(201);
    const issued = res.json();
    expect(issued).toMatchObject({ user_id: userId, name: 'embedding script', expires_at: null });
    expect(issued.token).toMatch(/^sz_/);

    const stored = await ctx.pool.query('SELECT token_sha256 FROM private.api_token WHERE id = $1', [issued.id]);
    expect(stored.rows[0].token_sha256).toBe(hashToken(issued.token));
    expect(stored.rows[0].token_sha256).not.toContain(issued.token);

    const me = await api(ctx.app, issued.token, { method: 'GET', url: '/me' });
    expect(me.json()).toEqual({ user_id: userId, role: 'contributor', kind: 'service' });

    const del = await api(ctx.app, admin, { method: 'DELETE', url: `/admin/tokens/${issued.id}` });
    expect(del.statusCode).toBe(204);
    expect((await api(ctx.app, issued.token, { method: 'GET', url: '/me' })).statusCode).toBe(401);

    const audit = await ctx.pool.query(
      `SELECT action, changes FROM audit_event WHERE entity_type = 'api_token' AND entity_id = $1 ORDER BY id`,
      [issued.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['token_create', 'token_revoke']);
    expect(JSON.stringify(audit.rows)).not.toContain(stored.rows[0].token_sha256);
  });

  it('token endpoints return 404 for unknown ids and 400 for malformed ids', async () => {
    const unknown = '0190a000-0000-7000-8000-000000000001';
    const t = await api(ctx.app, admin, {
      method: 'POST',
      url: `/admin/users/${unknown}/tokens`,
      payload: { name: 'x' },
    });
    expect(t.statusCode).toBe(404);
    expect((await api(ctx.app, admin, { method: 'DELETE', url: `/admin/tokens/${unknown}` })).statusCode).toBe(404);
    expect((await api(ctx.app, admin, { method: 'DELETE', url: '/admin/tokens/not-a-uuid' })).statusCode).toBe(400);
  });

  it('honours expires_at', async () => {
    const res = await api(ctx.app, admin, {
      method: 'POST',
      url: `/admin/users/${other.id}/tokens`,
      payload: { name: 'old', expires_at: '2001-01-01T00:00:00Z' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().expires_at).toBe('2001-01-01T00:00:00.000Z');
    expect((await api(ctx.app, res.json().token, { method: 'GET', url: '/me' })).statusCode).toBe(401);
  });
});
