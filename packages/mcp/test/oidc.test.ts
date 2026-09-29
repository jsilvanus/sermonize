/**
 * Single sign-on on the MCP sign-in page (src/oauth/oidc.ts), end to end:
 * MCP client -> /oauth/authorize -> SSO button -> /oidc/login -> fake OIDC provider (test fixture shared
 * with the API suite) -> /oidc/callback (code grant with PKCE, state, nonce) -> the real Sermonize API's
 * POST /auth/oidc (verifies the ID token, maps it to an account) -> consent -> /oauth/token -> /mcp.
 *
 * Like integration.test.ts, the database is shared and not reset: every account here is new.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@sermonize/api/app';
import { withTransaction } from '@sermonize/api/db/transaction';
import { SYSTEM_PRINCIPAL } from '@sermonize/api/lib/principal';
import { startFakeOidcProvider, type FakeOidcProvider } from '../../api/test/fake-oidc-provider.js';
import { DEFAULT_OIDC_BUTTON_LABEL, loadConfig, loadOidcConfig, type OidcConfig } from '../src/config.js';
import { OIDC_COOKIE } from '../src/oauth/oidc.js';
import { TEST_DATABASE_URL } from './db-url.js';
import { callJson, CLIENT_ID, PUBLIC_URL, REDIRECT_URI, startMcpServer, type McpTestServer, type Tokens } from './helpers.js';

const PASSWORD = 'oidc integration passphrase';
const run = randomUUID().slice(0, 8);
let seq = 0;
const uniqueEmail = () => `mcp.oidc.${run}.${++seq}@example.org`;
const uniqueSub = () => `mcp-sub-${run}-${++seq}`;

type Api = Awaited<ReturnType<typeof buildApp>>;
let pool: pg.Pool;
let api: Api;
let apiUrl: string;
let idp: FakeOidcProvider;
let mcp: McpTestServer;
let oidcConfig: OidcConfig;

async function listen(app: Api): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

/** A Sermonize password account (registered through the API, as the web UI does). */
async function account(): Promise<{ id: string; email: string }> {
  const email = uniqueEmail();
  const res = await fetch(apiUrl + '/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
  return { id: ((await res.json()) as { user_id: string }).user_id, email };
}

interface SsoStart {
  oauth: string;
  verifier: string;
  cookie: string;
  setCookie: string;
  idpAuthorize: URL;
}

/** Authorize page -> SSO button -> /oidc/login; returns the state cookie and the IdP URL. */
async function startSso(server: McpTestServer): Promise<SsoStart> {
  const { oauth, verifier, page } = await server.authorizePage();
  const href = /href="(\/oidc\/login\?oauth=[^"]+)"/.exec(page.body)?.[1];
  if (!href) throw new Error('no SSO button');
  const res = await fetch(server.url + href.replaceAll('&amp;', '&'), { redirect: 'manual' });
  expect(res.status).toBe(302);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0]!;
  return { oauth, verifier, cookie, setCookie, idpAuthorize: new URL(res.headers.get('location')!) };
}

/** The IdP's redirect back to /oidc/callback, as a path + query on the test server. */
async function atIdp(start: SsoStart): Promise<string> {
  const res = await fetch(start.idpAuthorize, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get('location')!);
  expect(back.origin + back.pathname).toBe(PUBLIC_URL + '/oidc/callback');
  return back.pathname + back.search;
}

async function callback(server: McpTestServer, pathAndQuery: string, cookie?: string) {
  const res = await fetch(server.url + pathAndQuery, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  const body = await res.text();
  return { status: res.status, body, headers: res.headers, ticket: /name="ticket" value="([^"]+)"/.exec(body)?.[1] };
}

