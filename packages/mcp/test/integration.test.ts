/**
 * End to end: OAuth sign-in with a Sermonize account (MCP sign-in page -> the API's POST /auth/login)
 * -> MCP client -> MCP HTTP server (access token -> grant -> upstream API token) -> SermonizeClient
 * -> the real Sermonize API (buildApp from @sermonize/api) -> the test database.
 *
 * The database is shared with the API suite and is NOT reset here (see test/global-setup.ts):
 * this file creates its own users (unique emails) and uniquely named rows and only asserts on those.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildApp } from '@sermonize/api/app';
import { withTransaction } from '@sermonize/api/db/transaction';
import { SYSTEM_PRINCIPAL, type Role } from '@sermonize/api/lib/principal';
import { SIGN_IN_AGAIN } from '../src/connector.js';
import { TEST_DATABASE_URL } from './db-url.js';
import { call, callJson, CLIENT_ID, grantIdOf, startMcpServer, type McpTestServer } from './helpers.js';

const PASSWORD = 'integration passphrase 123';
const MCP_TTL_HOURS = 1;
let pool: pg.Pool;
type Api = Awaited<ReturnType<typeof buildApp>>;
let api: Api;
let apiUrl: string;
let mcp: McpTestServer;
const run = randomUUID().slice(0, 8); // makes names unique per run
let seq = 0;

async function listen(app: Api): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withTransaction(pool, SYSTEM_PRINCIPAL, `mcp-test:${randomUUID()}`, fn);

/** Registers a Sermonize account through the API (as the web UI does) and gives it `role`. */
async function account(role: Role): Promise<{ id: string; email: string }> {
  const email = `mcp.${run}.${++seq}@example.org`;
  const res = await fetch(apiUrl + '/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
  const { user_id } = (await res.json()) as { user_id: string };
  if (role !== 'contributor') await asSystem((c) => c.query('UPDATE app_user SET role = $1 WHERE id = $2', [role, user_id]));
  return { id: user_id, email };
}

/** The API tokens of a user, newest first. */
async function apiTokens(userId: string) {
  const { rows } = await pool.query<{ name: string; expires_at: Date; revoked_at: Date | null }>(
    'SELECT name, expires_at, revoked_at FROM private.api_token WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );
  return rows;
}

const users: Record<string, { id: string; email: string }> = {};
let contributor: Client;
let reader: Client;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  api = await buildApp({
    pool,
    auth: { registrationOpen: true, registrationDefaultRole: 'contributor', mcpLoginTokenTtlHours: MCP_TTL_HOURS },
  });
  apiUrl = await listen(api);

  users.contributor = await account('contributor');
  users.reader = await account('reader');
  mcp = await startMcpServer(apiUrl);
  contributor = await mcp.connect((await mcp.signIn(users.contributor.email, PASSWORD)).access_token);
  reader = await mcp.connect((await mcp.signIn(users.reader.email, PASSWORD)).access_token);
});

afterAll(async () => {
  await mcp?.close();
  await api?.close();
  await pool?.end();
});

