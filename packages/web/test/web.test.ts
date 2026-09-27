/**
 * The web UI against the real Sermonize API (buildApp from @sermonize/api, listening on an
 * ephemeral port) and the shared test database. The database is NOT reset here: every test
 * uses unique emails/languages and compares counts with the API's own /stats.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../src/app.js';
import { parseTrustProxy } from '../src/config.js';
import { escapeHtml, html } from '../src/html.js';
import { apiUser, Browser, buildWeb, csrfFromPage, startApi, type RunningApi } from './helpers.js';
import type { WebApp } from '../src/app.js';

const PASSWORD = 'a long enough passphrase';
const run = randomUUID().slice(0, 8);
let seq = 0;
const uniqueEmail = () => `web.${run}.${++seq}@example.org`;

let openApi: RunningApi;
let closedApi: RunningApi;
let web: WebApp;
let closedWeb: WebApp;

beforeAll(async () => {
  openApi = await startApi({ registrationOpen: true });
  closedApi = await startApi({ registrationOpen: false });
  web = await buildWeb(openApi.url);
  closedWeb = await buildWeb(closedApi.url);
});

afterAll(async () => {
  await web?.close();
  await closedWeb?.close();
  await openApi?.close();
  await closedApi?.close();
});

async function apiJson(path: string, token?: string) {
  const res = await fetch(openApi.url + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: (await res.json()) as any };
}

/** Registers and signs in through the web UI; returns the browser with a session. */
async function signedIn(email = uniqueEmail()) {
  const browser = new Browser(web);
  await browser.get('/register');
  const reg = await browser.post('/register', { email, password: PASSWORD, password_confirm: PASSWORD });
  expect(reg.statusCode, reg.body).toBe(303);
  expect(reg.headers.location).toBe('/login?registered=1');
  const login = await browser.post('/login', { email, password: PASSWORD });
  expect(login.statusCode, login.body).toBe(303);
  expect(login.headers.location).toBe('/account');
  return browser;
}

describe('html helper', () => {
  it('escapes interpolations but not nested fragments', () => {
    const evil = `<script>alert("x")</script>&'`;
    expect(html`<p title="${evil}">${evil}</p>`.value).toBe(
      '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;</p>',
    );
    expect(html`<ul>${['<a>', html`<li>ok</li>`]}</ul>`.value).toBe('<ul>&lt;a&gt;<li>ok</li></ul>');
    expect(html`${null}${undefined}${false}${0}`.value).toBe('0');
    expect(escapeHtml('`')).toBe('&#96;');
  });
});

