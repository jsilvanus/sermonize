/**
 * Self-service password accounts (migration 0003, src/routes/auth.ts):
 * registration, login, logout, token expiry, rate limiting and PII hygiene.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadAuthConfig, loadConfig } from '../src/config.js';
import { hashToken } from '../src/lib/tokens.js';
import { createUser as createAppUser } from '../src/lib/users.js';
import { api, asSystem, createTestPool, setupTestApp, type TestContext } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const run = randomUUID().slice(0, 8);
let seq = 0;
/** A unique email per call (the test database is shared across files and runs). */
const uniqueEmail = (prefix = 'user') => `${prefix}.${run}.${++seq}@example.org`;

describe('password accounts', () => {
  let open: TestContext; // registration open, default role reader
  let closed: TestContext; // defaults: registration closed

  beforeAll(async () => {
    open = await setupTestApp({ auth: { registrationOpen: true } });
    closed = await setupTestApp();
  });
  afterAll(async () => {
    await open.close();
    await closed.close();
  });

  const register = (ctx: TestContext, payload: object) =>
    api(ctx.app, null, { method: 'POST', url: '/auth/register', payload });
  const login = (ctx: TestContext, email: string, password = PASSWORD) =>
    api(ctx.app, null, { method: 'POST', url: '/auth/login', payload: { email, password } });

  async function registered(displayName?: string) {
    const email = uniqueEmail();
    const res = await register(open, { email, password: PASSWORD, ...(displayName && { display_name: displayName }) });
    expect(res.statusCode, res.body).toBe(201);
    return { email, ...(res.json() as { user_id: string; role: string }) };
  }

  describe('configuration', () => {
    it('GET /auth/config is public and reports whether registration is open', async () => {
      const a = await api(open.app, null, { method: 'GET', url: '/auth/config' });
      expect(a.statusCode).toBe(200);
      expect(a.json()).toEqual({ registration_open: true, password_min_length: 12, password_max_length: 256 });
      expect((await api(closed.app, null, { method: 'GET', url: '/auth/config' })).json().registration_open).toBe(false);
    });

    it('REGISTRATION_DEFAULT_ROLE accepts only reader or contributor, default reader', () => {
      expect(loadAuthConfig({}).registrationDefaultRole).toBe('reader');
      expect(loadAuthConfig({}).registrationOpen).toBe(false);
      expect(loadAuthConfig({ REGISTRATION_DEFAULT_ROLE: 'contributor' }).registrationDefaultRole).toBe('contributor');
      for (const bad of ['curator', 'admin', 'Reader', 'nobody']) {
        expect(() => loadAuthConfig({ REGISTRATION_DEFAULT_ROLE: bad })).toThrow(/REGISTRATION_DEFAULT_ROLE/);
      }
      expect(() => loadConfig({ DATABASE_URL: 'postgres://x', REGISTRATION_DEFAULT_ROLE: 'admin' })).toThrow();
      expect(() => loadAuthConfig({ REGISTRATION_OPEN: 'yes' })).toThrow(/REGISTRATION_OPEN/);
      expect(loadAuthConfig({ REGISTRATION_OPEN: 'true' }).registrationOpen).toBe(true);
      expect(loadAuthConfig({ LOGIN_TOKEN_TTL_HOURS: '2' }).loginTokenTtlHours).toBe(2);
      expect(() => loadAuthConfig({ LOGIN_TOKEN_TTL_HOURS: '0' })).toThrow();
      expect(loadAuthConfig({}).rateLimit).toEqual({ max: 10, timeWindowMs: 60_000 });
      expect(loadAuthConfig({ AUTH_RATE_LIMIT_MAX: '0' }).rateLimit).toBeNull();
    });

    it('buildApp refuses an invalid default role at startup', async () => {
      const pool = createTestPool();
      try {
        await expect(
          buildApp({ pool, auth: { registrationDefaultRole: 'admin' as unknown as 'reader' } }),
        ).rejects.toThrow(/REGISTRATION_DEFAULT_ROLE/);
      } finally {
        await pool.end();
      }
    });
  });

  describe('POST /auth/register', () => {
    it('is 403 registration_closed unless REGISTRATION_OPEN', async () => {
      const res = await register(closed, { email: uniqueEmail(), password: PASSWORD });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('registration_closed');
    });

    it('creates an active human user with the default role; the user is its own actor', async () => {
      const { user_id, role } = await registered('A. Reader');
      expect(role).toBe('reader');
      const { rows } = await open.pool.query('SELECT kind, role, status, created_by, updated_by FROM app_user WHERE id = $1', [user_id]);
      expect(rows[0]).toEqual({ kind: 'human', role: 'reader', status: 'active', created_by: user_id, updated_by: user_id });
      const cred = await open.pool.query('SELECT password_hash FROM private.password_credential WHERE user_id = $1', [user_id]);
      expect(cred.rows[0].password_hash).toMatch(/^\$argon2id\$/);
      expect(cred.rows[0].password_hash).not.toContain(PASSWORD);
    });

    it('uses REGISTRATION_DEFAULT_ROLE=contributor', async () => {
      const ctx = await setupTestApp({ auth: { registrationOpen: true, registrationDefaultRole: 'contributor' } });
      try {
        const email = uniqueEmail('contrib');
        const res = await register(ctx, { email, password: PASSWORD });
        expect(res.statusCode).toBe(201);
        expect(res.json().role).toBe('contributor');
        const token = (await login(ctx, email)).json().token;
        expect((await api(ctx.app, token, { method: 'GET', url: '/me' })).json().role).toBe('contributor');
      } finally {
        await ctx.close();
      }
    });

    it('rejects a duplicate email (case-insensitive) with 409 without echoing it', async () => {
      const { email } = await registered();
      const res = await register(open, { email: email.toUpperCase(), password: PASSWORD });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('conflict');
      expect(res.body.toLowerCase()).not.toContain(email);
    });

    it('enforces password length (12..256 characters) and a valid email', async () => {
      const bad = async (payload: object) => {
        const res = await register(open, payload);
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().error.code).toBe('validation_failed');
      };
      await bad({ email: uniqueEmail(), password: 'a'.repeat(11) });
      await bad({ email: uniqueEmail(), password: 'a'.repeat(257) });
      await bad({ email: uniqueEmail() });
      await bad({ email: 'not-an-email', password: PASSWORD });
      await bad({ password: PASSWORD });
      expect((await register(open, { email: uniqueEmail(), password: 'a'.repeat(12) })).statusCode).toBe(201);
      expect((await register(open, { email: uniqueEmail(), password: 'b'.repeat(256) })).statusCode).toBe(201);
      // Counted in characters (code points), not UTF-16 units: 12 emoji are 24 units.
      expect((await register(open, { email: uniqueEmail(), password: '\u{1F54A}'.repeat(12) })).statusCode).toBe(201);
      await bad({ email: uniqueEmail(), password: '\u{1F54A}'.repeat(11) });
    });

    it('never returns PII', async () => {
      const email = uniqueEmail();
      const res = await register(open, { email, password: PASSWORD, display_name: 'Visible Name' });
      expect(Object.keys(res.json()).sort()).toEqual(['role', 'user_id']);
      expect(res.body).not.toContain(email);
      expect(res.body).not.toContain('Visible Name');
    });
  });

  describe('POST /auth/login and /auth/logout', () => {
    it('issues an expiring login token that works on /me', async () => {
      const { email, user_id } = await registered();
      const before = Date.now();
      const res = await login(open, email.toUpperCase());
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body).toEqual({ token: expect.stringMatching(/^sz_/), expires_at: expect.any(String), user_id, role: 'reader' });
      const expires = Date.parse(body.expires_at);
      expect(expires).toBeGreaterThanOrEqual(before + 12 * 3_600_000 - 1000);
      expect(expires).toBeLessThanOrEqual(Date.now() + 12 * 3_600_000 + 1000);
      const me = await api(open.app, body.token, { method: 'GET', url: '/me' });
      expect(me.json()).toEqual({ user_id, role: 'reader', kind: 'human' });

      const { rows } = await open.pool.query(
        'SELECT name, created_by, expires_at FROM private.api_token WHERE token_sha256 = $1',
        [hashToken(body.token)],
      );
      expect(rows[0]).toMatchObject({ name: 'login', created_by: user_id });
    });

    it('honours LOGIN_TOKEN_TTL_HOURS', async () => {
      const ctx = await setupTestApp({ auth: { loginTokenTtlHours: 1 } });
      try {
        const { email } = await registered();
        const res = await login(ctx, email);
        expect(Math.abs(Date.parse(res.json().expires_at) - (Date.now() + 3_600_000))).toBeLessThan(5000);
      } finally {
        await ctx.close();
      }
    });

    it('expired login tokens stop working', async () => {
      const { email } = await registered();
      const { token } = (await login(open, email)).json();
      expect((await api(open.app, token, { method: 'GET', url: '/me' })).statusCode).toBe(200);
      await open.pool.query(`UPDATE private.api_token SET expires_at = now() - interval '1 second' WHERE token_sha256 = $1`, [
        hashToken(token),
      ]);
      expect((await api(open.app, token, { method: 'GET', url: '/me' })).statusCode).toBe(401);
    });

    it('answers every failure with the same generic 401 invalid_credentials', async () => {
      const { email, user_id } = await registered();
      const disabled = await registered();
      await asSystem(open.pool, (c) => c.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [disabled.user_id]));
      // An admin-created user with an email but no password.
      const noPasswordEmail = uniqueEmail('nopw');
      await asSystem(open.pool, (c) => createAppUser(c, { kind: 'human', role: 'reader', email: noPasswordEmail }));

      const failures = [
        await login(open, email, 'wrong password, long enough'),
        await login(open, uniqueEmail('unknown')),
        await login(open, disabled.email),
        await login(open, noPasswordEmail),
        await login(open, email, 'x'),
      ];
      for (const res of failures) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: { code: 'invalid_credentials', message: 'invalid email or password' } });
      }
      expect((await login(open, '', PASSWORD)).statusCode).toBe(400);
      // No token was issued for any of them.
      const { rows } = await open.pool.query(
        'SELECT count(*)::int AS n FROM private.api_token WHERE user_id = ANY($1)',
        [[user_id, disabled.user_id]],
      );
      expect(rows[0].n).toBe(0);
    });

    it('logout revokes only the token used for the request', async () => {
      const { email } = await registered();
      const a = (await login(open, email)).json().token;
      const b = (await login(open, email)).json().token;
      expect((await api(open.app, null, { method: 'POST', url: '/auth/logout' })).statusCode).toBe(401);
      const res = await api(open.app, a, { method: 'POST', url: '/auth/logout' });
      expect(res.statusCode).toBe(204);
      expect((await api(open.app, a, { method: 'GET', url: '/me' })).statusCode).toBe(401);
      expect((await api(open.app, a, { method: 'POST', url: '/auth/logout' })).statusCode).toBe(401);
      expect((await api(open.app, b, { method: 'GET', url: '/me' })).statusCode).toBe(200);
    });

    it('rate-limits register and login per IP when configured', async () => {
      const ctx = await setupTestApp({ auth: { registrationOpen: true, rateLimit: { max: 2, timeWindowMs: 60_000 } } });
      try {
        const email = uniqueEmail();
        expect((await login(ctx, email)).statusCode).toBe(401);
        expect((await login(ctx, email)).statusCode).toBe(401);
        const limited = await login(ctx, email);
        expect(limited.statusCode).toBe(429);
        expect(limited.json().error.code).toBe('rate_limited');
        // Other routes are not limited.
        for (let i = 0; i < 3; i++) {
          expect((await api(ctx.app, null, { method: 'GET', url: '/auth/config' })).statusCode).toBe(200);
        }
        expect((await register(ctx, { email, password: PASSWORD })).statusCode).toBe(201);
        expect((await register(ctx, { email: uniqueEmail(), password: PASSWORD })).statusCode).toBe(201);
        expect((await register(ctx, { email: uniqueEmail(), password: PASSWORD })).statusCode).toBe(429);
      } finally {
        await ctx.close();
      }
    });
  });

  describe('PII hygiene', () => {
    it('audit events of registration, login and logout name the user but carry no PII', async () => {
      const displayName = `Secret Name ${run}`;
      const { email, user_id } = await registered(displayName);
      const { token } = (await login(open, email)).json();
      await api(open.app, token, { method: 'POST', url: '/auth/logout' });

      const { rows } = await open.pool.query(
        `SELECT actor_id, action, entity_type, entity_id, changes, request_id FROM audit_event
          WHERE actor_id = $1 ORDER BY id`,
        [user_id],
      );
      // Same-transaction events share a millisecond, so their UUIDv7 order is not meaningful.
      expect(rows.map((r) => `${r.action}:${r.entity_type}`).sort()).toEqual([
        'insert:app_user',
        'password_set:password_credential',
        'pii_update:user_pii',
        'token_create:api_token',
        'token_revoke:api_token',
      ]);
      expect(rows.find((r) => r.action === 'pii_update').changes).toEqual({ fields: ['email', 'display_name'] });
      expect(rows.find((r) => r.action === 'insert').changes).toEqual({
        id: user_id, kind: 'human', role: 'reader', status: 'active',
      });
      for (const r of rows) expect(r.request_id).toBeTruthy();
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(email);
      expect(dump).not.toContain(displayName);
      expect(dump).not.toContain(PASSWORD);
      expect(dump).not.toContain('$argon2');
    });

    it('no table outside the private schema contains the email, display name or password hash', async () => {
      const displayName = `Hidden Person ${run}`;
      const { email, user_id } = await registered(displayName);
      await login(open, email);
      const hash = (
        await open.pool.query('SELECT password_hash FROM private.password_credential WHERE user_id = $1', [user_id])
      ).rows[0].password_hash as string;

      const tables = await open.pool.query<{ name: string }>(
        `SELECT quote_ident(table_name) AS name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      expect(tables.rows.length).toBeGreaterThan(10);
      for (const { name } of tables.rows) {
        const { rows } = await open.pool.query(
          `SELECT count(*)::int AS n FROM public.${name} t
            WHERE strpos(lower(t::text), lower($1)) > 0 OR strpos(t::text, $2) > 0 OR strpos(t::text, $3) > 0`,
          [email, displayName, hash],
        );
        expect(rows[0].n, name).toBe(0);
      }
    });
  });
});
