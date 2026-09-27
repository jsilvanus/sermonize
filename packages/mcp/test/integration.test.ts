/**
 * End to end: MCP client -> MCP HTTP server (OAuth access token) -> per-user token lookup ->
 * SermonizeClient -> the real Sermonize API (buildApp from @sermonize/api) -> the test database.
 *
 * The database is shared with the API suite and is NOT reset here (see test/global-setup.ts):
 * this file creates its own users and uniquely named rows and only asserts on those.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildApp } from '@sermonize/api/app';
import { withTransaction } from '@sermonize/api/db/transaction';
import { SYSTEM_PRINCIPAL, type Role } from '@sermonize/api/lib/principal';
import { createUser, issueToken, revokeToken } from '@sermonize/api/lib/users';
import { NO_API_TOKEN_MESSAGE } from '../src/mcp/server.js';
import { TEST_DATABASE_URL } from './db-url.js';
import { call, callJson, startMcpServer, type McpTestServer } from './helpers.js';

let pool: pg.Pool;
let api: Awaited<ReturnType<typeof buildApp>>;
let mcp: McpTestServer;
const sermonizeUsers: Record<string, { id: string; token: string; tokenId: string }> = {};
const run = randomUUID().slice(0, 8); // makes names unique per run

async function sermonizeUser(role: Role) {
  return withTransaction(pool, SYSTEM_PRINCIPAL, `mcp-test:${randomUUID()}`, async (client) => {
    const user = await createUser(client, { kind: 'human', role });
    const token = await issueToken(client, { userId: user.id, name: 'mcp-test', expiresAt: null });
    return { id: user.id, token: token.token, tokenId: token.id };
  });
}

let contributor: Client;
let reader: Client;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  api = await buildApp({ pool });
  await api.listen({ host: '127.0.0.1', port: 0 });
  const address = api.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');

  sermonizeUsers.contributor = await sermonizeUser('contributor');
  sermonizeUsers.reader = await sermonizeUser('reader');
  sermonizeUsers.revoked = await sermonizeUser('curator');
  await withTransaction(pool, SYSTEM_PRINCIPAL, `mcp-test:${randomUUID()}`, (c) =>
    revokeToken(c, sermonizeUsers.revoked!.tokenId),
  );

  mcp = await startMcpServer(`http://127.0.0.1:${address.port}`);
  mcp.addUser('mcp-contributor', sermonizeUsers.contributor.token);
  mcp.addUser('mcp-reader', sermonizeUsers.reader.token);
  mcp.addUser('mcp-revoked', sermonizeUsers.revoked.token);
  mcp.addUser('mcp-unlinked');
  contributor = await mcp.connect('mcp-contributor');
  reader = await mcp.connect('mcp-reader');
});

afterAll(async () => {
  await mcp?.close();
  await api?.close();
  await pool?.end();
});

describe('MCP -> Sermonize API end to end', () => {
  it('whoami reports the Sermonize user mapped to the MCP user', async () => {
    expect(await callJson(contributor, 'whoami')).toEqual({
      user_id: sermonizeUsers.contributor!.id,
      role: 'contributor',
      kind: 'human',
    });
    expect(await callJson(reader, 'whoami')).toMatchObject({ user_id: sermonizeUsers.reader!.id, role: 'reader' });
  });

  it('creates and finds persons, attributed to the real user in the audit trail', async () => {
    const name = `Philipp Melanchthon ${run}`;
    const person = await callJson(contributor, 'create_person', {
      display_name: name,
      name_variants: [`Philipp Schwartzerdt ${run}`],
      year_from: 1497,
      year_to: 1560,
    });
    expect(person).toMatchObject({ display_name: name, created_by: sermonizeUsers.contributor!.id });

    const { rows } = await pool.query('SELECT actor_id FROM audit_event WHERE entity_id = $1', [person.id]);
    expect(rows.map((r) => r.actor_id)).toContain(sermonizeUsers.contributor!.id);

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

  it('maps API errors to tool errors: 403, 404, 422 and 401', async () => {
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

    const revoked = await mcp.connect('mcp-revoked');
    const unauthorized = await call(revoked, 'whoami');
    expect(unauthorized.isError).toBe(true);
    expect(unauthorized.text).toContain('Sermonize API error unauthorized (HTTP 401)');
    expect(unauthorized.text).not.toContain(sermonizeUsers.revoked!.token);
  });

  it('refuses users without a linked token without calling the API', async () => {
    const unlinked = await mcp.connect('mcp-unlinked');
    expect(await call(unlinked, 'whoami')).toEqual({ isError: true, text: NO_API_TOKEN_MESSAGE });
  });
});
