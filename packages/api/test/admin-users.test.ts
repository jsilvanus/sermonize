/**
 * Account administration (private.admin_* functions, src/routes/admin.ts): listing with PII,
 * PATCH with its guards, admin-set passwords and token listings.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/tokens.js';
import { issueToken } from '../src/lib/users.js';
import { AUDIT_ORDER, api, asSystem, createUser, setupTestApp, SYSTEM_PRINCIPAL, type TestContext, type TestUser } from './helpers.js';

const PASSWORD = 'a long enough admin-set password';
const run = randomUUID().slice(0, 8);
let seq = 0;
const uniqueEmail = (prefix = 'managed') => `${prefix}.${run}.${++seq}@Example.org`;

describe('admin user management', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let curator: TestUser;

  beforeAll(async () => {
    ctx = await setupTestApp();
    admin = await createUser(ctx.pool, { role: 'admin' });
    curator = await createUser(ctx.pool, { role: 'curator' });
  });
  afterAll(() => ctx.close());

  async function create(payload: Record<string, unknown>) {
    const res = await api(ctx.app, admin, { method: 'POST', url: '/admin/users', payload });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string };
  }
  const login = (email: string, password = PASSWORD) =>
    api(ctx.app, null, { method: 'POST', url: '/auth/login', payload: { email, password, client: 'cli' } });

  /** Every audit event about `userId` and everything in its app_user row, as text. */
  async function publicTrace(userId: string): Promise<string> {
    const audit = await ctx.pool.query(
      `SELECT action, entity_type, changes FROM audit_event WHERE entity_id = $1 OR changes->>'user_id' = $1::text`,
      [userId],
    );
    const row = await ctx.pool.query('SELECT to_jsonb(u) AS j FROM app_user u WHERE id = $1', [userId]);
    return JSON.stringify([audit.rows, row.rows]);
  }

  it('every endpoint is admin-only', async () => {
    const id = curator.id;
    const calls = [
      { method: 'GET', url: '/admin/users' },
      { method: 'GET', url: `/admin/users/${id}` },
      { method: 'PATCH', url: `/admin/users/${id}`, payload: { role: 'admin' } },
      { method: 'PUT', url: `/admin/users/${id}/password`, payload: { password: PASSWORD } },
      { method: 'GET', url: `/admin/users/${id}/tokens` },
      { method: 'POST', url: `/admin/users/${id}/tokens`, payload: { name: 'x' } },
      { method: 'POST', url: '/admin/users', payload: { kind: 'human', role: 'admin' } },
    ] as const;
    for (const call of calls) {
      const res = await api(ctx.app, curator, call);
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(403);
      expect((await api(ctx.app, null, call)).statusCode).toBe(401);
    }
    const me = await api(ctx.app, curator, { method: 'GET', url: '/me' });
    expect(me.json().role).toBe('curator');
  });

  it('POST /admin/users accepts a password; the user can sign in; nothing leaks', async () => {
    const email = uniqueEmail();
    const user = await create({ kind: 'human', role: 'contributor', email, display_name: 'Pat Admin-Made', password: PASSWORD });
    const res = await login(email.toLowerCase());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ user_id: user.id, role: 'contributor' });

    const trace = await publicTrace(user.id);
    expect(trace).not.toMatch(new RegExp(`${email}|Pat Admin-Made|argon2|${PASSWORD}`, 'i'));
    const audit = await ctx.pool.query(
      `SELECT action, changes FROM audit_event WHERE entity_id = $1 AND action = 'password_set'`,
      [user.id],
    );
    expect(audit.rows).toEqual([{ action: 'password_set', changes: { via: 'admin', revoke_tokens: false } }]);
  });

  it('POST /admin/users refuses passwords for service accounts, without email, or of the wrong length', async () => {
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ kind: 'service', role: 'contributor', email: uniqueEmail(), password: PASSWORD }, 422],
      [{ kind: 'human', role: 'reader', password: PASSWORD }, 422],
      [{ kind: 'human', role: 'reader', email: uniqueEmail(), password: 'short' }, 400],
      [{ kind: 'human', role: 'reader', email: uniqueEmail(), password: 'x'.repeat(257) }, 400],
    ];
    for (const [payload, status] of cases) {
      const res = await api(ctx.app, admin, { method: 'POST', url: '/admin/users', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(status);
      expect(res.body).not.toContain(PASSWORD);
    }
  });

  it('GET /admin/users lists with PII, filters, q and keyset pagination; reads are audited', async () => {
    const tag = `list${run}`;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const u = await create({
        kind: i === 4 ? 'service' : 'human',
        role: i % 2 ? 'curator' : 'reader',
        email: `${tag}.${i}@example.org`,
        display_name: `Lister ${tag} ${i}`,
        ...(i === 0 && { password: PASSWORD }),
      });
      ids.push(u.id);
    }
    const all = await api(ctx.app, admin, { method: 'GET', url: `/admin/users?q=${tag.toUpperCase()}` });
    expect(all.statusCode, all.body).toBe(200);
    const items = all.json().items as Array<Record<string, unknown>>;
    expect(items.map((u) => u.id)).toEqual(ids);
    expect(items[0]).toEqual({
      id: ids[0],
      kind: 'human',
      role: 'reader',
      status: 'active',
      email: `${tag}.0@example.org`,
      display_name: `Lister ${tag} 0`,
      has_password: true,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(items[1]!.has_password).toBe(false);
    expect(all.body).not.toMatch(/argon2|password_hash|token_sha256/);

    // Display name match, filters
    const byName = await api(ctx.app, admin, { method: 'GET', url: `/admin/users?q=${encodeURIComponent(`lister ${tag} 3`)}` });
    expect(byName.json().items.map((u: { id: string }) => u.id)).toEqual([ids[3]]);
    const curators = await api(ctx.app, admin, { method: 'GET', url: `/admin/users?q=${tag}&role=curator` });
    expect(curators.json().items.map((u: { id: string }) => u.id)).toEqual([ids[1], ids[3]]);
    const services = await api(ctx.app, admin, { method: 'GET', url: `/admin/users?q=${tag}&kind=service` });
    expect(services.json().items.map((u: { id: string }) => u.id)).toEqual([ids[4]]);
    // LIKE metacharacters are literal
    expect((await api(ctx.app, admin, { method: 'GET', url: `/admin/users?q=${tag}%25` })).json().items).toEqual([]);

    // Pagination
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/admin/users?q=${tag}&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await api(ctx.app, admin, { method: 'GET', url });
      expect(page.statusCode, page.body).toBe(200);
      seen.push(...page.json().items.map((u: { id: string }) => u.id));
      cursor = page.json().next_cursor;
    } while (cursor);
    expect(seen).toEqual(ids);
    expect((await api(ctx.app, admin, { method: 'GET', url: '/admin/users?cursor=bm9wZQ' })).statusCode).toBe(400);
    expect((await api(ctx.app, admin, { method: 'GET', url: '/admin/users?role=root' })).statusCode).toBe(400);

    // The read is audited without the search text.
    const audit = await ctx.pool.query(
      `SELECT batch_count, changes FROM audit_event WHERE action = 'pii_read' AND request_id = $1`,
      [curators.headers['x-request-id']],
    );
    expect(audit.rows).toEqual([{ batch_count: 2, changes: { role: 'curator', q: true } }]);
  });

  it('GET /admin/users/:id includes token counts; GET /admin/users/:id/tokens lists metadata only', async () => {
    const email = uniqueEmail();
    const user = await create({ kind: 'human', role: 'reader', email, password: PASSWORD });
    const t1 = await api(ctx.app, admin, { method: 'POST', url: `/admin/users/${user.id}/tokens`, payload: { name: 'script', expires_at: '2099-01-01T00:00:00Z' } });
    expect(t1.statusCode).toBe(201);
    expect(t1.json()).toMatchObject({ name: 'script', expires_at: '2099-01-01T00:00:00.000Z' });
    const t2 = await api(ctx.app, admin, { method: 'POST', url: `/admin/users/${user.id}/tokens`, payload: { name: 'old', expires_at: '2001-01-01T00:00:00Z' } });
    const t3 = await api(ctx.app, admin, { method: 'POST', url: `/admin/users/${user.id}/tokens`, payload: { name: 'gone' } });
    await api(ctx.app, admin, { method: 'DELETE', url: `/admin/tokens/${t3.json().id}` });
    await login(email);

    const res = await api(ctx.app, admin, { method: 'GET', url: `/admin/users/${user.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: user.id, email, has_password: true, tokens: { total: 4, active: 2, expired: 1, revoked: 1 } });

    const list = await api(ctx.app, admin, { method: 'GET', url: `/admin/users/${user.id}/tokens` });
    expect(list.statusCode).toBe(200);
    const tokens = list.json().items;
    expect(tokens.map((t: { name: string; state: string }) => [t.name, t.state])).toEqual([
      ['script', 'active'],
      ['old', 'expired'],
      ['gone', 'revoked'],
      ['cli', 'active'],
    ]);
    expect(Object.keys(tokens[0]).sort()).toEqual(['created_at', 'created_by', 'expires_at', 'id', 'name', 'revoked_at', 'state']);
    for (const t of [t1, t2, t3]) {
      expect(list.body).not.toContain(t.json().token);
      expect(list.body).not.toContain(hashToken(t.json().token));
    }

    const unknown = '0190a000-0000-7000-8000-00000000abcd';
    expect((await api(ctx.app, admin, { method: 'GET', url: `/admin/users/${unknown}` })).statusCode).toBe(404);
    expect((await api(ctx.app, admin, { method: 'GET', url: `/admin/users/${unknown}/tokens` })).statusCode).toBe(404);
    expect((await api(ctx.app, admin, { method: 'GET', url: '/admin/users/nope' })).statusCode).toBe(400);
  });

  it('PATCH /admin/users/:id changes role, status and PII; audits without PII values', async () => {
    const email = uniqueEmail();
    const newEmail = uniqueEmail('renamed');
    const user = await create({ kind: 'human', role: 'reader', email, display_name: 'Old Name', password: PASSWORD });
    const patch = (payload: object) => api(ctx.app, admin, { method: 'PATCH', url: `/admin/users/${user.id}`, payload });

    const promoted = await patch({ role: 'curator' });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(promoted.json()).toMatchObject({ role: 'curator', email, display_name: 'Old Name' });

    const renamed = await patch({ display_name: 'New Name' });
    expect(renamed.json()).toMatchObject({ email, display_name: 'New Name' });
    const moved = await patch({ email: newEmail });
    expect(moved.json()).toMatchObject({ email: newEmail, display_name: 'New Name' });
    expect((await patch({ display_name: null })).json().display_name).toBeNull();
    expect((await login(newEmail)).statusCode).toBe(200);
    expect((await login(email)).statusCode).toBe(401);

    // Duplicate email: 409 without echoing it
    const other = await create({ kind: 'human', role: 'reader', email: uniqueEmail() });
    const dup = await api(ctx.app, admin, { method: 'PATCH', url: `/admin/users/${other.id}`, payload: { email: newEmail.toUpperCase() } });
    expect(dup.statusCode).toBe(409);
    expect(dup.body.toLowerCase()).not.toContain(newEmail.toLowerCase());

    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ role: 'root' })).statusCode).toBe(400);
    expect((await patch({ email: 'not-an-email' })).statusCode).toBe(400);

    const audit = await ctx.pool.query(
      `SELECT action, entity_type, changes FROM audit_event WHERE entity_id = $1 AND action IN ('update', 'pii_update') ORDER BY ${AUDIT_ORDER}`,
      [user.id],
    );
    expect(audit.rows).toEqual([
      { action: 'pii_update', entity_type: 'user_pii', changes: { fields: ['email', 'display_name'] } }, // creation
      { action: 'update', entity_type: 'app_user', changes: { role: { old: 'reader', new: 'curator' } } },
      { action: 'pii_update', entity_type: 'user_pii', changes: { fields: ['display_name'], via: 'admin' } },
      { action: 'pii_update', entity_type: 'user_pii', changes: { fields: ['email'], via: 'admin' } },
      { action: 'pii_update', entity_type: 'user_pii', changes: { fields: ['display_name'], via: 'admin' } },
    ]);
    expect(await publicTrace(user.id)).not.toMatch(new RegExp(`${email}|${newEmail}|Old Name|New Name`, 'i'));
  });

  it('disabling takes effect at once (tokens stop resolving, login fails); enabling restores', async () => {
    const email = uniqueEmail();
    const user = await create({ kind: 'human', role: 'reader', email, password: PASSWORD });
    const token = (await login(email)).json().token;
    expect((await api(ctx.app, token, { method: 'GET', url: '/me' })).statusCode).toBe(200);

    const off = await api(ctx.app, admin, { method: 'PATCH', url: `/admin/users/${user.id}`, payload: { status: 'disabled' } });
    expect(off.json().status).toBe('disabled');
    expect((await api(ctx.app, token, { method: 'GET', url: '/me' })).statusCode).toBe(401);
    expect((await login(email)).statusCode).toBe(401);

    await api(ctx.app, admin, { method: 'PATCH', url: `/admin/users/${user.id}`, payload: { status: 'active' } });
    expect((await api(ctx.app, token, { method: 'GET', url: '/me' })).statusCode).toBe(200);
    const audit = await ctx.pool.query(
      `SELECT changes FROM audit_event WHERE entity_id = $1 AND action = 'update' ORDER BY ${AUDIT_ORDER}`,
      [user.id],
    );
    expect(audit.rows.map((r) => r.changes.status)).toEqual([
      { old: 'active', new: 'disabled' },
      { old: 'disabled', new: 'active' },
    ]);
  });

  it('guards: no self-demotion/disabling, the system user is fixed, the last active admin stays', async () => {
    const self = await api(ctx.app, admin, { method: 'PATCH', url: `/admin/users/${admin.id}`, payload: { role: 'curator' } });
    expect(self.statusCode).toBe(409);
    expect(self.json().error).toMatchObject({ code: 'conflict', details: { reason: 'self' } });
    const selfOff = await api(ctx.app, admin, { method: 'PATCH', url: `/admin/users/${admin.id}`, payload: { status: 'disabled' } });
    expect(selfOff.json().error.details.reason).toBe('self');
    // Harmless self-changes are fine.
    expect((await api(ctx.app, admin, { method: 'PATCH', url: `/admin/users/${admin.id}`, payload: { role: 'admin', display_name: 'Me' } })).statusCode).toBe(200);

    const sys = await api(ctx.app, admin, { method: 'PATCH', url: `/admin/users/${SYSTEM_PRINCIPAL.userId}`, payload: { status: 'disabled' } });
    expect(sys.statusCode).toBe(409);
    expect(sys.json().error.details.reason).toBe('system_user');
    expect((await api(ctx.app, admin, { method: 'PUT', url: `/admin/users/${SYSTEM_PRINCIPAL.userId}/password`, payload: { password: PASSWORD } })).statusCode).toBe(422);

    // Last active admin: only reachable by a caller that is not a counted admin itself,
    // i.e. a token of the system user (e.g. from `npm run cli -- create-token`).
    const systemToken = await asSystem(ctx.pool, (c) => issueToken(c, { userId: SYSTEM_PRINCIPAL.userId, name: 'test' }));
    const { rows } = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role = 'admin' AND status = 'active' AND id NOT IN ($1, $2)`,
      [SYSTEM_PRINCIPAL.userId, admin.id],
    );
    const others = rows.map((r) => r.id);
    await asSystem(ctx.pool, (c) => c.query(`UPDATE app_user SET status = 'disabled' WHERE id = ANY($1)`, [others]));
    try {
      const last = await api(ctx.app, systemToken.token, { method: 'PATCH', url: `/admin/users/${admin.id}`, payload: { role: 'reader' } });
      expect(last.statusCode).toBe(409);
      expect(last.json().error).toMatchObject({ code: 'conflict', details: { reason: 'last_admin' } });
      const lastOff = await api(ctx.app, systemToken.token, { method: 'PATCH', url: `/admin/users/${admin.id}`, payload: { status: 'disabled' } });
      expect(lastOff.json().error.details.reason).toBe('last_admin');
      // With a second admin it works.
      const second = await create({ kind: 'human', role: 'admin' });
      const ok = await api(ctx.app, systemToken.token, { method: 'PATCH', url: `/admin/users/${second.id}`, payload: { role: 'curator' } });
      expect(ok.statusCode).toBe(200);
    } finally {
      await asSystem(ctx.pool, (c) => c.query(`UPDATE app_user SET status = 'active' WHERE id = ANY($1)`, [others]));
      await asSystem(ctx.pool, (c) => c.query('SELECT private.revoke_api_token($1)', [systemToken.id]));
    }
  });

  it('PUT /admin/users/:id/password sets a password and optionally revokes tokens', async () => {
    const email = uniqueEmail();
    const user = await create({ kind: 'human', role: 'reader', email });
    expect((await login(email)).statusCode).toBe(401);
    const put = (payload: object, id = user.id) =>
      api(ctx.app, admin, { method: 'PUT', url: `/admin/users/${id}/password`, payload });

    const first = await put({ password: PASSWORD });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ user_id: user.id, revoked_tokens: 0 });
    const token = (await login(email)).json().token;
    const scriptToken = (await api(ctx.app, admin, { method: 'POST', url: `/admin/users/${user.id}/tokens`, payload: { name: 's' } })).json().token;

    const second = await put({ password: `${PASSWORD} v2`, revoke_tokens: true });
    expect(second.json()).toEqual({ user_id: user.id, revoked_tokens: 2 });
    expect(second.body).not.toContain(PASSWORD);
    expect((await api(ctx.app, token, { method: 'GET', url: '/me' })).statusCode).toBe(401);
    expect((await api(ctx.app, scriptToken, { method: 'GET', url: '/me' })).statusCode).toBe(401);
    expect((await login(email)).statusCode).toBe(401);
    expect((await login(email, `${PASSWORD} v2`)).statusCode).toBe(200);

    expect((await put({ password: 'short' })).statusCode).toBe(400);
    expect((await put({ password: PASSWORD }, '0190a000-0000-7000-8000-00000000abcd')).statusCode).toBe(404);
    const svc = await create({ kind: 'service', role: 'contributor', email: uniqueEmail() });
    const svcRes = await put({ password: PASSWORD }, svc.id);
    expect(svcRes.statusCode).toBe(422);
    const noEmail = await create({ kind: 'human', role: 'reader' });
    expect((await put({ password: PASSWORD }, noEmail.id)).statusCode).toBe(422);

    const audit = await ctx.pool.query(
      `SELECT action, changes FROM audit_event WHERE (entity_id = $1 AND action = 'password_set') OR (action = 'token_revoke' AND changes->>'user_id' = $1::text) ORDER BY ${AUDIT_ORDER}`,
      [user.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['password_set', 'password_set', 'token_revoke', 'token_revoke']);
    expect(audit.rows[1].changes).toEqual({ via: 'admin', revoke_tokens: true });
    expect(audit.rows[2].changes).toMatchObject({ via: 'password_set' });
    expect(await publicTrace(user.id)).not.toMatch(/argon2|admin-set password/);
  });
});