describe('landing page', () => {
  it('shows the corpus counts from GET /stats and sign-in links', async () => {
    // Seed a text in a language no other test uses, so its row is predictable.
    const contributor = await apiUser(openApi.pool, 'contributor');
    const post = (path: string, body: object) =>
      fetch(openApi.url + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${contributor.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
    const work = await post('/works', { title: `Web sermon ${run}`, genre: 'sermon' });
    expect(work.status).toBe(201);
    const language = `zz-${run}`;
    expect((await post('/texts', { work_id: work.body.id, language, relation: 'original', body: 'Verbum Dei.' })).status).toBe(201);

    const stats = (await apiJson('/stats')).body;
    const res = await new Browser(web).get('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const fmt = (v: number) => new Intl.NumberFormat('en-US').format(v);
    for (const key of ['works', 'sermons', 'texts', 'persons', 'chunks', 'embedding_spaces', 'complete_clustering_runs']) {
      expect(res.body).toContain(`data-stat="${key}">${fmt(stats[key])}</dd>`);
    }
    expect(res.body).toMatch(new RegExp(`data-language="${language}"><td>[^<]*</td><td><code>${language}</code></td><td class="num">1</td>`));
    expect(res.body).toContain('href="/login"');
    expect(res.body).toContain('href="/register"');
  });

  it('sets security headers and a CSP without inline script', async () => {
    const res = await new Browser(web).get('/');
    expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).not.toMatch(/<script|style=/i);
    const css = await new Browser(web).get('/style.css');
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
  });
});

describe('registration', () => {
  it('shows no form and refuses POSTs when registration is closed', async () => {
    const browser = new Browser(closedWeb);
    const page = await browser.get('/register');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Registration is closed');
    expect(page.body).not.toContain('name="password"');
    const res = await browser.post('/register', { email: uniqueEmail(), password: PASSWORD, password_confirm: PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Registration is closed');
  });

  it('registers when open and validates the form', async () => {
    const browser = new Browser(web);
    const page = await browser.get('/register');
    expect(page.body).toContain('<form class="stack" method="post" action="/register"');
    expect(page.body).toContain('<label for="email">');
    expect(csrfFromPage(page.body)).toBe(browser.csrf());

    const short = await browser.post('/register', { email: uniqueEmail(), password: 'short', password_confirm: 'short' });
    expect(short.statusCode).toBe(400);
    expect(short.body).toContain('12 to 256 characters');
    const mismatch = await browser.post('/register', { email: uniqueEmail(), password: PASSWORD, password_confirm: `${PASSWORD}!` });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body).toContain('do not match');

    const email = uniqueEmail();
    const ok = await browser.post('/register', { email, password: PASSWORD, password_confirm: PASSWORD, display_name: 'Web User' });
    expect(ok.statusCode).toBe(303);
    const dup = await browser.post('/register', { email: email.toUpperCase(), password: PASSWORD, password_confirm: PASSWORD });
    expect(dup.statusCode).toBe(409);
    expect(dup.body).toContain('cannot be created with this email');
  });

  it('escapes a malicious email and display name when re-rendering the form', async () => {
    const browser = new Browser(web);
    await browser.get('/register');
    const evilEmail = `"><script>alert(1)</script>@example.org`;
    const evilName = `<img src=x onerror=alert(1)>`;
    // Rejected by the API (invalid email) and re-rendered with the submitted values.
    const res = await browser.post('/register', {
      email: evilEmail,
      display_name: evilName,
      password: PASSWORD,
      password_confirm: PASSWORD,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;@example.org"');
    expect(res.body).toContain('value="&lt;img src=x onerror=alert(1)&gt;"');

    // A valid account whose display name is markup: stored, never rendered raw.
    const email = uniqueEmail();
    const ok = await browser.post('/register', { email, display_name: evilName, password: PASSWORD, password_confirm: PASSWORD });
    expect(ok.statusCode).toBe(303);
    await browser.post('/login', { email, password: PASSWORD });
    for (const url of ['/', '/account']) expect((await browser.get(url)).body).not.toContain('<img src=x');
  });
});

describe('sessions', () => {
  it('login sets a signed httpOnly SameSite=Lax cookie; the account page shows the role', async () => {
    const email = uniqueEmail();
    const browser = new Browser(web);
    await browser.get('/register');
    await browser.post('/register', { email, password: PASSWORD, password_confirm: PASSWORD });
    const notice = await browser.get('/login?registered=1');
    expect(notice.body).toContain('Your account has been created');

    const login = await browser.post('/login', { email, password: PASSWORD });
    expect(login.statusCode).toBe(303);
    const session = login.cookies.find((c) => c.name === 'sz_session')!;
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(session.secure).toBeFalsy();
    expect(session.expires).toBeInstanceOf(Date);
    const token = browser.sessionToken()!;
    expect(token).toMatch(/^sz_/);
    expect(session.value).not.toBe(token); // signed
    const { rows } = await openApi.pool.query('SELECT name FROM private.api_token WHERE token_sha256 = $1', [
      createHash('sha256').update(token).digest('hex'),
    ]);
    expect(rows).toEqual([{ name: 'web' }]); // POST /auth/login with client 'web'

    const me = (await apiJson('/me', token)).body;
    const account = await browser.get('/account');
    expect(account.statusCode).toBe(200);
    expect(account.body).toContain(`<code data-field="user_id">${me.user_id}</code>`);
    expect(account.body).toContain('<dd data-field="role">reader</dd>');
    const home = await browser.get('/');
    expect(home.body).toContain('signed in as a <strong>reader</strong>');
    expect(home.body).toContain('action="/logout"');
  });

  it('marks cookies Secure when configured', async () => {
    const secureWeb = await buildWeb(openApi.url, { cookieSecure: true });
    try {
      const res = await new Browser(secureWeb).get('/login');
      expect(res.cookies.find((c) => c.name === 'sz_csrf')?.secure).toBe(true);
    } finally {
      await secureWeb.close();
    }
  });

  it('rejects a wrong password with a generic message', async () => {
    const email = uniqueEmail();
    const browser = await signedIn(email);
    const other = new Browser(web);
    await other.get('/login');
    const res = await other.post('/login', { email, password: 'not the password at all' });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Invalid email or password.');
    expect(other.sessionToken()).toBeUndefined();
    expect(browser.sessionToken()).toBeDefined();
  });

  it('logout revokes the API token and clears the cookie', async () => {
    const browser = await signedIn();
    const token = browser.sessionToken()!;
    expect((await apiJson('/me', token)).status).toBe(200);
    const res = await browser.post('/logout', {});
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/');
    const cleared = res.cookies.find((c) => c.name === 'sz_session')!;
    expect(cleared.value).toBe('');
    expect(browser.sessionToken()).toBeUndefined();
    expect((await apiJson('/me', token)).status).toBe(401);
    const account = await browser.get('/account');
    expect(account.statusCode).toBe(303);
    expect(account.headers.location).toBe('/login');
  });

  it('a revoked or tampered session cookie is dropped', async () => {
    const browser = await signedIn();
    const token = browser.sessionToken()!;
    // Revoked elsewhere (e.g. by an admin): the web app clears the cookie.
    await fetch(openApi.url + '/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const res = await browser.get('/account');
    expect(res.headers.location).toBe('/login');
    expect(browser.sessionToken()).toBeUndefined();

    const forged = new Browser(web);
    forged.cookies.set('sz_session', `${token}.forgedsignature`);
    expect((await forged.get('/account')).headers.location).toBe('/login');
  });

  it('rejects POSTs without a valid CSRF token', async () => {
    const browser = await signedIn();
    const token = browser.sessionToken()!;
    for (const csrf of [null, 'wrong-token', '']) {
      const res = await browser.post('/logout', {}, csrf);
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('could not be verified');
    }
    // Still signed in.
    expect((await apiJson('/me', token)).status).toBe(200);
    expect((await browser.get('/account')).statusCode).toBe(200);

    // A fresh browser without the CSRF cookie cannot log in or register either.
    const fresh = new Browser(web);
    const email = uniqueEmail();
    expect((await fresh.post('/login', { email, password: PASSWORD }, 'x')).statusCode).toBe(403);
    expect((await fresh.post('/register', { email, password: PASSWORD, password_confirm: PASSWORD }, 'x')).statusCode).toBe(403);
    // A token copied from another browser does not match this browser's cookie.
    const other = new Browser(web);
    await other.get('/login');
    await fresh.get('/login');
    expect((await fresh.post('/login', { email, password: PASSWORD }, other.csrf())).statusCode).toBe(403);
  });
});

describe('client IP forwarding (TRUST_PROXY)', () => {
  it("the API's per-IP login limit sees the browser's IP only when the web app trusts its proxy", async () => {
    // The API trusts the web app (127.0.0.1) and allows one login attempt per IP and minute.
    const limited = await startApi({ rateLimit: { max: 1, timeWindowMs: 60_000 } }, '127.0.0.1');
    const behindProxy = await buildWeb(limited.url, { trustProxy: true });
    const direct = await buildWeb(limited.url);
    try {
      const attempt = async (app: WebApp, ip: string) => {
        const browser = new Browser(app);
        browser.headers['x-forwarded-for'] = ip;
        await browser.get('/login');
        return (await browser.post('/login', { email: uniqueEmail(), password: 'wrong password' })).statusCode;
      };
      expect(await attempt(behindProxy, '198.51.100.1')).toBe(401);
      expect(await attempt(behindProxy, '198.51.100.2')).toBe(401); // another person: own bucket
      expect(await attempt(behindProxy, '198.51.100.1')).toBe(429);
      // Without TRUST_PROXY the header is ignored: everyone is the proxy's (here: inject's) address.
      expect(await attempt(direct, '198.51.100.3')).toBe(401);
      expect(await attempt(direct, '198.51.100.4')).toBe(429);
    } finally {
      await behindProxy.close();
      await direct.close();
      await limited.close();
    }
  });

  it('TRUST_PROXY has the API semantics', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('127.0.0.1,10.0.0.0/8')).toBe('127.0.0.1,10.0.0.0/8');
  });

  it('has no routes under the paths a shared-domain proxy sends elsewhere (/api/, /mcp, /oauth/, /.well-known/)', async () => {
    const browser = new Browser(web);
    for (const url of ['/mcp', '/oauth/authorize', '/oauth/token', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/api/health', '/api/stats']) {
      expect((await browser.get(url)).statusCode, url).toBe(404);
    }
  });
});

describe('API unavailable', () => {
  it('shows a friendly error page', async () => {
    const down = await buildWeb('http://127.0.0.1:1');
    try {
      const browser = new Browser(down);
      for (const url of ['/', '/register']) {
        const res = await browser.get(url);
        expect(res.statusCode).toBe(503);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.body).toContain('cannot be reached right now');
      }
      await browser.get('/login'); // renders without the API and sets the CSRF cookie
      const res = await browser.post('/login', { email: uniqueEmail(), password: PASSWORD });
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('ECONNREFUSED');
    } finally {
      await down.close();
    }
  });

  it('404s with an HTML page', async () => {
    const res = await new Browser(web).get('/nope');
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Page not found');
  });
});
