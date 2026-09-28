import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_ORDER, api, asSystem, createUser, setupTestApp, type TestContext, type TestUser } from './helpers.js';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const producer = { tool: 'chunker', version: '1.2.3', parameters: { window: 2 } };

/** Polytonic Greek with astral-plane characters (U+1D50A, U+1F54A) before and inside chunks. */
const GREEK = 'Ἐν ἀρχῇ ἦν ὁ λόγος 𝔊 καὶ ὁ λόγος ἦν πρὸς τὸν θεόν 🕊, καὶ θεὸς ἦν ὁ λόγος.';
const cps = Array.from(GREEK);

/** A chunk spec from code-point offsets; its text is the code-point substring. */
function span(sequence: number, start: number, end: number, extra: object = {}) {
  return { sequence, start_offset: start, end_offset: end, text: cps.slice(start, end).join(''), ...extra };
}
/** Code-point index of the first occurrence of `needle` in GREEK. */
function cpIndex(needle: string): number {
  const utf16 = GREEK.indexOf(needle);
  return Array.from(GREEK.slice(0, utf16)).length;
}

describe('segmentations and chunks', () => {
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

  const post = (user: TestUser, url: string, payload: unknown) =>
    api(ctx.app, user, { method: 'POST', url, payload: payload as object });
  const get = (user: TestUser, url: string) => api(ctx.app, user, { method: 'GET', url });

  async function create(url: string, body: object) {
    const res = await post(contributor, url, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }
  async function greekText(extra: object = {}) {
    const work = await create('/works', { title: 'Κατὰ Ἰωάννην', genre: 'other' });
    return create('/texts', { work_id: work.id, language: 'grc', relation: 'original', body: GREEK, ...extra });
  }
  const createSegmentation = (textId: string, extra: object = {}) =>
    create('/segmentations', { text_id: textId, method: 'sentence', producer, ...extra });
  const chunkCount = async (segId: string) => (await get(reader, `/segmentations/${segId}`)).json().chunk_count;

  describe('segmentations', () => {
    it('creates (contributor+, producer required), gets and lists per text', async () => {
      const text = await greekText();
      const bad = { text_id: text.id, method: 'sentence' };
      expect((await post(reader, '/segmentations', { ...bad, producer })).statusCode).toBe(403);
      expect((await post(contributor, '/segmentations', bad)).statusCode).toBe(400);
      expect((await post(contributor, '/segmentations', { ...bad, producer: { tool: 'x' } })).statusCode).toBe(400);
      expect((await post(contributor, '/segmentations', { ...bad, producer: { tool: '', version: '1' } })).statusCode).toBe(400);
      const missing = await post(contributor, '/segmentations', { ...bad, text_id: randomUUID(), producer });
      expect(missing.statusCode).toBe(422);

      const seg = await createSegmentation(text.id, { parameters: { max_tokens: 256 }, created_by: curator.id });
      expect(seg).toMatchObject({
        text_id: text.id,
        method: 'sentence',
        parameters: { max_tokens: 256 },
        producer,
        created_by: contributor.id,
        withdrawn_at: null,
        chunk_count: 0,
      });
      expect((await get(reader, `/segmentations/${seg.id}`)).json()).toEqual(seg);
      expect((await get(reader, `/segmentations/${randomUUID()}`)).statusCode).toBe(404);

      const seg2 = await createSegmentation(text.id, { method: 'window' });
      const list = await get(reader, `/texts/${text.id}/segmentations?limit=1`);
      expect(list.json().items.map((s: { id: string }) => s.id)).toEqual([seg.id]);
      const next = await get(reader, `/texts/${text.id}/segmentations?limit=1&cursor=${list.json().next_cursor}`);
      expect(next.json().items.map((s: { id: string }) => s.id)).toEqual([seg2.id]);
      expect((await get(reader, `/texts/${randomUUID()}/segmentations`)).statusCode).toBe(404);

      // Row-level audit (segmentation is a small derived table).
      const audit = await ctx.pool.query(`SELECT action FROM audit_event WHERE entity_type = 'segmentation' AND entity_id = $1`, [
        seg.id,
      ]);
      expect(audit.rows.map((r) => r.action)).toEqual(['insert']);

      // Withdrawn segmentations are hidden from the list by default.
      await asSystem(ctx.pool, (c) =>
        c.query(`UPDATE segmentation SET withdrawn_at = now(), withdrawn_reason = 'x' WHERE id = $1`, [seg2.id]),
      );
      const visible = await get(reader, `/texts/${text.id}/segmentations`);
      expect(visible.json().items.map((s: { id: string }) => s.id)).toEqual([seg.id]);
      const all = await get(reader, `/texts/${text.id}/segmentations?include_withdrawn=true`);
      expect(all.json().items).toHaveLength(2);
    });

    it('rejects segmentations of withdrawn texts (409)', async () => {
      const text = await greekText();
      expect((await post(curator, `/texts/${text.id}/withdraw`, { reason: 'dup' })).statusCode).toBe(200);
      const res = await post(contributor, '/segmentations', { text_id: text.id, method: 'x', producer });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('chunk ingestion', () => {
    it('validates code-point offsets against the body (polytonic Greek, astral characters)', async () => {
      const text = await greekText();
      expect(text.char_length).toBe(cps.length);
      expect(cps.length).toBeLessThan(GREEK.length); // UTF-16 units != code points
      const seg = await createSegmentation(text.id);

      const g = cpIndex('𝔊');
      const dove = cpIndex('🕊');
      const good = [
        span(0, 0, cpIndex(' ἦν')), // Ἐν ἀρχῇ
        span(1, g, g + 5, { locus: '1.1b', language: 'grc', metadata: { tokens: 3 } }), // 𝔊 καὶ
        span(2, dove - 4, cps.length), // θεόν 🕊, καὶ θεὸς …
      ];
      expect(good[1]!.text).toBe('𝔊 καὶ');

      // UTF-16 offsets for the same substring are wrong in code points.
      const utf16Start = GREEK.indexOf('καὶ ὁ');
      const wrong = { sequence: 3, start_offset: utf16Start, end_offset: utf16Start + 5, text: 'καὶ ὁ' };
      expect(utf16Start).not.toBe(cpIndex('καὶ ὁ'));

      const res = await post(contributor, `/segmentations/${seg.id}/chunks`, [...good, wrong]);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.details).toEqual({
        failed: 1,
        errors: [{ index: 3, sequence: 3, reason: 'text_mismatch', message: expect.any(String) }],
      });
      expect(await chunkCount(seg.id)).toBe(0); // nothing inserted

      const ok = await post(contributor, `/segmentations/${seg.id}/chunks`, good);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toEqual({ inserted: 3, skipped: 0 });

      const list = await get(reader, `/segmentations/${seg.id}/chunks`);
      expect(list.statusCode).toBe(200);
      const items = list.json().items;
      expect(items.map((c: { sequence: number }) => c.sequence)).toEqual([0, 1, 2]);
      expect(items[1]).toMatchObject({
        segmentation_id: seg.id,
        text_id: text.id,
        start_offset: g,
        end_offset: g + 5,
        text: '𝔊 καὶ',
        locus: '1.1b',
        language: 'grc',
        metadata: { tokens: 3 },
        content_sha256: sha256('𝔊 καὶ'),
        created_by: contributor.id,
      });
      expect(items[0]).toMatchObject({ text: 'Ἐν ἀρχῇ', locus: null, language: null, metadata: {} });

      // The chunk text equals the body endpoint's substring for the same offsets.
      for (const c of items) {
        const body = await get(reader, `/texts/${text.id}/body?start=${c.start_offset}&end=${c.end_offset}`);
        expect(body.json().content).toBe(c.text);
      }

      const one = await get(reader, `/chunks/${items[2].id}`);
      expect(one.json()).toEqual({ ...items[2], effective_access_level: 'public' });
      expect((await get(reader, `/chunks/${randomUUID()}`)).statusCode).toBe(404);
    });

    it('reports every invalid item with a reason and inserts nothing', async () => {
      const text = await greekText();
      const seg = await createSegmentation(text.id);
      const n = cps.length;
      const res = await post(contributor, `/segmentations/${seg.id}/chunks`, [
        span(0, 0, 2),
        { sequence: 1, start_offset: n - 1, end_offset: n + 1, text: 'ς.' }, // past the end
        { sequence: 2, start_offset: 0, end_offset: 3, text: 'Ἐν' }, // length mismatch
        { sequence: 3, start_offset: 5, end_offset: 5, text: 'x' }, // empty span
        span(0, 3, 5), // duplicate sequence
        { sequence: 5, start_offset: 0, end_offset: 2, text: 'Εν' }, // text mismatch (no breathing)
      ]);
      expect(res.statusCode).toBe(422);
      const errors = res.json().error.details.errors as Array<{ index: number; reason: string }>;
      // Structural errors are reported before offsets are checked against the body.
      expect(errors.map((e) => [e.index, e.reason])).toEqual([
        [3, 'invalid_offsets'],
        [4, 'duplicate_sequence'],
      ]);

      const res2 = await post(contributor, `/segmentations/${seg.id}/chunks`, [
        span(0, 0, 2),
        { sequence: 1, start_offset: n - 1, end_offset: n + 1, text: 'ς.' },
        { sequence: 2, start_offset: 0, end_offset: 3, text: 'Ἐν' },
        { sequence: 5, start_offset: 0, end_offset: 2, text: 'Εν' },
      ]);
      expect(res2.statusCode).toBe(422);
      expect(res2.json().error.details.errors.map((e: { index: number; sequence: number; reason: string }) => [e.index, e.sequence, e.reason])).toEqual([
        [1, 1, 'offsets_out_of_range'],
        [2, 2, 'length_mismatch'],
        [3, 5, 'text_mismatch'],
      ]);
      expect(await chunkCount(seg.id)).toBe(0);

      // Schema-level errors are 400s.
      expect((await post(contributor, `/segmentations/${seg.id}/chunks`, [])).statusCode).toBe(400);
      expect((await post(contributor, `/segmentations/${seg.id}/chunks`, [{ ...span(0, 0, 2), start_offset: -1 }])).statusCode).toBe(400);
      expect((await post(contributor, `/segmentations/${seg.id}/chunks`, [span(0, 0, 2, { language: 'no tag' })])).statusCode).toBe(400);
      expect((await post(reader, `/segmentations/${seg.id}/chunks`, [span(0, 0, 2)])).statusCode).toBe(403);
      expect((await post(contributor, `/segmentations/${randomUUID()}/chunks`, [span(0, 0, 2)])).statusCode).toBe(404);
    });

    it('is idempotent on (segmentation, sequence) and detects conflicting retries', async () => {
      const text = await greekText();
      const seg = await createSegmentation(text.id);
      const ids = [randomUUID(), randomUUID()];
      const first = [span(0, 0, 2, { id: ids[0] }), span(1, 3, 7, { id: ids[1], metadata: { a: 1 } })];

      const r1 = await post(contributor, `/segmentations/${seg.id}/chunks`, first);
      expect(r1.json()).toEqual({ inserted: 2, skipped: 0 });
      const requestId = r1.headers['x-request-id'];

      // Exact retry: everything skipped, no new audit event.
      const r2 = await post(contributor, `/segmentations/${seg.id}/chunks`, first);
      expect(r2.statusCode).toBe(200);
      expect(r2.json()).toEqual({ inserted: 0, skipped: 2 });

      // Retry without client ids plus a new chunk: old ones skipped, new one inserted.
      const r3 = await post(contributor, `/segmentations/${seg.id}/chunks`, [
        span(0, 0, 2),
        span(1, 3, 7, { metadata: { a: 1 } }),
        span(2, 8, 10),
      ]);
      expect(r3.json()).toEqual({ inserted: 1, skipped: 2 });

      const chunks = (await get(reader, `/segmentations/${seg.id}/chunks`)).json().items;
      expect(chunks.map((c: { id: string }) => c.id).slice(0, 2)).toEqual(ids);

      // Same key, different content -> 409 listing the keys; the new chunk in that batch is not inserted.
      const conflicts: Array<[object, string]> = [
        [span(1, 3, 8), 'offsets'],
        [span(1, 3, 7, { metadata: { a: 2 } }), 'metadata'],
        [span(1, 3, 7, { metadata: { a: 1 }, locus: 'x' }), 'locus'],
        [span(1, 3, 7, { metadata: { a: 1 }, id: randomUUID() }), 'id'],
      ];
      for (const [item, what] of conflicts) {
        const res = await post(contributor, `/segmentations/${seg.id}/chunks`, [span(3, 11, 13), item]);
        expect(res.statusCode, what).toBe(409);
        expect(res.json().error.details.conflicts, what).toEqual([{ index: 1, sequence: 1, existing_id: ids[1] }]);
      }
      expect(await chunkCount(seg.id)).toBe(3);

      // A client id already used by another chunk is a 409 as well.
      const dupId = await post(contributor, `/segmentations/${seg.id}/chunks`, [span(4, 0, 2, { id: ids[0] })]);
      expect(dupId.statusCode).toBe(409);

      // One batch_insert audit event per inserting request.
      const audit = await ctx.pool.query(
        `SELECT actor_id, batch_count, request_id, changes FROM audit_event
          WHERE action = 'batch_insert' AND entity_type = 'chunk' AND entity_id = $1 ORDER BY ${AUDIT_ORDER}`,
        [seg.id],
      );
      expect(audit.rows).toHaveLength(2);
      expect(audit.rows[0]).toEqual({
        actor_id: contributor.id,
        batch_count: 2,
        request_id: requestId,
        changes: { parent_type: 'segmentation', skipped: 0 },
      });
      expect(audit.rows[1]).toMatchObject({ batch_count: 1, changes: { parent_type: 'segmentation', skipped: 2 } });
    });

    it('rejects chunks for withdrawn segmentations and texts (409)', async () => {
      const text = await greekText();
      const seg = await createSegmentation(text.id);
      const seg2 = await createSegmentation(text.id);
      await asSystem(ctx.pool, (c) =>
        c.query(`UPDATE segmentation SET withdrawn_at = now(), withdrawn_reason = 'x' WHERE id = $1`, [seg.id]),
      );
      const r1 = await post(contributor, `/segmentations/${seg.id}/chunks`, [span(0, 0, 2)]);
      expect(r1.statusCode).toBe(409);
      expect(r1.json().error.message).toMatch(/segmentation is withdrawn/);
      await post(curator, `/texts/${text.id}/withdraw`, { reason: 'dup' });
      const r2 = await post(contributor, `/segmentations/${seg2.id}/chunks`, [span(0, 0, 2)]);
      expect(r2.statusCode).toBe(409);
      expect(r2.json().error.message).toMatch(/text is withdrawn/);
    });

    it('enforces MAX_BATCH_ITEMS', async () => {
      const small = await setupTestApp({ maxBatchItems: 2 });
      try {
        const text = await greekText();
        const seg = await createSegmentation(text.id);
        const url = `/segmentations/${seg.id}/chunks`;
        const three = [span(0, 0, 2), span(1, 3, 5), span(2, 6, 8)];
        const res = await api(small.app, contributor, { method: 'POST', url, payload: three });
        expect(res.statusCode).toBe(400);
        const ok = await api(small.app, contributor, { method: 'POST', url, payload: three.slice(0, 2) });
        expect(ok.json()).toEqual({ inserted: 2, skipped: 0 });
      } finally {
        await small.close();
      }
    });
  });

  describe('chunk reads', () => {
    it('paginates by sequence', async () => {
      const text = await greekText();
      const seg = await createSegmentation(text.id);
      // Inserted out of order; listed by sequence.
      await post(contributor, `/segmentations/${seg.id}/chunks`, [span(10, 0, 2), span(2, 3, 5), span(7, 6, 8), span(3, 0, 5)]);
      const seqs: number[] = [];
      let cursor: string | null = null;
      do {
        const res = await get(reader, `/segmentations/${seg.id}/chunks?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.statusCode).toBe(200);
        seqs.push(...res.json().items.map((c: { sequence: number }) => c.sequence));
        cursor = res.json().next_cursor;
      } while (cursor);
      expect(seqs).toEqual([2, 3, 7, 10]);
      const badCursor = Buffer.from('abc').toString('base64url');
      expect((await get(reader, `/segmentations/${seg.id}/chunks?cursor=${badCursor}`)).statusCode).toBe(400);
      expect((await get(reader, `/segmentations/${randomUUID()}/chunks`)).statusCode).toBe(404);
    });

    it('restricted texts: chunk text requires contributor+ (text or source restricted)', async () => {
      const restrictedText = await greekText({ access_level: 'restricted' });
      const source = await create('/sources', { kind: 'other', citation: 'private', access_level: 'restricted' });
      const viaSource = await greekText({ source_id: source.id });
      for (const text of [restrictedText, viaSource]) {
        const seg = await createSegmentation(text.id);
        await post(contributor, `/segmentations/${seg.id}/chunks`, [span(0, 0, 2)]);
        const list = await get(contributor, `/segmentations/${seg.id}/chunks`);
        expect(list.statusCode).toBe(200);
        const chunk = list.json().items[0];

        const r1 = await get(reader, `/segmentations/${seg.id}/chunks`);
        expect(r1.statusCode).toBe(403);
        expect(r1.body).not.toContain(chunk.text);
        const r2 = await get(reader, `/chunks/${chunk.id}`);
        expect(r2.statusCode).toBe(403);
        expect(r2.body).not.toContain(chunk.text);
        // Metadata of the segmentation stays readable.
        expect((await get(reader, `/segmentations/${seg.id}`)).statusCode).toBe(200);

        const c = await get(contributor, `/chunks/${chunk.id}`);
        expect(c.json()).toMatchObject({ text: chunk.text, effective_access_level: 'restricted' });
      }
    });
  });
});
