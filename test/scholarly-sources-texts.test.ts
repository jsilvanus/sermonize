import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createUser, setupTestApp, type TestContext, type TestUser } from './helpers.js';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const sorted = (...xs: string[]) => xs.sort();

describe('sources and texts', () => {
  let ctx: TestContext;
  let reader: TestUser;
  let contributor: TestUser;
  let curator: TestUser;

  beforeAll(async () => {
    ctx = await setupTestApp();
    reader = await createUser(ctx.pool, { role: 'reader' });
    contributor = await createUser(ctx.pool, { role: 'contributor' });
    curator = await createUser(ctx.pool, { role: 'curator' });
  });
  afterAll(() => ctx.close());

  const post = (user: TestUser, url: string, payload: object) => api(ctx.app, user, { method: 'POST', url, payload });
  const get = (user: TestUser, url: string) => api(ctx.app, user, { method: 'GET', url });
  const patch = (user: TestUser, url: string, payload: object) => api(ctx.app, user, { method: 'PATCH', url, payload });
  const ids = (res: { json(): { items: { id: string }[] } }) => res.json().items.map((x) => x.id);

  async function create(url: string, body: object) {
    const res = await post(contributor, url, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }
  const createWork = (body: object = {}) => create('/works', { title: 'Evangelium', genre: 'other', ...body });
  const createSource = (body: object = {}) => create('/sources', { kind: 'print_edition', citation: 'Test edition', ...body });
  const createText = (workId: string, body: object = {}) =>
    create('/texts', { work_id: workId, language: 'la', relation: 'original', body: 'In principio erat verbum.', ...body });

  describe('sources', () => {
    it('creates, gets, patches (curator), withdraws and lists', async () => {
      expect((await post(reader, '/sources', { kind: 'other', citation: 'x' })).statusCode).toBe(403);
      expect((await post(contributor, '/sources', { kind: 'website', citation: 'x' })).statusCode).toBe(400);

      const s = await createSource({
        editor: 'J. Migne',
        series: 'Patrologia Latina',
        volume: '32',
        year: 1841,
        url: 'https://example.org/pl32',
        retrieved_at: '2026-01-02T03:04:05Z',
        license: 'public domain',
        created_by: curator.id,
      });
      expect(s).toMatchObject({
        kind: 'print_edition',
        editor: 'J. Migne',
        access_level: 'public',
        retrieved_at: '2026-01-02T03:04:05.000Z',
        created_by: contributor.id,
        withdrawn_at: null,
      });
      expect((await get(reader, `/sources/${s.id}`)).json()).toEqual(s);

      expect((await patch(contributor, `/sources/${s.id}`, { license: 'CC0' })).statusCode).toBe(403);
      const p = await patch(curator, `/sources/${s.id}`, { license: 'CC0', access_level: 'restricted' });
      expect(p.statusCode).toBe(200);
      expect(p.json()).toMatchObject({ license: 'CC0', access_level: 'restricted', updated_by: curator.id });
      const audit = await ctx.pool.query(
        `SELECT action, changes FROM audit_event WHERE entity_type = 'source' AND entity_id = $1 ORDER BY occurred_at, id`,
        [s.id],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(['insert', 'update']);
      expect(audit.rows[1].changes).toEqual({
        license: { old: 'public domain', new: 'CC0' },
        access_level: { old: 'public', new: 'restricted' },
      });

      const all = async (qs = '') => {
        const out: string[] = [];
        let cursor: string | null = null;
        do {
          const res = await get(reader, `/sources?limit=500${qs}${cursor ? `&cursor=${cursor}` : ''}`);
          out.push(...ids(res));
          cursor = res.json().next_cursor;
        } while (cursor);
        return out;
      };
      expect(await all()).toContain(s.id);
      expect((await post(curator, `/sources/${s.id}/withdraw`, { reason: 'bad scan' })).statusCode).toBe(200);
      expect(await all()).not.toContain(s.id);
      expect(await all('&include_withdrawn=true')).toContain(s.id);
    });
  });

  describe('texts', () => {
    it('POST returns metadata, hash and code-point length but never the body', async () => {
      const work = await createWork();
      const body = 'Ἐν ἀρχῇ ἦν ὁ λόγος 𝔊\nκαὶ ὁ λόγος ἦν πρὸς τὸν θεόν';
      const res = await post(contributor, '/texts', {
        work_id: work.id,
        language: 'grc',
        relation: 'original',
        body,
        title: 'Κατὰ Ἰωάννην',
        created_by: curator.id,
        content_sha256: '0'.repeat(64),
        char_length: 1,
      });
      expect(res.statusCode, res.body).toBe(201);
      const t = res.json();
      expect(t).toMatchObject({
        work_id: work.id,
        language: 'grc',
        relation: 'original',
        coverage: 'complete',
        access_level: 'public',
        effective_access_level: 'public',
        content_sha256: sha256(body),
        char_length: Array.from(body).length,
        created_by: contributor.id,
        persons: [],
      });
      expect(t.char_length).not.toBe(body.length); // astral char: code points != UTF-16 units
      expect(t).not.toHaveProperty('body');
      expect(res.body).not.toContain('λόγος');

      const got = await get(reader, `/texts/${t.id}`);
      expect(got.json()).toEqual(t);
      expect(got.body).not.toContain('λόγος');

      const audit = await ctx.pool.query(
        `SELECT changes FROM audit_event WHERE entity_type = 'text' AND entity_id = $1`,
        [t.id],
      );
      expect(audit.rows[0].changes).not.toHaveProperty('body');
    });

    it('rejects non-NFC bodies and \\r with clear 422 messages', async () => {
      const work = await createWork();
      const base = { work_id: work.id, language: 'fi', relation: 'original' };
      const nfd = await post(contributor, '/texts', { ...base, body: 'Jumala on hyvä' });
      expect(nfd.statusCode).toBe(422);
      expect(nfd.json().error).toMatchObject({ code: 'validation_failed', message: expect.stringMatching(/NFC/) });
      const crlf = await post(contributor, '/texts', { ...base, body: 'rivi 1\r\nrivi 2' });
      expect(crlf.statusCode).toBe(422);
      expect(crlf.json().error.message).toMatch(/\\n line endings/);
      expect((await post(contributor, '/texts', { ...base, body: '' })).statusCode).toBe(400);
      expect((await post(contributor, '/texts', { ...base, body: 'x', language: 'not a tag' })).statusCode).toBe(400);
      expect((await post(reader, '/texts', { ...base, body: 'x' })).statusCode).toBe(403);
    });

    it('allows several originals per work and a work with only a translation', async () => {
      const augsburg = await createWork({ title: 'Confessio Augustana', genre: 'confession' });
      await createText(augsburg.id, { language: 'de', body: 'Erstlich wird einträchtiglich gelehrt' });
      await createText(augsburg.id, { language: 'la', body: 'Ecclesiae magno consensu apud nos docent' });
      const originals = await get(reader, `/texts?work_id=${augsburg.id}&relation=original`);
      expect(originals.json().items).toHaveLength(2);

      const lost = await createWork({ title: 'Lost original' });
      const tr = await createText(lost.id, {
        language: 'en',
        relation: 'translation',
        translated_from_language: 'grc',
        body: 'In the beginning was the Word.',
      });
      expect(tr).toMatchObject({ relation: 'translation', translated_from_language: 'grc', base_text_id: null });
    });

    it('translated_from_language only when relation is not original (POST and PATCH)', async () => {
      const work = await createWork();
      const bad = await post(contributor, '/texts', {
        work_id: work.id,
        language: 'la',
        relation: 'original',
        translated_from_language: 'grc',
        body: 'x',
      });
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error.message).toMatch(/translated_from_language/);

      const tr = await createText(work.id, { language: 'fi', relation: 'translation', translated_from_language: 'la' });
      const toOriginal = await patch(curator, `/texts/${tr.id}`, { relation: 'original' });
      expect(toOriginal.statusCode).toBe(422);
      const ok = await patch(curator, `/texts/${tr.id}`, { relation: 'original', translated_from_language: null });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ relation: 'original', translated_from_language: null });
    });

    it('base_text_id and supersedes_text_id must reference texts of the same work', async () => {
      const work = await createWork();
      const other = await createWork();
      const original = await createText(work.id);
      const foreign = await createText(other.id);

      const tr = await createText(work.id, {
        language: 'en',
        relation: 'translation',
        translated_from_language: 'la',
        base_text_id: original.id,
        body: 'In the beginning was the Word.',
      });
      expect(tr.base_text_id).toBe(original.id);

      const cross = await post(contributor, '/texts', {
        work_id: work.id,
        language: 'en',
        relation: 'translation',
        base_text_id: foreign.id,
        body: 'x',
      });
      expect(cross.statusCode).toBe(422);
      expect(cross.json().error.message).toMatch(/same work/);
      const missing = await post(contributor, '/texts', {
        work_id: work.id,
        language: 'la',
        relation: 'original',
        supersedes_text_id: crypto.randomUUID(),
        body: 'x',
      });
      expect(missing.statusCode).toBe(422);
      expect(missing.json().error.message).toMatch(/existing text/);

      const correction = await createText(work.id, { supersedes_text_id: original.id, body: 'In principio erat Verbum.' });
      expect(correction.supersedes_text_id).toBe(original.id);
      expect((await patch(curator, `/texts/${tr.id}`, { base_text_id: foreign.id })).statusCode).toBe(422);
      // moving a text to another work while its base stays behind is rejected too
      expect((await patch(curator, `/texts/${tr.id}`, { work_id: other.id })).statusCode).toBe(422);
      expect((await post(contributor, '/texts', { work_id: crypto.randomUUID(), language: 'la', relation: 'original', body: 'x' })).statusCode).toBe(422);
    });

    it('GET /texts/:id/body returns code-point ranges (polytonic Greek, astral plane)', async () => {
      const work = await createWork();
      const body = 'Ἐν ἀρχῇ 𝔊 ἦν ὁ λόγος';
      const cps = Array.from(body);
      const t = await createText(work.id, { language: 'grc', body });
      const range = async (qs: string, user = reader) => get(user, `/texts/${t.id}/body${qs}`);

      const full = await range('');
      expect(full.statusCode).toBe(200);
      expect(full.json()).toEqual({ text_id: t.id, start: 0, end: cps.length, content: body });

      const start = cps.indexOf('𝔊');
      const res = await range(`?start=${start}&end=${start + 3}`);
      expect(res.json()).toEqual({ text_id: t.id, start, end: start + 3, content: cps.slice(start, start + 3).join('') });
      expect(res.json().content).toBe('𝔊 ἦ');
      expect((await range('?start=3&end=7')).json().content).toBe('ἀρχῇ');
      expect((await range(`?start=${cps.length}`)).json().content).toBe('');

      const tooFar = await range(`?end=${cps.length + 1}`);
      expect(tooFar.statusCode).toBe(422);
      expect(tooFar.json().error.details).toMatchObject({ char_length: cps.length });
      expect((await range('?start=5&end=4')).statusCode).toBe(422);
      expect((await range('?start=-1')).statusCode).toBe(400);
      expect((await get(reader, `/texts/${crypto.randomUUID()}/body`)).statusCode).toBe(404);
    });

    it('restricted bodies need contributor+; effective access is the most restrictive of text and source', async () => {
      const work = await createWork();
      const restrictedSource = await createSource({ access_level: 'restricted' });
      const publicSource = await createSource();
      const viaSource = await createText(work.id, { source_id: restrictedSource.id });
      const viaText = await createText(work.id, { source_id: publicSource.id, access_level: 'restricted' });
      const open = await createText(work.id, { source_id: publicSource.id });

      expect(viaSource).toMatchObject({ access_level: 'public', effective_access_level: 'restricted' });
      expect(viaText).toMatchObject({ access_level: 'restricted', effective_access_level: 'restricted' });
      expect(open.effective_access_level).toBe('public');

      for (const t of [viaSource, viaText]) {
        const meta = await get(reader, `/texts/${t.id}`);
        expect(meta.statusCode).toBe(200); // readers may see metadata
        const body = await get(reader, `/texts/${t.id}/body`);
        expect(body.statusCode).toBe(403);
        expect(body.json().error.code).toBe('forbidden');
        expect((await get(contributor, `/texts/${t.id}/body`)).statusCode).toBe(200);
      }
      expect((await get(reader, `/texts/${open.id}/body`)).statusCode).toBe(200);

      // restricting the source later restricts its texts
      await patch(curator, `/sources/${publicSource.id}`, { access_level: 'restricted' });
      expect((await get(reader, `/texts/${open.id}/body`)).statusCode).toBe(403);
      expect((await get(reader, `/texts/${open.id}`)).json().effective_access_level).toBe('restricted');
    });

    it('PATCH is curator-only, never accepts body, and writes audit rows', async () => {
      const work = await createWork();
      const t = await createText(work.id);
      expect((await patch(contributor, `/texts/${t.id}`, { title: 'x' })).statusCode).toBe(403);
      const withBody = await patch(curator, `/texts/${t.id}`, { body: 'changed', title: 'x' });
      expect(withBody.statusCode).toBe(409);
      expect(withBody.json().error.code).toBe('immutable');

      const res = await patch(curator, `/texts/${t.id}`, {
        title: 'Liber primus',
        coverage: 'partial',
        coverage_note: 'books 1-3',
        content_sha256: '0'.repeat(64),
        char_length: 3,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        title: 'Liber primus',
        coverage: 'partial',
        content_sha256: t.content_sha256,
        char_length: t.char_length,
        updated_by: curator.id,
      });
      const audit = await ctx.pool.query(
        `SELECT action, actor_id, changes FROM audit_event WHERE entity_type = 'text' AND entity_id = $1 ORDER BY occurred_at, id`,
        [t.id],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(['insert', 'update']);
      expect(audit.rows[1].actor_id).toBe(curator.id);
      expect(Object.keys(audit.rows[1].changes).sort()).toEqual(['coverage', 'coverage_note', 'title']);
      expect((await get(reader, `/texts/${t.id}/body`)).json().content).toBe('In principio erat verbum.');
    });

    it('persons: inline on POST, replaced by PUT (curator only)', async () => {
      const work = await createWork();
      const translator = await create('/persons', { display_name: 'Mikael Agricola' });
      const editor = await create('/persons', { display_name: 'Editor' });
      const t = await createText(work.id, {
        language: 'fi',
        relation: 'translation',
        persons: [{ person_id: translator.id, role: 'translator' }],
      });
      expect(t.persons).toEqual([
        { person_id: translator.id, display_name: 'Mikael Agricola', role: 'translator', note: null },
      ]);
      const put = (user: TestUser, payload: object[]) =>
        api(ctx.app, user, { method: 'PUT', url: `/texts/${t.id}/persons`, payload });
      expect((await put(contributor, [])).statusCode).toBe(403);
      const res = await put(curator, [
        { person_id: translator.id, role: 'translator', note: '1548' },
        { person_id: editor.id, role: 'editor' },
      ]);
      expect(res.statusCode).toBe(200);
      expect(res.json().persons).toHaveLength(2);
      expect((await put(curator, [])).json().persons).toEqual([]);
      expect((await put(curator, [{ person_id: editor.id, role: 'author' }])).statusCode).toBe(400);
    });

    it('lists with filters, pagination and withdrawn hiding', async () => {
      const work = await createWork();
      const source = await createSource();
      const la = await createText(work.id, { source_id: source.id });
      const en = await createText(work.id, { language: 'en', relation: 'translation', body: 'In the beginning' });
      const fi = await createText(work.id, { language: 'fi', relation: 'adaptation', body: 'Alussa oli Sana' });
      const list = (qs: string) => get(reader, `/texts?work_id=${work.id}${qs}`);

      expect(ids(await list(''))).toEqual(sorted(la.id, en.id, fi.id));
      expect(ids(await list('&language=en'))).toEqual([en.id]);
      expect(ids(await list('&relation=adaptation'))).toEqual([fi.id]);
      expect(ids(await list(`&source_id=${source.id}`))).toEqual([la.id]);
      expect((await list('')).body).not.toContain('In the beginning');

      const first = await list('&limit=2');
      expect(first.json().items).toHaveLength(2);
      const second = await list(`&limit=2&cursor=${first.json().next_cursor}`);
      expect(second.json()).toMatchObject({ next_cursor: null });
      expect([...ids(first), ...ids(second)]).toEqual(sorted(la.id, en.id, fi.id));

      const w = await post(curator, `/texts/${fi.id}/withdraw`, { reason: 'duplicate' });
      expect(w.statusCode).toBe(200);
      expect(w.json()).toMatchObject({ withdrawn_by: curator.id, withdrawn_reason: 'duplicate' });
      expect(ids(await list(''))).toEqual(sorted(la.id, en.id));
      expect(ids(await list('&include_withdrawn=true'))).toEqual(sorted(la.id, en.id, fi.id));
      expect((await get(reader, `/texts/${fi.id}`)).json().withdrawn_reason).toBe('duplicate');
      expect((await post(contributor, `/texts/${la.id}/withdraw`, { reason: 'x' })).statusCode).toBe(403);
      expect((await get(reader, '/texts?relation=copy')).statusCode).toBe(400);
    });
  });
});
