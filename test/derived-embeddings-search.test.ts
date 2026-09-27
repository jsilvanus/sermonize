import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../src/db/transaction.js';
import { createVectorIndex, dropVectorIndex, indexStatus } from '../src/lib/vector-index.js';
import { indexName } from '../src/lib/vector.js';
import { buildSearchSql, runSearch, type SearchInput } from '../src/routes/derived/search.js';
import { api, asSystem, createUser, setupTestApp, SYSTEM_PRINCIPAL, type TestContext, type TestUser } from './helpers.js';

const producer = { tool: 'embedder', version: '0.9' };

describe('embedding spaces, embeddings and search', () => {
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
  const createSpace = (extra: object = {}) =>
    create('/embedding-spaces', {
      name: `space-${randomUUID()}`,
      model: 'test-model',
      revision: 'r1',
      dimensions: 3,
      metric: 'cosine',
      normalized: false,
      producer,
      ...extra,
    });

  /**
   * Creates a text whose body is `parts` joined by '\n', one segmentation and
   * one chunk per part. Returns the text and the chunk ids in order.
   */
  async function textWithChunks(workId: string, parts: string[], textExtra: object = {}, chunkExtra: object[] = []) {
    const body = parts.join('\n');
    const text = await create('/texts', { work_id: workId, language: 'la', relation: 'original', body, ...textExtra });
    const seg = await create('/segmentations', { text_id: text.id, method: 'line', producer });
    let offset = 0;
    const chunks = parts.map((part, i) => {
      const len = Array.from(part).length;
      const c = { sequence: i, start_offset: offset, end_offset: offset + len, text: part, ...(chunkExtra[i] ?? {}) };
      offset += len + 1;
      return c;
    });
    const res = await post(contributor, `/segmentations/${seg.id}/chunks`, chunks);
    expect(res.statusCode, res.body).toBe(200);
    const list = await get(contributor, `/segmentations/${seg.id}/chunks?limit=500`);
    return { text, seg, chunkIds: list.json().items.map((c: { id: string }) => c.id) as string[] };
  }

  async function embed(spaceId: string, items: Array<{ chunk_id: string; vector: number[] }>, as = contributor) {
    const res = await post(as, `/embedding-spaces/${spaceId}/embeddings`, items);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  const search = (user: TestUser, body: object) => post(user, '/search', body);
  const hitChunkIds = (res: { json(): { items: Array<{ chunk: { id: string } }> } }) =>
    res.json().items.map((h) => h.chunk.id);

  describe('embedding spaces', () => {
    it('creates (contributor+), gets and lists; name is unique', async () => {
      const body = {
        name: `bge-m3-${randomUUID()}`,
        model: 'BAAI/bge-m3',
        revision: 'abc123',
        dimensions: 1024,
        element_type: 'float32',
        metric: 'cosine',
        normalized: true,
        document_prefix: null,
        query_prefix: 'query: ',
        max_tokens: 8192,
        truncation: 'end',
        pooling: 'cls',
        is_multilingual: true,
        producer,
        metadata: { note: 'x' },
        created_by: curator.id,
      };
      expect((await post(reader, '/embedding-spaces', body)).statusCode).toBe(403);
      const s = await create('/embedding-spaces', body);
      const { created_by: _ignored, ...expected } = body;
      expect(s).toMatchObject({ ...expected, created_by: contributor.id, withdrawn_at: null, hnsw_index: 'absent' });
      expect((await get(reader, `/embedding-spaces/${s.id}`)).json()).toEqual(s);
      expect((await post(contributor, '/embedding-spaces', body)).statusCode).toBe(409);
      for (const bad of [{ dimensions: 0 }, { dimensions: 16001 }, { metric: 'dot' }, { producer: {} }, { normalized: undefined }]) {
        const res = await post(contributor, '/embedding-spaces', { ...body, name: randomUUID(), ...bad });
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      }
      const minimal = await createSpace();
      expect(minimal).toMatchObject({ element_type: 'float32', is_multilingual: false, metadata: {}, max_tokens: null });

      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await get(reader, `/embedding-spaces?limit=500${cursor ? `&cursor=${cursor}` : ''}`);
        ids.push(...res.json().items.map((x: { id: string }) => x.id));
        cursor = res.json().next_cursor;
      } while (cursor);
      expect(ids).toEqual(expect.arrayContaining([s.id, minimal.id]));
      expect((await get(reader, `/embedding-spaces/${randomUUID()}`)).statusCode).toBe(404);
    });
  });

  describe('embedding ingestion', () => {
    it('validates dimensions, values, chunks; idempotent retry; conflicts; batch audit', async () => {
      const work = await create('/works', { title: 'W', genre: 'other' });
      const { chunkIds } = await textWithChunks(work.id, ['alpha', 'beta', 'gamma']);
      const space = await createSpace();
      const url = `/embedding-spaces/${space.id}/embeddings`;

      // Validation: every failing item reported, nothing inserted.
      const bad = await post(contributor, url, [
        { chunk_id: chunkIds[0], vector: [1, 2] },
        { chunk_id: chunkIds[1], vector: [0, 0, 0] },
        { chunk_id: randomUUID(), vector: [1, 2, 3] },
        { chunk_id: chunkIds[2], vector: [1e39, 0, 0] },
      ]);
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error.details.errors.map((e: { index: number; reason: string }) => [e.index, e.reason])).toEqual([
        [0, 'invalid_vector'],
        [1, 'invalid_vector'],
        [2, 'chunk_not_found'],
        [3, 'invalid_vector'],
      ]);
      expect(bad.json().error.details.errors[0].message).toMatch(/2 dimensions, space requires 3/);
      // JSON cannot carry Infinity, but 1e999 parses to it; the schema validator already rejects it
      // (vectorProblem() re-checks finiteness in case a body reaches the handler some other way).
      const inf = await api(ctx.app, contributor, {
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: `[{"chunk_id":"${chunkIds[0]}","vector":[1e999,0,0]}]`,
      });
      expect(inf.statusCode).toBe(400);
      const dup = await post(contributor, url, [
        { chunk_id: chunkIds[0], vector: [1, 0, 0] },
        { chunk_id: chunkIds[0], vector: [1, 0, 0] },
      ]);
      expect(dup.statusCode).toBe(422);
      expect(dup.json().error.details.errors[0]).toMatchObject({ index: 1, reason: 'duplicate_chunk_id' });
      expect((await post(contributor, url, [{ chunk_id: chunkIds[0], vector: [] }])).statusCode).toBe(400);
      expect((await post(reader, url, [{ chunk_id: chunkIds[0], vector: [1, 0, 0] }])).statusCode).toBe(403);
      expect((await post(contributor, `/embedding-spaces/${randomUUID()}/embeddings`, [{ chunk_id: chunkIds[0], vector: [1, 0, 0] }])).statusCode).toBe(404);
      const count = async () =>
        (await ctx.pool.query('SELECT count(*)::int AS n FROM embedding WHERE embedding_space_id = $1', [space.id])).rows[0].n;
      expect(await count()).toBe(0);

      const id0 = randomUUID();
      const batch = [
        { id: id0, chunk_id: chunkIds[0], vector: [0.5, 0.25, -1], metadata: { tokens: 1 } },
        { chunk_id: chunkIds[1], vector: [0.1, 0.2, 0.3] },
      ];
      const r1 = await post(contributor, url, batch);
      expect(r1.json()).toEqual({ inserted: 2, skipped: 0 });
      expect(await post(contributor, url, batch).then((r) => r.json())).toEqual({ inserted: 0, skipped: 2 });
      const r3 = await post(contributor, url, [...batch.slice(1), { chunk_id: chunkIds[2], vector: [3, 2, 1] }]);
      expect(r3.json()).toEqual({ inserted: 1, skipped: 1 });

      // Same (chunk, space) with a different vector, metadata or id -> 409.
      for (const changed of [
        { ...batch[0], vector: [0.5, 0.25, -0.99] },
        { ...batch[0], metadata: {} },
        { ...batch[0], id: randomUUID() },
      ]) {
        const res = await post(contributor, url, [changed]);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.details.conflicts).toEqual([{ index: 0, chunk_id: chunkIds[0], existing_id: id0 }]);
      }
      expect(await count()).toBe(3);

      // Vectors are returned only when asked for.
      const plain = await get(reader, `/chunks/${chunkIds[0]}`);
      expect(plain.json()).not.toHaveProperty('embeddings');
      const listed = await get(reader, `/chunks/${chunkIds[0]}?include_embeddings=true`);
      expect(listed.json().embeddings).toEqual([
        {
          id: id0,
          embedding_space_id: space.id,
          space_name: space.name,
          dimensions: 3,
          metric: 'cosine',
          created_at: expect.any(String),
        },
      ]);
      const withVectors = await get(reader, `/chunks/${chunkIds[0]}?include_embeddings=true&include_vectors=true`);
      expect(withVectors.json().embeddings[0].vector).toEqual([0.5, 0.25, -1]);

      const audit = await ctx.pool.query(
        `SELECT batch_count, actor_id, request_id, changes FROM audit_event
          WHERE action = 'batch_insert' AND entity_type = 'embedding' AND entity_id = $1 ORDER BY occurred_at, id`,
        [space.id],
      );
      expect(audit.rows).toEqual([
        { batch_count: 2, actor_id: contributor.id, request_id: r1.headers['x-request-id'], changes: { parent_type: 'embedding_space', skipped: 0 } },
        { batch_count: 1, actor_id: contributor.id, request_id: r3.headers['x-request-id'], changes: { parent_type: 'embedding_space', skipped: 1 } },
      ]);
    });

    it('checks normalisation, withdrawn chunks and withdrawn spaces', async () => {
      const work = await create('/works', { title: 'W', genre: 'other' });
      const { text, chunkIds } = await textWithChunks(work.id, ['one', 'two']);
      const normalized = await createSpace({ normalized: true, metric: 'inner_product' });
      const url = `/embedding-spaces/${normalized.id}/embeddings`;
      const notUnit = await post(contributor, url, [{ chunk_id: chunkIds[0], vector: [1, 1, 0] }]);
      expect(notUnit.statusCode).toBe(422);
      expect(notUnit.json().error.details.errors[0].message).toMatch(/normalized/);
      await embed(normalized.id, [{ chunk_id: chunkIds[0]!, vector: [0.6, 0.8, 0] }]);

      await post(curator, `/texts/${text.id}/withdraw`, { reason: 'dup' });
      const withdrawn = await post(contributor, url, [{ chunk_id: chunkIds[1], vector: [0, 1, 0] }]);
      expect(withdrawn.statusCode).toBe(422);
      expect(withdrawn.json().error.details.errors[0].reason).toBe('chunk_withdrawn');

      const other = await textWithChunks(work.id, ['three']);
      await asSystem(ctx.pool, (c) =>
        c.query(`UPDATE embedding_space SET withdrawn_at = now(), withdrawn_reason = 'x' WHERE id = $1`, [normalized.id]),
      );
      const res = await post(contributor, url, [{ chunk_id: other.chunkIds[0], vector: [0, 1, 0] }]);
      expect(res.statusCode).toBe(409);
      const s = await search(reader, { embedding_space_id: normalized.id, vector: [1, 0, 0] });
      expect(s.statusCode).toBe(409);
      const list = await get(reader, '/embedding-spaces?limit=500');
      expect(list.json().items.map((x: { id: string }) => x.id)).not.toContain(normalized.id);
    });

    it('the database still rejects a dimension mismatch (SZ004 -> 422)', async () => {
      const work = await create('/works', { title: 'W', genre: 'other' });
      const { chunkIds } = await textWithChunks(work.id, ['x']);
      const space = await createSpace();
      await expect(
        asSystem(ctx.pool, (c) =>
          c.query(`INSERT INTO embedding (chunk_id, embedding_space_id, vector) VALUES ($1, $2, '[1,2]')`, [chunkIds[0], space.id]),
        ),
      ).rejects.toMatchObject({ code: 'SZ004' });
    });
  });

  describe('search', () => {
    // Vectors chosen so that each metric orders them differently for q = [1, 0, 0]:
    //   cosine: A B C D   inner product: B A C D   l2: A C D B
    const vectors = { A: [1, 0.1, 0], B: [3, 1, 0], C: [0.5, 0, 0.5], D: [0, 1, 0] };
    let chunkByName: Record<string, string>;

    beforeAll(async () => {
      const work = await create('/works', { title: 'Metric test', genre: 'other' });
      const { chunkIds } = await textWithChunks(work.id, ['A text', 'B text', 'C text', 'D text']);
      chunkByName = { A: chunkIds[0]!, B: chunkIds[1]!, C: chunkIds[2]!, D: chunkIds[3]! };
    });

    it.each([
      ['cosine', ['A', 'B', 'C', 'D']],
      ['inner_product', ['B', 'A', 'C', 'D']],
      ['l2', ['A', 'C', 'D', 'B']],
    ] as const)('orders by the %s operator', async (metric, order) => {
      const space = await createSpace({ metric });
      await embed(
        space.id,
        Object.entries(vectors).map(([name, vector]) => ({ chunk_id: chunkByName[name]!, vector })),
      );
      const res = await search(reader, { embedding_space_id: space.id, vector: [1, 0, 0], limit: 10 });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ embedding_space_id: space.id, metric });
      expect(hitChunkIds(res)).toEqual(order.map((n) => chunkByName[n]));

      const a = body.items.find((h: { chunk: { id: string } }) => h.chunk.id === chunkByName.A);
      const b = body.items.find((h: { chunk: { id: string } }) => h.chunk.id === chunkByName.B);
      if (metric === 'cosine') {
        expect(a.distance).toBeCloseTo(1 - 1 / Math.sqrt(1.01), 5);
        expect(a.similarity).toBeCloseTo(1 / Math.sqrt(1.01), 5);
      } else if (metric === 'inner_product') {
        expect(b.distance).toBeCloseTo(-3, 5); // <#> is the negative inner product
        expect(b.similarity).toBeCloseTo(3, 5);
      } else {
        expect(a.distance).toBeCloseTo(0.1, 5);
        expect(a.similarity).toBeNull();
      }
      const distances = body.items.map((h: { distance: number }) => h.distance);
      expect(distances).toEqual([...distances].sort((x, y) => x - y));

      const top2 = await search(reader, { embedding_space_id: space.id, vector: [1, 0, 0], limit: 2 });
      expect(hitChunkIds(top2)).toEqual(order.slice(0, 2).map((n) => chunkByName[n]));
    });

    it('validates the request', async () => {
      const space = await createSpace();
      expect((await search(reader, { embedding_space_id: space.id, vector: [1, 0] })).statusCode).toBe(422);
      expect((await search(reader, { embedding_space_id: space.id, vector: [0, 0, 0] })).statusCode).toBe(422);
      expect((await search(reader, { embedding_space_id: randomUUID(), vector: [1, 0, 0] })).statusCode).toBe(404);
      expect((await search(reader, { embedding_space_id: space.id, vector: [1, 0, 0], limit: 201 })).statusCode).toBe(400);
      expect((await search(reader, { embedding_space_id: space.id, vector: [1, 0, 0], filters: { genre: 'novel' } })).statusCode).toBe(400);
      const years = await search(reader, { embedding_space_id: space.id, vector: [1, 0, 0], filters: { year_from: 5, year_to: 1 } });
      expect(years.statusCode).toBe(422);
      const empty = await search(reader, { embedding_space_id: space.id, vector: [1, 0, 0] });
      expect(empty.json().items).toEqual([]);
    });

    describe('filters and access', () => {
      let space: { id: string };
      const c: Record<string, string> = {};
      let luther: { id: string };
      let augustine: { id: string };
      let sermon: { id: string };
      let treatise: { id: string };

      beforeAll(async () => {
        luther = await create('/persons', { display_name: 'Martin Luther' });
        augustine = await create('/persons', { display_name: 'Augustinus Hipponensis' });
        sermon = await create('/works', {
          title: 'Sermo de duplici iustitia',
          genre: 'sermon',
          year_from: 1518,
          year_to: 1519,
          persons: [{ person_id: luther.id, role: 'author' }],
        });
        treatise = await create('/works', {
          title: 'Confessiones',
          genre: 'treatise',
          year_from: 397,
          year_to: 400,
          persons: [{ person_id: augustine.id, role: 'author', certainty: 'certain' }],
        });
        // sermon: Latin original (1519) with one German chunk, Finnish translation (1990)
        const la = await textWithChunks(sermon.id, ['duplex iustitia', 'Deutsch hier'], { year_from: 1519 }, [{}, { language: 'de' }]);
        const fi = await textWithChunks(sermon.id, ['kaksinainen vanhurskaus'], {
          language: 'fi',
          relation: 'translation',
          translated_from_language: 'la',
          year_from: 1990,
          year_to: 1990,
        });
        // treatise: Latin original in an 1841 edition; restricted English translation (2000)
        const conf = await textWithChunks(treatise.id, ['inquietum est cor nostrum'], { year_from: 1841 });
        const en = await textWithChunks(treatise.id, ['our heart is restless'], {
          language: 'en',
          relation: 'translation',
          year_from: 2000,
          access_level: 'restricted',
        });
        Object.assign(c, {
          la: la.chunkIds[0],
          de: la.chunkIds[1],
          fi: fi.chunkIds[0],
          conf: conf.chunkIds[0],
          en: en.chunkIds[0],
        });
        space = await createSpace();
        // Distances from q = [1,0,0] increase in this order: la, de, fi, conf, en.
        await embed(space.id, [
          { chunk_id: c.la!, vector: [1, 0.05, 0] },
          { chunk_id: c.de!, vector: [1, 0.2, 0] },
          { chunk_id: c.fi!, vector: [1, 0.5, 0] },
          { chunk_id: c.conf!, vector: [1, 1, 0] },
          { chunk_id: c.en!, vector: [0.2, 1, 0] },
        ]);
      });

      const q = (filters: object = {}, as = reader) =>
        search(as, { embedding_space_id: space.id, vector: [1, 0, 0], limit: 50, filters });
      const names = (res: Awaited<ReturnType<typeof q>>) =>
        hitChunkIds(res).map((id: string) => Object.keys(c).find((k) => c[k] === id));

      it('returns chunk, text, work and author summaries; excludes restricted by default', async () => {
        const res = await q();
        expect(res.statusCode, res.body).toBe(200);
        expect(names(res)).toEqual(['la', 'de', 'fi', 'conf']);
        expect(res.body).not.toContain('restless');
        const hit = res.json().items[1];
        expect(hit).toMatchObject({
          chunk: { id: c.de, sequence: 1, text: 'Deutsch hier', language: 'de', locus: null },
          text: { language: 'la', relation: 'original', year_from: 1519, effective_access_level: 'public' },
          work: { id: sermon.id, title: 'Sermo de duplici iustitia', genre: 'sermon', year_from: 1518, year_to: 1519 },
          authors: [{ person_id: luther.id, display_name: 'Martin Luther', role: 'author', certainty: 'certain' }],
        });
        expect(hit.chunk.start_offset).toBe('duplex iustitia'.length + 1);
      });

      it('restricted chunks need contributor+ and include_restricted', async () => {
        expect(names(await q({}, contributor))).toEqual(['la', 'de', 'fi', 'conf']);
        const withRestricted = await q({ include_restricted: true }, contributor);
        expect(names(withRestricted)).toEqual(['la', 'de', 'fi', 'conf', 'en']);
        expect(withRestricted.json().items[4].text.effective_access_level).toBe('restricted');
        const denied = await q({ include_restricted: true }, reader);
        expect(denied.statusCode).toBe(403);
        expect(names(await q({ include_restricted: false }, contributor))).not.toContain('en');
      });

      it('filters by language, work, person, relation, genre and years', async () => {
        const as = contributor;
        const all = { include_restricted: true };
        expect(names(await q({ ...all, language: 'la' }, as))).toEqual(['la', 'conf']); // chunk override excluded
        expect(names(await q({ ...all, language: 'de' }, as))).toEqual(['de']);
        expect(names(await q({ ...all, work_id: treatise.id }, as))).toEqual(['conf', 'en']);
        expect(names(await q({ ...all, person_id: luther.id }, as))).toEqual(['la', 'de', 'fi']);
        expect(names(await q({ ...all, person_id: randomUUID() }, as))).toEqual([]);
        expect(names(await q({ ...all, relation: 'translation' }, as))).toEqual(['fi', 'en']);
        expect(names(await q({ ...all, genre: 'treatise' }, as))).toEqual(['conf', 'en']);
        // Text dates (default): 1519, 1990, 1841, 2000.
        expect(names(await q({ ...all, year_from: 1800, year_to: 1999 }, as))).toEqual(['fi', 'conf']);
        expect(names(await q({ ...all, year_to: 1600 }, as))).toEqual(['la', 'de']);
        expect(names(await q({ ...all, year_from: 1995, date_basis: 'text' }, as))).toEqual(['en']);
        // Work dates: sermon 1518–1519, treatise 397–400.
        expect(names(await q({ ...all, year_from: 300, year_to: 500, date_basis: 'work' }, as))).toEqual(['conf', 'en']);
        expect(names(await q({ ...all, year_from: 1519, date_basis: 'work' }, as))).toEqual(['la', 'de', 'fi']);
        // Combined.
        expect(names(await q({ ...all, genre: 'sermon', relation: 'original', language: 'la' }, as))).toEqual(['la']);
      });

      it('excludes withdrawn chunks (segmentation, text or work withdrawn)', async () => {
        const w = await create('/works', { title: 'Temporary', genre: 'other' });
        const a = await textWithChunks(w.id, ['temp a']);
        const b = await textWithChunks(w.id, ['temp b']);
        const tmpSpace = await createSpace();
        await embed(tmpSpace.id, [
          { chunk_id: a.chunkIds[0]!, vector: [1, 0, 0] },
          { chunk_id: b.chunkIds[0]!, vector: [1, 0.1, 0] },
        ]);
        const run = async () =>
          hitChunkIds(await search(reader, { embedding_space_id: tmpSpace.id, vector: [1, 0, 0] }));
        expect(await run()).toEqual([a.chunkIds[0], b.chunkIds[0]]);
        await asSystem(ctx.pool, (cl) =>
          cl.query(`UPDATE segmentation SET withdrawn_at = now(), withdrawn_reason = 'x' WHERE id = $1`, [a.seg.id]),
        );
        expect(await run()).toEqual([b.chunkIds[0]]);
        await post(curator, `/works/${w.id}/withdraw`, { reason: 'x' });
        expect(await run()).toEqual([]);
      });
    });
  });

  describe('HNSW indexes (CLI create-index / drop-index)', () => {
    /** Deterministic pseudo-random vectors (no ties). */
    function vectorsFor(n: number, dims: number, seed = 1): number[][] {
      let x = seed;
      const rnd = () => {
        x = (x * 16807) % 2147483647; // Park–Miller
        return x / 2147483647 - 0.5;
      };
      return Array.from({ length: n }, () => Array.from({ length: dims }, rnd));
    }

    async function spaceWithEmbeddings(metric: string, dims: number, n: number) {
      const work = await create('/works', { title: `Index ${metric} ${dims}`, genre: 'other' });
      const { chunkIds } = await textWithChunks(
        work.id,
        Array.from({ length: n }, (_, i) => `chunk ${i}`),
      );
      const space = await createSpace({ metric, dimensions: dims });
      const vecs = vectorsFor(n, dims, dims + n);
      await embed(space.id, chunkIds.map((id, i) => ({ chunk_id: id, vector: vecs[i]! })));
      return { space, chunkIds, query: vectorsFor(1, dims, 7)[0]! };
    }

    /** Runs the search SQL with sequential scans and sorts discouraged, returning results and the plan. */
    async function forcedIndexSearch(input: SearchInput) {
      return withTransaction(ctx.pool, SYSTEM_PRINCIPAL, `test:${randomUUID()}`, async (client) => {
        await client.query('SET LOCAL enable_seqscan = off');
        await client.query('SET LOCAL enable_bitmapscan = off');
        await client.query('SET LOCAL enable_sort = off');
        await client.query(`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)`);
        const sql = buildSearchSql(input);
        const plan = await client.query(`EXPLAIN (FORMAT TEXT) ${sql.text}`, sql.values);
        const results = await runSearch(client, input);
        return { plan: plan.rows.map((r) => r['QUERY PLAN']).join('\n'), results };
      });
    }

    it.each([
      ['cosine', 3, 'vector_cosine_ops'],
      ['inner_product', 3, 'vector_ip_ops'],
      ['l2', 3, 'vector_l2_ops'],
      ['cosine', 2001, 'halfvec_cosine_ops'],
    ] as const)('%s / %i dimensions: %s index; search results identical with and without it', async (metric, dims, opclassName) => {
      const { space, query } = await spaceWithEmbeddings(metric, dims, 30);
      const body = { embedding_space_id: space.id, vector: query, limit: 10 };
      const before = await search(reader, body);
      expect(before.statusCode, before.body).toBe(200);
      expect(before.json().items).toHaveLength(10);

      expect(await createVectorIndex(ctx.pool, space.id)).toEqual({ name: indexName(space.id), created: true });
      expect(await createVectorIndex(ctx.pool, space.id)).toEqual({ name: indexName(space.id), created: false });
      expect((await get(reader, `/embedding-spaces/${space.id}`)).json().hnsw_index).toBe('valid');
      const def = await ctx.pool.query('SELECT indexdef FROM pg_indexes WHERE indexname = $1', [indexName(space.id)]);
      expect(def.rows[0].indexdef).toContain(opclassName);
      expect(def.rows[0].indexdef).toContain(`WHERE (embedding_space_id = '${space.id}'::uuid)`);

      const input: SearchInput = {
        space: { id: space.id, dimensions: dims, metric },
        vector: query,
        limit: 10,
        includeRestricted: false,
      };
      const forced = await forcedIndexSearch(input);
      expect(forced.plan).toContain(indexName(space.id));
      const ids = (items: Array<{ embedding_id: string }>) => items.map((h) => h.embedding_id);
      expect(ids(forced.results)).toEqual(ids(before.json().items));
      forced.results.forEach((h, i) => expect(h.distance).toBeCloseTo(before.json().items[i].distance, 5));

      const after = await search(reader, body);
      expect(ids(after.json().items)).toEqual(ids(before.json().items));

      // Filters still work through the index (iterative scan).
      const filtered = await forcedIndexSearch({ ...input, filters: { genre: 'sermon' } });
      expect(filtered.results).toEqual([]);

      expect(await dropVectorIndex(ctx.pool, space.id)).toEqual({ name: indexName(space.id), dropped: true });
      expect(await indexStatus(ctx.pool, space.id)).toBe('absent');
      expect(await dropVectorIndex(ctx.pool, space.id)).toEqual({ name: indexName(space.id), dropped: false });
    });

    it('refuses spaces above 4000 dimensions and unknown spaces', async () => {
      const big = await createSpace({ dimensions: 4001 });
      await expect(createVectorIndex(ctx.pool, big.id)).rejects.toThrow(/at most 4000/);
      await expect(createVectorIndex(ctx.pool, randomUUID())).rejects.toThrow(/not found/);
      await expect(createVectorIndex(ctx.pool, 'nope')).rejects.toThrow(/invalid/);
    });
  });
});