/** Consent + token exchange after a successful callback. */
async function finish(server: McpTestServer, start: SsoStart, ticket: string): Promise<Tokens> {
  const { status, location } = await server.consent(start.oauth, ticket);
  expect(status).toBe(302);
  const code = location?.searchParams.get('code');
  expect(code).toBeTruthy();
  const res = await server.token({
    grant_type: 'authorization_code',
    code: code!,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: start.verifier,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Tokens;
}

beforeAll(async () => {
  idp = await startFakeOidcProvider({ clientSecret: 'test-client-secret' });
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  api = await buildApp({
    pool,
    auth: {
      registrationOpen: true,
      oidc: { issuer: idp.issuer, clientIds: [idp.clientId], createUsers: false, trustEmail: false },
    },
  });
  apiUrl = await listen(api);
  oidcConfig = {
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: 'test-client-secret',
    scopes: 'openid email profile',
    buttonLabel: 'Kirjaudu kertakirjautumisella',
    production: false,
  };
  mcp = await startMcpServer(apiUrl, { oidc: oidcConfig });
});

afterAll(async () => {
  await mcp?.close();
  await api?.close();
  await pool?.end();
  await idp?.close();
});

describe('configuration', () => {
  const base = {
    JWT_SECRET: Buffer.alloc(32, 1).toString('base64'),
    SERMONIZE_API_URL: 'http://127.0.0.1:3000',
    SERMONIZE_TOKEN_KEY: Buffer.alloc(32, 2).toString('base64'),
  };

  it('is off without OIDC_ISSUER; required and validated settings otherwise', () => {
    expect(loadConfig(base).oidc).toBeNull();
    expect(loadConfig({ ...base, OIDC_ISSUER: '' }).oidc).toBeNull();
    const issuer = 'https://auth.example.org/application/o/sermonize/';
    expect(loadOidcConfig({ OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'abc' })).toEqual({
      issuer,
      clientId: 'abc',
      clientSecret: undefined,
      scopes: 'openid email profile',
      buttonLabel: DEFAULT_OIDC_BUTTON_LABEL,
      production: false,
    });
    expect(
      loadOidcConfig({ OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'abc', OIDC_CLIENT_SECRET: 's', OIDC_SCOPES: ' openid  email ', OIDC_BUTTON_LABEL: 'SSO' }),
    ).toMatchObject({ clientSecret: 's', scopes: 'openid email', buttonLabel: 'SSO' });
    expect(() => loadConfig({ ...base, OIDC_ISSUER: issuer })).toThrow(/OIDC_CLIENT_ID is required/);
    expect(() => loadOidcConfig({ OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'abc', OIDC_SCOPES: 'email profile' })).toThrow(/openid/);
    expect(() => loadOidcConfig({ OIDC_ISSUER: 'not a url', OIDC_CLIENT_ID: 'abc' })).toThrow(/absolute URL/);
    expect(() => loadOidcConfig({ OIDC_ISSUER: 'https://a.example/#x', OIDC_CLIENT_ID: 'abc' })).toThrow(/fragment/);
    expect(loadOidcConfig({ OIDC_ISSUER: 'http://127.0.0.1:9000/', OIDC_CLIENT_ID: 'abc' })?.issuer).toBe('http://127.0.0.1:9000/');
    expect(() => loadOidcConfig({ OIDC_ISSUER: 'http://auth.example.org/', OIDC_CLIENT_ID: 'abc', NODE_ENV: 'production' })).toThrow(/https/);
  });

  it('without OIDC: no button on the sign-in page and no /oidc/* routes', async () => {
    const off = await startMcpServer(apiUrl);
    try {
      const { page } = await off.authorizePage();
      expect(page.body).not.toContain('/oidc/login');
      expect(page.body).not.toContain('single sign-on');
      expect((await fetch(off.url + '/oidc/login?oauth=x')).status).toBe(404);
      expect((await fetch(off.url + '/oidc/callback?code=x&state=y')).status).toBe(404);
      // The discovery documents never advertise OpenID Provider features.
      const metadata = (await (await fetch(off.url + '/.well-known/openid-configuration')).json()) as Record<string, unknown>;
      expect(metadata).not.toHaveProperty('jwks_uri');
    } finally {
      await off.close();
    }
    const metadata = (await (await fetch(mcp.url + '/.well-known/openid-configuration')).json()) as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('jwks_uri');
    expect(metadata).not.toHaveProperty('userinfo_endpoint');
    expect(metadata).not.toHaveProperty('id_token_signing_alg_values_supported');
  });
});

describe('sign-in with single sign-on', () => {
  it('shows the button next to the password form', async () => {
    const { page } = await mcp.authorizePage();
    expect(page.body).toContain('Kirjaudu kertakirjautumisella');
    expect(page.body).toMatch(/href="\/oidc\/login\?oauth=/);
    expect(page.body).toContain('name="password"');
  });

  it('runs the whole MCP OAuth flow through the IdP and ends with a token that works on /mcp', async () => {
    const user = await account();
    idp.user = { sub: uniqueSub(), email: user.email, email_verified: true, name: 'SSO User' };
    const start = await startSso(mcp);

    // State cookie and the IdP request.
    expect(start.setCookie).toMatch(new RegExp(`^${OIDC_COOKIE}=`));
    expect(start.setCookie).toContain('HttpOnly');
    expect(start.setCookie).toContain('SameSite=Lax');
    expect(start.setCookie).toContain('Path=/oidc');
    expect(start.setCookie).toContain('Max-Age=600');
    expect(start.setCookie).not.toContain('Secure');
    const q = start.idpAuthorize.searchParams;
    expect(start.idpAuthorize.origin + start.idpAuthorize.pathname).toBe(idp.issuer + 'authorize');
    expect(q.get('client_id')).toBe(idp.clientId);
    expect(q.get('redirect_uri')).toBe(PUBLIC_URL + '/oidc/callback');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toBeTruthy();
    expect(q.get('nonce')).toBeTruthy();
    expect(q.get('state')).toBe(start.cookie.split('=')[1]);
    expect(mcp.db.prepare('SELECT count(*) AS n FROM oidc_states').get()).toEqual({ n: 1 });

    const back = await atIdp(start);
    const res = await callback(mcp, back, start.cookie);
    expect(res.status, res.body).toBe(200);
    expect(res.body).toContain('Authorize MCP client');
    expect(res.body).toContain(user.email);
    // The consent page's form redirects to the client: CSP form-action lists it.
    expect(res.headers.get('content-security-policy')).toContain('https://client.example');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(mcp.db.prepare('SELECT count(*) AS n FROM oidc_states').get()).toEqual({ n: 0 });

    const tokens = await finish(mcp, start, res.ticket!);
    const client = await mcp.connect(tokens.access_token);
    expect(await callJson(client, 'whoami')).toEqual({ user_id: user.id, role: 'reader', kind: 'human' });

    // The grant holds an API token named mcp, issued by POST /auth/oidc.
    const audit = await pool.query(
      `SELECT changes FROM audit_event WHERE actor_id = $1 AND action = 'token_create' ORDER BY occurred_at DESC LIMIT 1`,
      [user.id],
    );
    expect(audit.rows[0].changes).toMatchObject({ via: 'oidc', client: 'mcp' });

    // Replaying the same callback (same state, same cookie) is refused.
    const replay = await callback(mcp, back, start.cookie);
    expect(replay.status).toBe(400);
    expect(replay.ticket).toBeUndefined();
  });

  it('password sign-in keeps working next to the button', async () => {
    const user = await account();
    const tokens = await mcp.signIn(user.email, PASSWORD);
    const client = await mcp.connect(tokens.access_token);
    expect(await callJson(client, 'whoami')).toMatchObject({ user_id: user.id });
  });

  it('reads the email from userinfo (through the API) when the ID token has none', async () => {
    const user = await account();
    idp.user = { sub: uniqueSub(), email: user.email, email_verified: true };
    idp.idTokenWithoutProfile = true;
    try {
      const start = await startSso(mcp);
      const res = await callback(mcp, await atIdp(start), start.cookie);
      expect(res.status, res.body).toBe(200);
      const tokens = await finish(mcp, start, res.ticket!);
      expect(await callJson(await mcp.connect(tokens.access_token), 'whoami')).toMatchObject({ user_id: user.id });
    } finally {
      idp.idTokenWithoutProfile = false;
    }
  });

  it('refuses a callback without the state cookie or with another one', async () => {
    idp.user = { sub: uniqueSub(), email: (await account()).email, email_verified: true };
    const start = await startSso(mcp);
    const back = await atIdp(start);
    expect((await callback(mcp, back)).status).toBe(400);
    const other = await callback(mcp, back, `${OIDC_COOKIE}=someone-elses-state`);
    expect(other.status).toBe(400);
    expect(other.body).toContain('could not be verified');
    // The state itself is still unused; the right browser can finish.
    expect((await callback(mcp, back, start.cookie)).status).toBe(200);
  });

  it('refuses an expired state', async () => {
    idp.user = { sub: uniqueSub(), email: (await account()).email, email_verified: true };
    const start = await startSso(mcp);
    const back = await atIdp(start);
    mcp.db.prepare('UPDATE oidc_states SET expires = ?').run(Date.now() - 1);
    const res = await callback(mcp, back, start.cookie);
    expect(res.status).toBe(400);
    expect(res.body).toContain('expired');
  });

  it('shows an error page with a way back when the IdP answers with an error', async () => {
    idp.nextError = 'access_denied';
    const start = await startSso(mcp);
    const res = await callback(mcp, await atIdp(start), start.cookie);
    expect(res.status).toBe(400);
    expect(res.body).toContain('Sign-in cancelled');
    expect(res.body).toContain('href="/oauth/authorize?');
    expect(res.body).not.toMatch(/stack|Error:/);
  });

  it('refuses an unverified email (no account) and a disabled account', async () => {
    const user = await account();
    idp.user = { sub: uniqueSub(), email: user.email, email_verified: false };
    let start = await startSso(mcp);
    let res = await callback(mcp, await atIdp(start), start.cookie);
    expect(res.status).toBe(403);
    expect(res.body).toContain('No account for this sign-in; ask the administrator.');

    const disabled = await account();
    await withTransaction(pool, SYSTEM_PRINCIPAL, `mcp-oidc-test:${randomUUID()}`, (c) =>
      c.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [disabled.id]),
    );
    idp.user = { sub: uniqueSub(), email: disabled.email, email_verified: true };
    start = await startSso(mcp);
    res = await callback(mcp, await atIdp(start), start.cookie);
    expect(res.status).toBe(401);
    expect(res.ticket).toBeUndefined();
    expect(mcp.db.prepare('SELECT count(*) AS n FROM grants WHERE subject = ?').get(disabled.id)).toEqual({ n: 0 });
  });

  it('validates the OAuth request on /oidc/login', async () => {
    expect((await fetch(mcp.url + '/oidc/login', { redirect: 'manual' })).status).toBe(400);
    const bad = Buffer.from('response_type=code&client_id=https://evil.example/c.json').toString('base64url');
    const res = await fetch(mcp.url + '/oidc/login?oauth=' + bad, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('IdP availability, public clients and rate limiting', () => {
  it('starts while the IdP is down, answers 503, and retries discovery later (public client)', async () => {
    const publicIdp = await startFakeOidcProvider({ clientId: 'public-client' });
    const publicApi = await buildApp({
      pool,
      auth: {
        registrationOpen: true,
        oidc: { issuer: publicIdp.issuer, clientIds: ['public-client'], createUsers: true, trustEmail: false },
      },
    });
    const publicApiUrl = await listen(publicApi);
    publicIdp.down = true;
    const server = await startMcpServer(publicApiUrl, {
      oidc: { ...oidcConfig, issuer: publicIdp.issuer, clientId: 'public-client', clientSecret: undefined },
    });
    try {
      const { page } = await server.authorizePage();
      const href = /href="(\/oidc\/login\?oauth=[^"]+)"/.exec(page.body)![1]!;
      const down = await fetch(server.url + href, { redirect: 'manual' });
      expect(down.status).toBe(503);
      expect(await down.text()).toContain('Back to sign-in');

      publicIdp.down = false;
      // OIDC_CREATE_USERS on the API: a new account for a new identity.
      publicIdp.user = { sub: uniqueSub(), email: uniqueEmail(), email_verified: true, name: 'Brand New' };
      const start = await startSso(server);
      const res = await callback(server, await atIdp(start), start.cookie);
      expect(res.status, res.body).toBe(200);
      const tokens = await finish(server, start, res.ticket!);
      expect(await callJson(await server.connect(tokens.access_token), 'whoami')).toMatchObject({ role: 'reader', kind: 'human' });
    } finally {
      await server.close();
      await publicApi.close();
      await publicIdp.close();
    }
  });

  it('rate-limits /oidc/login per IP', async () => {
    const server = await startMcpServer(apiUrl, { oidc: oidcConfig, oidcRateLimit: { max: 2, timeWindow: 60_000 } });
    try {
      const { oauth } = await server.authorizePage();
      const url = `${server.url}/oidc/login?oauth=${encodeURIComponent(oauth)}`;
      expect((await fetch(url, { redirect: 'manual' })).status).toBe(302);
      expect((await fetch(url, { redirect: 'manual' })).status).toBe(302);
      expect((await fetch(url, { redirect: 'manual' })).status).toBe(429);
    } finally {
      await server.close();
    }
  });
});
