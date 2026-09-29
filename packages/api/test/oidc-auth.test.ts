/**
 * OIDC sign-in (POST /auth/oidc, src/lib/oidc.ts, migrations/0002_oidc.sql) against a fake OIDC
 * provider (test/fake-oidc-provider.ts): configuration, ID token verification, account mapping
 * (linked identity, verified/trusted email, OIDC_CREATE_USERS), disabled accounts, userinfo,
 * IdP outages and rate limiting.
 */
import { randomUUID } from 'node:crypto';
import { generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAuthConfig, loadOidcConfig, type OidcConfig } from '../src/config.js';
import { hashToken } from '../src/lib/tokens.js';
import { createUser as createAppUser } from '../src/lib/users.js';
import { startFakeOidcProvider, type FakeOidcProvider } from './fake-oidc-provider.js';
import { api, asSystem, createUser, setupTestApp, type TestContext } from './helpers.js';

const run = randomUUID().slice(0, 8);
let seq = 0;
const uniqueEmail = (prefix = 'oidc') => `${prefix}.${run}.${++seq}@example.org`;
const uniqueSub = () => `sub-${run}-${++seq}`;

describe('OIDC sign-in (POST /auth/oidc)', () => {
  let idp: FakeOidcProvider;
  let ctx: TestContext; // OIDC on, no user creation, email must be verified
  let oidcConfig: OidcConfig;

  const withOidc = (overrides: Partial<OidcConfig> = {}, auth: Record<string, unknown> = {}) =>
    setupTestApp({ auth: { oidc: { ...oidcConfig, ...overrides }, ...auth } });

  const signIn = (c: TestContext, payload: Record<string, unknown>) =>
    api(c.app, null, { method: 'POST', url: '/auth/oidc', payload });

  /** A human account with an email (as an admin would create it). */
  async function account(email: string, status: 'active' | 'disabled' = 'active') {
    return asSystem(ctx.pool, (c) => createAppUser(c, { kind: 'human', role: 'reader', email, status }));
  }

  const identities = async (userId: string) =>
    (
      await ctx.pool.query<{ issuer: string; subject: string; last_login_at: Date | null }>(
        'SELECT issuer, subject, last_login_at FROM private.auth_identity WHERE user_id = $1',
        [userId],
      )
    ).rows;

  beforeAll(async () => {
    idp = await startFakeOidcProvider();
    oidcConfig = { issuer: idp.issuer, clientIds: [idp.clientId], createUsers: false, trustEmail: false };
    ctx = await withOidc();
  });
  afterAll(async () => {
    await ctx.close();
    await idp.close();
  });

  describe('configuration', () => {
    it('is off unless OIDC_ISSUER is set; the route and its documentation then do not exist', async () => {
      expect(loadOidcConfig({})).toBeNull();
      expect(loadOidcConfig({ OIDC_ISSUER: '  ' })).toBeNull();
      expect(loadAuthConfig({}).oidc).toBeNull();
      const off = await setupTestApp();
      try {
        // Like any unknown route: 401 without a token (the auth hook runs first), 404 with one.
        const idToken = await idp.mintIdToken();
        expect((await signIn(off, { id_token: idToken })).statusCode).toBe(401);
        const someone = await createUser(off.pool, { role: 'reader' });
        const res = await api(off.app, someone, { method: 'POST', url: '/auth/oidc', payload: { id_token: idToken } });
        expect(res.statusCode).toBe(404);
        const doc = (await api(off.app, null, { method: 'GET', url: '/docs/json' })).json();
        expect(Object.keys(doc.paths)).not.toContain('/auth/oidc');
        expect(Object.keys(doc.paths)).toContain('/auth/login');
      } finally {
        await off.close();
      }
      const doc = (await api(ctx.app, null, { method: 'GET', url: '/docs/json' })).json();
      expect(doc.paths['/auth/oidc'].post.security).toEqual([]);
    });

    it('parses and validates the OIDC variables', () => {
      const issuer = 'https://auth.example.org/application/o/sermonize/';
      expect(loadOidcConfig({ OIDC_ISSUER: issuer, OIDC_CLIENT_IDS: ' mcp-client , other ' })).toEqual({
        issuer,
        clientIds: ['mcp-client', 'other'],
        createUsers: false,
        trustEmail: false,
      });
      expect(
        loadOidcConfig({ OIDC_ISSUER: issuer, OIDC_CLIENT_IDS: 'a', OIDC_CREATE_USERS: 'true', OIDC_TRUST_EMAIL: 'true' }),
      ).toMatchObject({ createUsers: true, trustEmail: true });
      expect(() => loadOidcConfig({ OIDC_ISSUER: issuer })).toThrow(/OIDC_CLIENT_IDS is required/);
      expect(() => loadOidcConfig({ OIDC_ISSUER: issuer, OIDC_CLIENT_IDS: ' , ' })).toThrow(/OIDC_CLIENT_IDS/);
      expect(() => loadOidcConfig({ OIDC_ISSUER: 'auth.example.org', OIDC_CLIENT_IDS: 'a' })).toThrow(/absolute URL/);
      expect(() => loadOidcConfig({ OIDC_ISSUER: 'ftp://auth.example.org/', OIDC_CLIENT_IDS: 'a' })).toThrow(/http\(s\)/);
      expect(() => loadOidcConfig({ OIDC_ISSUER: 'https://auth.example.org/?x=1', OIDC_CLIENT_IDS: 'a' })).toThrow(/query/);
      // http only outside production
      expect(loadOidcConfig({ OIDC_ISSUER: 'http://127.0.0.1:9000/', OIDC_CLIENT_IDS: 'a' })?.issuer).toBe('http://127.0.0.1:9000/');
      expect(() =>
        loadOidcConfig({ OIDC_ISSUER: 'http://auth.example.org/', OIDC_CLIENT_IDS: 'a', NODE_ENV: 'production' }),
      ).toThrow(/https/);
      expect(loadOidcConfig({ OIDC_ISSUER: issuer, OIDC_CLIENT_IDS: 'a', NODE_ENV: 'production' })?.issuer).toBe(issuer);
      // booleans are strict, even while OIDC is off
      expect(() => loadOidcConfig({ OIDC_CREATE_USERS: 'yes' })).toThrow(/OIDC_CREATE_USERS/);
      expect(() => loadOidcConfig({ OIDC_ISSUER: issuer, OIDC_CLIENT_IDS: 'a', OIDC_TRUST_EMAIL: '1' })).toThrow(/OIDC_TRUST_EMAIL/);
    });
  });

  describe('ID token verification', () => {
    it('rejects tokens with a wrong audience, issuer, expiry, age, signature or azp', async () => {
      const email = uniqueEmail();
      await account(email);
      const sub = uniqueSub();
      const now = Math.floor(Date.now() / 1000);
      const { privateKey: otherKey } = await generateKeyPair('RS256');
      const bad = [
        await idp.mintIdToken({ sub, email, email_verified: true, aud: 'someone-else' }),
        await idp.mintIdToken({ sub, email, email_verified: true, iss: idp.issuer.replace(/\/$/, '') }),
        await idp.mintIdToken({ sub, email, email_verified: true, iat: now - 700, exp: now - 60 }),
        await idp.mintIdToken({ sub, email, email_verified: true, iat: now - 11 * 60, exp: now + 300 }),
        await idp.mintIdToken({ sub, email, email_verified: true }, { key: otherKey }),
        await idp.mintIdToken({ sub, email, email_verified: true, aud: [idp.clientId, 'other'], azp: 'other' }),
        await idp.mintIdToken({ sub: '', email, email_verified: true }),
        'not-a-jwt',
      ];
      for (const idToken of bad) {
        const res = await signIn(ctx, { id_token: idToken, client: 'mcp' });
        expect(res.statusCode, res.body).toBe(401);
        expect(res.json().error.code).toBe('invalid_id_token');
      }
      // Unsigned or HMAC tokens are never accepted.
      const payload = (await idp.mintIdToken({ sub, email, email_verified: true })).split('.')[1];
      const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + payload + '.';
      expect((await signIn(ctx, { id_token: none })).statusCode).toBe(401);
      expect((await ctx.pool.query('SELECT 1 FROM private.auth_identity WHERE subject = $1', [sub])).rowCount).toBe(0);

      // aud may be an array that contains the client id
      const ok = await signIn(ctx, {
        id_token: await idp.mintIdToken({ sub, email, email_verified: true, aud: [idp.clientId, 'other'], azp: idp.clientId }),
      });
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it('validates the body', async () => {
      expect((await signIn(ctx, {})).statusCode).toBe(400);
      expect((await signIn(ctx, { id_token: await idp.mintIdToken(), client: 'admin' })).statusCode).toBe(400);
    });
  });

  describe('account mapping', () => {
    it('links an existing account by verified email and issues a login token for the client', async () => {
      const email = uniqueEmail();
      const user = await account(email);
      const sub = uniqueSub();
      const before = Date.now();
      const res = await signIn(ctx, {
        id_token: await idp.mintIdToken({ sub, email: email.toUpperCase(), email_verified: true }),
        client: 'mcp',
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body).toEqual({ token: expect.stringMatching(/^sz_/), expires_at: expect.any(String), user_id: user.id, role: 'reader' });
      expect(Date.parse(body.expires_at)).toBeGreaterThanOrEqual(before + 720 * 3_600_000 - 1000);
      expect((await api(ctx.app, body.token, { method: 'GET', url: '/me' })).json()).toEqual({
        user_id: user.id,
        role: 'reader',
        kind: 'human',
      });
      const token = await ctx.pool.query('SELECT name, created_by FROM private.api_token WHERE token_sha256 = $1', [
        hashToken(body.token),
      ]);
      expect(token.rows[0]).toEqual({ name: 'mcp', created_by: user.id });
      const links = await identities(user.id);
      expect(links).toEqual([{ issuer: idp.issuer, subject: sub, last_login_at: expect.any(Date) }]);

      // Audit: the user is the actor; no subject, email or name in the trail.
      const audit = await ctx.pool.query(
        `SELECT action, entity_type, changes FROM audit_event WHERE actor_id = $1 AND action IN ('identity_link', 'token_create')
          ORDER BY action`,
        [user.id],
      );
      expect(audit.rows).toEqual([
        { action: 'identity_link', entity_type: 'auth_identity', changes: { issuer: idp.issuer, via: 'email' } },
        { action: 'token_create', entity_type: 'api_token', changes: expect.objectContaining({ via: 'oidc', client: 'mcp' }) },
      ]);
      expect(JSON.stringify(audit.rows)).not.toContain(sub);
      expect(JSON.stringify(audit.rows).toLowerCase()).not.toContain(email);

      // Later sign-ins go through the link, even when the email claim changed or is gone.
      const again = await signIn(ctx, { id_token: await idp.mintIdToken({ sub, email: 'changed@example.org', email_verified: true }) });
      expect(again.json().user_id).toBe(user.id);
      const noEmail = await signIn(ctx, { id_token: await idp.mintIdToken({ sub }) });
      expect(noEmail.statusCode).toBe(200);
      expect(noEmail.json().user_id).toBe(user.id);
      expect(await identities(user.id)).toHaveLength(1);
    });

    it('does not link by an unverified email unless OIDC_TRUST_EMAIL', async () => {
      const email = uniqueEmail();
      const user = await account(email);
      const sub = uniqueSub();
      for (const claims of [{ email }, { email, email_verified: false }, { email, email_verified: 'true' }]) {
        const res = await signIn(ctx, { id_token: await idp.mintIdToken({ sub, ...claims }) });
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().error.code).toBe('no_account');
      }
      expect(await identities(user.id)).toEqual([]);

      const trusting = await withOidc({ trustEmail: true });
      try {
        const res = await signIn(trusting, { id_token: await idp.mintIdToken({ sub, email, email_verified: false }) });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().user_id).toBe(user.id);
      } finally {
        await trusting.close();
      }
    });

    it('never links a service account by email', async () => {
      const email = uniqueEmail('svc');
      await asSystem(ctx.pool, (c) => createAppUser(c, { kind: 'service', role: 'contributor', email }));
      const res = await signIn(ctx, { id_token: await idp.mintIdToken({ sub: uniqueSub(), email, email_verified: true }) });
      expect(res.statusCode).toBe(403);
    });

    it('OIDC_CREATE_USERS creates an account with REGISTRATION_DEFAULT_ROLE; the email only when trusted', async () => {
      const creating = await withOidc({ createUsers: true }, { registrationDefaultRole: 'contributor' });
      try {
        const email = uniqueEmail('new');
        const sub = uniqueSub();
        const res = await signIn(creating, {
          id_token: await idp.mintIdToken({ sub, email, email_verified: true, name: 'New Person' }),
          client: 'web',
        });
        expect(res.statusCode, res.body).toBe(200);
        const { user_id, role } = res.json();
        expect(role).toBe('contributor');
        const user = await ctx.pool.query('SELECT kind, role, status, created_by FROM app_user WHERE id = $1', [user_id]);
        expect(user.rows[0]).toEqual({ kind: 'human', role: 'contributor', status: 'active', created_by: user_id });
        const pii = await ctx.pool.query('SELECT email, display_name FROM private.user_pii WHERE user_id = $1', [user_id]);
        expect(pii.rows[0]).toEqual({ email, display_name: 'New Person' });
        expect(await ctx.pool.query('SELECT 1 FROM private.password_credential WHERE user_id = $1', [user_id])).toMatchObject({
          rowCount: 0,
        });
        // Same identity again: same account, nothing new.
        const again = await signIn(creating, { id_token: await idp.mintIdToken({ sub, email, email_verified: true }) });
        expect(again.json().user_id).toBe(user_id);

        // Unverified email: a new account without the email (the existing one is not taken over).
        const existing = await account(uniqueEmail());
        const email2 = (await ctx.pool.query('SELECT email FROM private.user_pii WHERE user_id = $1', [existing.id])).rows[0].email;
        const res2 = await signIn(creating, {
          id_token: await idp.mintIdToken({ sub: uniqueSub(), email: email2, preferred_username: 'someone' }),
        });
        expect(res2.statusCode, res2.body).toBe(200);
        expect(res2.json().user_id).not.toBe(existing.id);
        const pii2 = await ctx.pool.query('SELECT email, display_name FROM private.user_pii WHERE user_id = $1', [res2.json().user_id]);
        expect(pii2.rows[0]).toEqual({ email: null, display_name: 'someone' });
      } finally {
        await creating.close();
      }
    });

    it('refuses disabled accounts like password login does, and keeps no new link', async () => {
      const creating = await withOidc({ createUsers: true });
      try {
        // Linked by email, but disabled: refused, and not linked.
        const email = uniqueEmail('disabled');
        const disabled = await account(email, 'disabled');
        const sub = uniqueSub();
        const res = await signIn(creating, { id_token: await idp.mintIdToken({ sub, email, email_verified: true }) });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('invalid_credentials');
        expect(await identities(disabled.id)).toEqual([]);

        // Already linked, then disabled: refused; no token was created.
        const email2 = uniqueEmail();
        const user = await account(email2);
        const sub2 = uniqueSub();
        expect((await signIn(creating, { id_token: await idp.mintIdToken({ sub: sub2, email: email2, email_verified: true }) })).statusCode).toBe(200);
        await asSystem(ctx.pool, (c) => c.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [user.id]));
        const count = async () =>
          Number((await ctx.pool.query('SELECT count(*) FROM private.api_token WHERE user_id = $1', [user.id])).rows[0].count);
        const tokensBefore = await count();
        const refused = await signIn(creating, { id_token: await idp.mintIdToken({ sub: sub2 }) });
        expect(refused.statusCode).toBe(401);
        expect(await count()).toBe(tokensBefore);
      } finally {
        await creating.close();
      }
    });
  });

  describe('userinfo and IdP availability', () => {
    it('reads the email from userinfo when the ID token has none (sub must match)', async () => {
      const email = uniqueEmail();
      const user = await account(email);
      const sub = uniqueSub();
      const accessToken = idp.accessTokenFor({ sub, email, email_verified: true });
      const res = await signIn(ctx, { id_token: await idp.mintIdToken({ sub }), access_token: accessToken });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().user_id).toBe(user.id);

      const other = idp.accessTokenFor({ sub: 'someone-else', email: uniqueEmail(), email_verified: true });
      const mismatch = await signIn(ctx, { id_token: await idp.mintIdToken({ sub: uniqueSub() }), access_token: other });
      expect(mismatch.statusCode).toBe(401);
      const invalid = await signIn(ctx, { id_token: await idp.mintIdToken({ sub: uniqueSub() }), access_token: 'nope' });
      expect(invalid.statusCode).toBe(401);
    });

    it('answers 503 while discovery fails and retries it on the next request', async () => {
      const fresh = await withOidc();
      try {
        idp.down = true;
        const res = await signIn(fresh, { id_token: await idp.mintIdToken() });
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe('oidc_unavailable');
        idp.down = false;
        const before = idp.discoveryRequests;
        const email = uniqueEmail();
        await account(email);
        const ok = await signIn(fresh, { id_token: await idp.mintIdToken({ sub: uniqueSub(), email, email_verified: true }) });
        expect(ok.statusCode, ok.body).toBe(200);
        expect(idp.discoveryRequests).toBe(before + 1);
        // cached afterwards
        await signIn(fresh, { id_token: await idp.mintIdToken({ sub: uniqueSub() }) });
        expect(idp.discoveryRequests).toBe(before + 1);
      } finally {
        idp.down = false;
        await fresh.close();
      }
    });

    it('is rate-limited per IP like /auth/login', async () => {
      const limited = await withOidc({}, { rateLimit: { max: 2, timeWindowMs: 60_000 } });
      try {
        const idToken = await idp.mintIdToken({ sub: uniqueSub() });
        expect((await signIn(limited, { id_token: idToken })).statusCode).toBe(403);
        expect((await signIn(limited, { id_token: idToken })).statusCode).toBe(403);
        const res = await signIn(limited, { id_token: idToken });
        expect(res.statusCode).toBe(429);
        expect(res.json().error.code).toBe('rate_limited');
      } finally {
        await limited.close();
      }
    });
  });
});