describe('sign-in with a Sermonize account', () => {
  it('whoami returns the API user id and role of the account that signed in', async () => {
    expect(await callJson(contributor, 'whoami')).toEqual({ user_id: users.contributor!.id, role: 'contributor', kind: 'human' });
    expect(await callJson(reader, 'whoami')).toMatchObject({ user_id: users.reader!.id, role: 'reader' });
  });

  it('obtains an API token named mcp; the refresh token and access token never outlive it', async () => {
    const user = await account('reader');
    const tokens = await mcp.signIn(user.email, PASSWORD);
    expect(decodeJwt(tokens.access_token).sub).toBe(user.id);
    const [token] = await apiTokens(user.id);
    expect(token).toMatchObject({ name: 'mcp', revoked_at: null });
    const apiExpires = token!.expires_at.getTime();
    expect(Math.abs(apiExpires - (Date.now() + MCP_TTL_HOURS * 3_600_000))).toBeLessThan(10_000);

    const row = mcp.db.prepare('SELECT expires FROM refresh_tokens WHERE token = ?').get(tokens.refresh_token) as { expires: number };
    expect(row.expires).toBeLessThanOrEqual(apiExpires); // not the default 30 days
    expect(decodeJwt(tokens.access_token).exp! * 1000).toBeLessThanOrEqual(apiExpires);
  });

  it('a wrong password shows the sign-in page again and issues nothing', async () => {
    const user = await account('reader');
    const { oauth } = await mcp.authorizePage();
    const res = await mcp.submitCredentials(oauth, user.email, 'not the password at all');
    expect(res.status).toBe(401);
    expect(res.body).toContain('Invalid email or password.');
    expect(res.ticket).toBeUndefined();
    expect(await apiTokens(user.id)).toEqual([]);
  });

  it('a disabled account: the next tool call asks to sign in again and the grant ends', async () => {
    const user = await account('reader');
    const tokens = await mcp.signIn(user.email, PASSWORD);
    const client = await mcp.connect(tokens.access_token);
    expect(await callJson(client, 'whoami')).toMatchObject({ user_id: user.id });

    await asSystem((c) => c.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [user.id]));
    expect(await call(client, 'whoami')).toMatchObject({ isError: true, text: SIGN_IN_AGAIN });
    expect((await mcp.rawMcp(tokens.access_token)).status).toBe(401);
    const refresh = await mcp.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLIENT_ID });
    expect(refresh).toEqual({ status: 400, body: { error: 'invalid_grant' } });
    // Signing in again is refused like any wrong credentials.
    const { oauth } = await mcp.authorizePage();
    expect((await mcp.submitCredentials(oauth, user.email, PASSWORD)).status).toBe(401);
  });

  it('a revoked API token: the next tool call asks to sign in again; signing in again works', async () => {
    const user = await account('reader');
    const tokens = await mcp.signIn(user.email, PASSWORD);
    const client = await mcp.connect(tokens.access_token);
    await asSystem((c) => c.query(`UPDATE private.api_token SET revoked_at = now() WHERE user_id = $1`, [user.id]));
    const res = await call(client, 'whoami');
    expect(res).toMatchObject({ isError: true, text: SIGN_IN_AGAIN });
    expect(res.text).not.toMatch(/sz_/);
    expect((await mcp.rawMcp(tokens.access_token)).status).toBe(401);

    const again = await mcp.connect((await mcp.signIn(user.email, PASSWORD)).access_token);
    expect(await callJson(again, 'whoami')).toMatchObject({ user_id: user.id });
  });

  it('ending a grant (denied consent, expired refresh token) revokes its API token with POST /auth/logout', async () => {
    const own = await startMcpServer(apiUrl); // its own grant store, so the sweep only touches these grants
    try {
      const denied = await account('reader');
      const { oauth } = await own.authorizePage();
      const signIn = await own.submitCredentials(oauth, denied.email, PASSWORD);
      expect((await own.consent(oauth, signIn.ticket!, 'deny')).location?.searchParams.get('error')).toBe('access_denied');
      expect((await apiTokens(denied.id))[0]!.revoked_at).not.toBeNull();

      const expired = await account('reader');
      const tokens = await own.signIn(expired.email, PASSWORD);
      expect((await apiTokens(expired.id))[0]!.revoked_at).toBeNull();
      await own.app.sessions.sweep(Date.now() + (MCP_TTL_HOURS + 1) * 3_600_000);
      expect((await apiTokens(expired.id))[0]!.revoked_at).not.toBeNull();
      expect(own.db.prepare('SELECT count(*) AS n FROM grants WHERE id = ?').get(grantIdOf(tokens.access_token))).toEqual({ n: 0 });
    } finally {
      await own.close();
    }
  });

  it("the API's per-IP rate limit sees the end user's IP through the MCP server", async () => {
    // API trusts the MCP server (127.0.0.1); MCP trusts its reverse proxy (TRUST_PROXY=true here).
    const limitedApi = await buildApp({ pool, trustProxy: '127.0.0.1', auth: { rateLimit: { max: 1, timeWindowMs: 60_000 } } });
    const limitedUrl = await listen(limitedApi);
    const behindProxy = await startMcpServer(limitedUrl, { trustProxy: true });
    const direct = await startMcpServer(limitedUrl);
    try {
      const attempt = async (server: McpTestServer, ip: string) => {
        const { oauth } = await server.authorizePage();
        return (await server.submitCredentials(oauth, `nobody.${run}@example.org`, 'wrong', { 'x-forwarded-for': ip })).status;
      };
      expect(await attempt(behindProxy, '198.51.100.1')).toBe(401);
      expect(await attempt(behindProxy, '198.51.100.2')).toBe(401); // another person: own bucket
      expect(await attempt(behindProxy, '198.51.100.1')).toBe(429); // same person again
      // Without TRUST_PROXY on the MCP server, everyone shares the server's own address.
      expect(await attempt(direct, '198.51.100.3')).toBe(401);
      expect(await attempt(direct, '198.51.100.4')).toBe(429);
    } finally {
      await behindProxy.close();
      await direct.close();
      await limitedApi.close();
    }
  });
});

describe('MCP -> Sermonize API end to end', () => {
  it('creates and finds persons, attributed to the real user in the audit trail', async () => {
    const name = `Philipp Melanchthon ${run}`;
    const person = await callJson(contributor, 'create_person', {
      display_name: name,
      name_variants: [`Philipp Schwartzerdt ${run}`],
      year_from: 1497,
      year_to: 1560,
    });
    expect(person).toMatchObject({ display_name: name, created_by: users.contributor!.id });

    const { rows } = await pool.query('SELECT actor_id FROM audit_event WHERE entity_id = $1', [person.id]);
    expect(rows.map((r) => r.actor_id)).toContain(users.contributor!.id);

    const found = await callJson(reader, 'search_persons', { q: `schwartzerdt ${run}` });
    expect(found.items.map((p: { id: string }) => p.id)).toEqual([person.id]);
    expect(found.next_cursor).toBeNull();

    expect(await callJson(reader, 'get_person', { person_id: person.id })).toMatchObject({ id: person.id, display_name: name });
  });

  it('paginates with cursor/limit passthrough', async () => {
    for (const n of [1, 2, 3]) await callJson(contributor, 'create_person', { display_name: `Paged ${run} ${n}` });
    const first = await callJson(reader, 'search_persons', { q: `Paged ${run}`, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await callJson(reader, 'search_persons', { q: `Paged ${run}`, limit: 2, cursor: first.next_cursor });
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
  });

  it('creates a work, source and text and reads body slices in code points', async () => {
    const work = await callJson(contributor, 'create_work', {
      title: `Sano vain sana ${run}`,
      genre: 'sermon',
      original_languages: ['fi'],
      year_from: 2024,
      year_to: 2024,
      occasion: { preached_on: '2024-01-21', church_year_day: '3. sunnuntai loppiaisesta', pericopes: ['Matt. 8:5-13'] },
    });
    expect(work).toMatchObject({ genre: 'sermon', occasion: { church_year_day: '3. sunnuntai loppiaisesta' } });

    const source = await callJson(contributor, 'create_source', {
      kind: 'author_submission',
      citation: `Saarnakäsikirjoitus ${run}`,
      access_level: 'public',
    });

    const body = 'Sadanpäämies 𝔖 sanoi: ”Herra.”\nUsko on lahja.';
    const text = await callJson(contributor, 'create_text', {
      work_id: work.id,
      source_id: source.id,
      language: 'fi',
      relation: 'original',
      body,
    });
    expect(text).toMatchObject({ work_id: work.id, char_length: [...body].length });

    expect(await callJson(reader, 'get_text_body', { text_id: text.id })).toEqual({
      text_id: text.id,
      start: 0,
      end: [...body].length,
      content: body,
    });
    // Offsets are code points: the astral 𝔖 counts as one.
    expect(await callJson(reader, 'get_text_body', { text_id: text.id, start: 13, end: 20 })).toMatchObject({
      start: 13,
      end: 20,
      content: '𝔖 sanoi',
    });

    const texts = await callJson(reader, 'list_texts', { work_id: work.id });
    expect(texts.items.map((t: { id: string }) => t.id)).toEqual([text.id]);
    expect(await callJson(reader, 'get_work', { work_id: work.id })).toMatchObject({ id: work.id });
  });

  it('maps API errors to tool errors: 403, 404 and 4xx', async () => {
    const forbidden = await call(reader, 'create_person', { display_name: `Nope ${run}` });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.text).toContain('Sermonize API error forbidden (HTTP 403): requires role contributor or higher');

    const missing = await call(reader, 'get_person', { person_id: randomUUID() });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Sermonize API error not_found (HTTP 404)');

    const work = await callJson(contributor, 'create_work', { title: `Range ${run}`, genre: 'other' });
    const text = await callJson(contributor, 'create_text', { work_id: work.id, language: 'la', relation: 'original', body: 'abc' });
    const range = await call(reader, 'get_text_body', { text_id: text.id, start: 2, end: 99 });
    expect(range.isError).toBe(true);
    expect(range.text).toMatch(/Sermonize API error \w+ \(HTTP 4\d\d\)/);
  });
});
