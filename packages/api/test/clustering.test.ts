import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_ORDER, api, asSystem, createUser, expectPgError, setupTestApp, type TestContext, type TestUser } from './helpers.js';

const producer = { tool: 'pipeline', version: '2.1.0', commit: 'abc1234' };

describe('clustering, labels, reviews and provenance', () => {
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

  const post = (user: TestUser | null, url: string, payload: unknown) =>
    api(ctx.app, user, { method: 'POST', url, payload: payload as object });
  const get = (user: TestUser | null, url: string) => api(ctx.app, user, { method: 'GET', url });

  async function ok(res: { statusCode: number; body: string; json(): any }, status = 200) {
    expect(res.statusCode, res.body).toBe(status);
    return res.json();
  }
  const create = async (url: string, body: object, as = contributor) => ok(await post(as, url, body), 201);

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

  /** A text of `parts` joined by '\n', one chunk per part. Returns chunk ids in order. */
  async function textWithChunks(workId: string, parts: string[], textExtra: object = {}) {
    const text = await create('/texts', {
      work_id: workId,
      language: 'la',
      relation: 'original',
      body: parts.join('\n'),
      ...textExtra,
    });
    const seg = await create('/segmentations', { text_id: text.id, method: 'paragraph', producer });
    let offset = 0;
    const chunks = parts.map((part, i) => {
      const len = Array.from(part).length;
      const c = { sequence: i, start_offset: offset, end_offset: offset + len, text: part };
      offset += len + 1;
      return c;
    });
    await ok(await post(contributor, `/segmentations/${seg.id}/chunks`, chunks));
    const list = await ok(await get(contributor, `/segmentations/${seg.id}/chunks?limit=500`));
    return { text, seg, chunkIds: list.items.map((c: { id: string }) => c.id) as string[] };
  }

  /** Embeds chunks and returns the embedding ids in the same order. */
  async function embed(spaceId: string, chunkIds: string[], vectors: number[][]) {
    await ok(
      await post(
        contributor,
        `/embedding-spaces/${spaceId}/embeddings`,
        chunkIds.map((chunk_id, i) => ({ chunk_id, vector: vectors[i] })),
      ),
    );
    const ids: string[] = [];
    for (const chunkId of chunkIds) {
      const chunk = await ok(await get(contributor, `/chunks/${chunkId}?include_embeddings=true`));
      ids.push(chunk.embeddings.find((e: { embedding_space_id: string }) => e.embedding_space_id === spaceId).id);
    }
    return ids;
  }

  const createRun = (spaceId: string, extra: object = {}) =>
    create('/clustering-runs', {
      embedding_space_id: spaceId,
      algorithm: 'hdbscan',
      parameters: { min_cluster_size: 2 },
      producer,
      ...extra,
    });

  /** A space with `n` embedded public chunks and an open run over it. */
  async function fixture(n = 4, textExtra: object = {}) {
    const work = await create('/works', { title: `Sermo ${randomUUID()}`, genre: 'sermon' });
    const parts = Array.from({ length: n }, (_, i) => `Pars ${i} de gratia Dei.`);
    const t = await textWithChunks(work.id, parts, textExtra);
    const space = await createSpace();
    const vectors = parts.map((_, i) => [1, i + 1, 0]);
    const embeddingIds = await embed(space.id, t.chunkIds, vectors);
    const run = await createRun(space.id);
    return { work, ...t, space, embeddingIds, run };
  }

  async function completedCluster() {
    const f = await fixture(2);
    await ok(await post(contributor, `/clustering-runs/${f.run.id}/clusters`, [{ cluster_number: 0 }]));
    await ok(
      await post(
        contributor,
        `/clustering-runs/${f.run.id}/memberships`,
        f.embeddingIds.map((embedding_id) => ({ embedding_id, cluster_number: 0 })),
      ),
    );
    await ok(await post(contributor, `/clustering-runs/${f.run.id}/complete`, {}));
    const clusters = await ok(await get(reader, `/clustering-runs/${f.run.id}/clusters`));
    return { ...f, cluster: clusters.items[0] };
  }

  it('runs the end-to-end flow: work, text, chunks, embeddings, search, run, label, review, provenance', async () => {
    // Scholarly records
    const melanchthon = await create('/persons', { display_name: 'Philipp Melanchthon', year_from: 1497, year_to: 1560 });
    const translator = await create('/persons', { display_name: 'Translator X' });
    const work = await create('/works', {
      title: 'Confessio Augustana',
      genre: 'confession',
      original_languages: ['de', 'la'],
      year_from: 1530,
      year_to: 1530,
      persons: [{ person_id: melanchthon.id, role: 'author' }],
    });
    const source = await create('/sources', {
      kind: 'print_edition',
      citation: 'BSELK, Göttingen 2014',
      title: 'Die Bekenntnisschriften der Evangelisch-Lutherischen Kirche',
      year: 2014,
    });
    const parts = [
      'Item docent, quod homines non possint iustificari coram Deo propriis viribus.',
      'Sed gratis iustificentur propter Christum per fidem.',
      'Item docent, quod una sancta ecclesia perpetuo mansura sit.',
    ];
    const { text, seg, chunkIds } = await textWithChunks(work.id, parts, {
      source_id: source.id,
      persons: [{ person_id: translator.id, role: 'editor' }],
      year_from: 1530,
    });

    // Space, embeddings, search
    const space = await createSpace();
    const embeddingIds = await embed(space.id, chunkIds, [
      [1, 0.1, 0],
      [0.9, 0.2, 0],
      [0, 0.1, 1],
    ]);
    const hits = await ok(await post(reader, '/search', { embedding_space_id: space.id, vector: [1, 0.1, 0], limit: 2 }));
    expect(hits.items.map((h: { chunk: { id: string } }) => h.chunk.id)).toEqual([chunkIds[0], chunkIds[1]]);

    // Run
    expect((await post(reader, '/clustering-runs', { embedding_space_id: space.id, algorithm: 'k', producer })).statusCode).toBe(403);
    expect((await post(contributor, '/clustering-runs', { embedding_space_id: space.id, algorithm: 'k' })).statusCode).toBe(400);
    const missing = await post(contributor, '/clustering-runs', { embedding_space_id: randomUUID(), algorithm: 'k', producer });
    expect(missing.statusCode).toBe(422);
    const run = await createRun(space.id, { status: 'complete', created_by: curator.id, input_filter: { language: 'la' } });
    expect(run).toMatchObject({
      embedding_space_id: space.id,
      algorithm: 'hdbscan',
      metric: 'cosine', // defaults to the space metric
      status: 'open',
      completed_at: null,
      created_by: contributor.id,
      input_filter: { language: 'la' },
      cluster_count: 0,
      input_size: 0,
      noise_count: 0,
    });

    // Readers only see complete runs.
    expect((await get(reader, `/clustering-runs/${run.id}`)).statusCode).toBe(403);
    expect((await get(reader, `/clustering-runs?status=open`)).statusCode).toBe(403);
    const openList = await ok(await get(contributor, `/clustering-runs?status=open&embedding_space_id=${space.id}`));
    expect(openList.items.map((r: { id: string }) => r.id)).toEqual([run.id]);
    const defaultList = await ok(await get(reader, `/clustering-runs?embedding_space_id=${space.id}`));
    expect(defaultList.items).toEqual([]);

    // Clusters: a child before its parent in the same batch (1 -> parent 2).
    const clusters = [
      { cluster_number: 1, centroid: [0.95, 0.15, 0], parent_cluster_number: 2, metadata: { top_terms: ['iustificari', 'fidem'] } },
      { cluster_number: 2, size: 2 },
    ];
    expect(await ok(await post(contributor, `/clustering-runs/${run.id}/clusters`, clusters))).toEqual({ inserted: 2, skipped: 0 });
    expect(await ok(await post(contributor, `/clustering-runs/${run.id}/clusters`, clusters))).toEqual({ inserted: 0, skipped: 2 });
    const changed = await post(contributor, `/clustering-runs/${run.id}/clusters`, [{ ...clusters[0], centroid: [1, 0, 0] }]);
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.details.conflicts[0]).toMatchObject({ index: 0, cluster_number: 1 });

    // Memberships (one noise)
    const members = [
      { embedding_id: embeddingIds[0], cluster_number: 1, distance: 0.05, score: 0.9 },
      { embedding_id: embeddingIds[1], cluster_number: 1, distance: 0.07 },
      { embedding_id: embeddingIds[2], cluster_number: null },
    ];
    expect(await ok(await post(contributor, `/clustering-runs/${run.id}/memberships`, members))).toEqual({ inserted: 3, skipped: 0 });
    expect(await ok(await post(contributor, `/clustering-runs/${run.id}/memberships`, members))).toEqual({ inserted: 0, skipped: 3 });
    const moved = await post(contributor, `/clustering-runs/${run.id}/memberships`, [{ ...members[2], cluster_number: 1 }]);
    expect(moved.statusCode).toBe(409);

    // Complete: fills sizes (cluster 2 includes its child's members).
    expect((await post(reader, `/clustering-runs/${run.id}/complete`, {})).statusCode).toBe(403);
    const done = await ok(await post(contributor, `/clustering-runs/${run.id}/complete`, {}));
    expect(done).toMatchObject({ status: 'complete', cluster_count: 2, input_size: 3, noise_count: 1 });
    expect(done.completed_at).not.toBeNull();
    expect((await post(contributor, `/clustering-runs/${run.id}/complete`, {})).statusCode).toBe(409);

    // Frozen: nothing can be added any more.
    const late = await post(contributor, `/clustering-runs/${run.id}/clusters`, [{ cluster_number: 3 }]);
    expect(late.statusCode).toBe(409);
    expect((await post(contributor, `/clustering-runs/${run.id}/memberships`, members)).statusCode).toBe(409);

    const runClusters = await ok(await get(reader, `/clustering-runs/${run.id}/clusters`));
    expect(runClusters.items.map((c: any) => [c.cluster_number, c.size, c.member_count, c.parent_cluster_number])).toEqual([
      [1, 2, 2, 2],
      [2, 2, 0, null],
    ]);
    const c1 = runClusters.items[0];
    expect((await ok(await get(reader, `/clustering-runs?embedding_space_id=${space.id}`))).items).toHaveLength(1);

    const cluster = await ok(await get(reader, `/clusters/${c1.id}`));
    expect(cluster).toMatchObject({ run_status: 'complete', embedding_space_id: space.id, label_count: 0 });
    expect(cluster.centroid).toBeUndefined();
    expect((await get(reader, `/clusters/${c1.id}?include_centroid=true`)).statusCode).toBe(403);
    expect((await ok(await get(contributor, `/clusters/${c1.id}?include_centroid=true`))).centroid).toEqual([0.95, 0.15, 0]);

    const page1 = await ok(await get(reader, `/clusters/${c1.id}/members?limit=1`));
    const page2 = await ok(await get(reader, `/clusters/${c1.id}/members?limit=1&cursor=${page1.next_cursor}`));
    const memberIds = [...page1.items, ...page2.items].map((m: { embedding_id: string }) => m.embedding_id);
    expect(memberIds.sort()).toEqual([embeddingIds[0], embeddingIds[1]].sort());
    expect(page2.next_cursor).toBeNull();
    const m0 = [...page1.items, ...page2.items].find((m: any) => m.embedding_id === embeddingIds[0]);
    expect(m0).toMatchObject({
      distance: 0.05,
      score: 0.9,
      chunk: { id: chunkIds[0], sequence: 0, text: parts[0], restricted: false, withdrawn: false, language: 'la' },
      text: { id: text.id },
      work: { id: work.id, title: 'Confessio Augustana' },
    });

    // Labels and reviews
    const modelLabel = await create(`/clusters/${c1.id}/labels`, {
      language: 'fi',
      label: 'Vanhurskauttaminen uskon kautta',
      description: 'Ihminen vanhurskautetaan lahjaksi Kristuksen tähden uskon kautta.',
      producer_kind: 'model',
      model: 'label-model',
      model_version: '2026-05',
      producer: { tool: 'labeller', version: '0.3', parameters: { temperature: 0 } },
    });
    expect(modelLabel).toMatchObject({ status: 'proposed', superseded: false, superseded_by: [], review_count: 0, created_by: contributor.id });

    const review = await ok(
      await post(curator, `/labels/${modelLabel.id}/reviews`, { decision: 'needs_revision', note: 'Liian yleinen', reviewer_id: reader.id }),
      201,
    );
    expect(review).toMatchObject({ label_id: modelLabel.id, reviewer_id: curator.id, decision: 'needs_revision' });

    const humanLabel = await create(
      `/clusters/${c1.id}/labels`,
      {
        language: 'la',
        label: 'Iustificatio sola fide',
        producer_kind: 'human',
        supersedes_label_id: modelLabel.id,
      },
      curator,
    );
    await ok(await post(curator, `/labels/${humanLabel.id}/reviews`, { decision: 'accepted' }), 201);

    const labels = await ok(await get(reader, `/clusters/${c1.id}/labels`));
    const byId = Object.fromEntries(labels.items.map((l: { id: string }) => [l.id, l]));
    expect(byId[modelLabel.id]).toMatchObject({ status: 'needs_revision', superseded: true, superseded_by: [humanLabel.id], review_count: 1 });
    expect(byId[humanLabel.id]).toMatchObject({ status: 'accepted', superseded: false, producer: null, model: null });
    expect((await ok(await get(reader, `/clusters/${c1.id}/labels?language=fi`))).items).toHaveLength(1);

    // Provenance: chunk
    const cp = await ok(await get(reader, `/chunks/${chunkIds[0]}/provenance`));
    expect(cp.chunk).toMatchObject({ id: chunkIds[0], text: parts[0], effective_access_level: 'public' });
    expect(cp.segmentation).toMatchObject({ id: seg.id, producer, method: 'paragraph' });
    expect(cp.text).toMatchObject({ id: text.id, content_sha256: text.content_sha256, persons: [{ person_id: translator.id, role: 'editor' }] });
    expect(cp.source).toMatchObject({ id: source.id, citation: 'BSELK, Göttingen 2014' });
    expect(cp.work).toMatchObject({ id: work.id, persons: [{ person_id: melanchthon.id, role: 'author' }] });
    expect(cp.persons.map((p: { id: string }) => p.id).sort()).toEqual([melanchthon.id, translator.id].sort());
    expect(cp.embeddings).toEqual([
      expect.objectContaining({ id: embeddingIds[0], embedding_space: expect.objectContaining({ id: space.id, model: 'test-model', dimensions: 3 }) }),
    ]);
    expect(cp.cluster_memberships).toEqual([
      expect.objectContaining({ clustering_run_id: run.id, cluster_id: c1.id, cluster_number: 1, distance: 0.05, run_status: 'complete' }),
    ]);

    // Provenance: cluster
    const kp = await ok(await get(reader, `/clusters/${c1.id}/provenance`));
    expect(kp.cluster).toMatchObject({ id: c1.id, cluster_number: 1, size: 2, parent_cluster_number: 2 });
    expect(kp.run).toMatchObject({ id: run.id, algorithm: 'hdbscan', parameters: { min_cluster_size: 2 }, producer, status: 'complete' });
    expect(kp.embedding_space).toMatchObject({ id: space.id, model: 'test-model', revision: 'r1', metric: 'cosine' });
    expect(kp.input).toEqual({ size: 3, noise_count: 1, cluster_count: 2 });
    expect(kp.labels.map((l: { id: string }) => l.id)).toEqual([modelLabel.id, humanLabel.id]);
    expect(kp.labels[0]).toMatchObject({ status: 'needs_revision', superseded: true, producer: { tool: 'labeller' } });
    expect(kp.labels[0].reviews).toEqual([
      { id: review.id, label_id: modelLabel.id, reviewer_id: curator.id, decision: 'needs_revision', note: 'Liian yleinen', created_at: review.created_at },
    ]);
    expect(JSON.stringify(kp)).not.toMatch(/email|display_name/);

    // Audit: batch events for clusters and memberships, status change for the run.
    const audit = await ctx.pool.query(
      `SELECT action, entity_type, batch_count, changes FROM audit_event WHERE entity_id = $1 ORDER BY ${AUDIT_ORDER}`,
      [run.id],
    );
    expect(audit.rows.map((r) => [r.action, r.entity_type, r.batch_count])).toEqual([
      ['insert', 'clustering_run', null],
      ['batch_insert', 'cluster', 2],
      ['batch_insert', 'cluster_membership', 3],
      ['status_change', 'clustering_run', null],
    ]);

    // Withdraw (curator+): complete -> withdrawn, then hidden from readers.
    expect((await post(contributor, `/clustering-runs/${run.id}/withdraw`, { reason: 'x' })).statusCode).toBe(403);
    expect((await post(curator, `/clustering-runs/${run.id}/withdraw`, {})).statusCode).toBe(400);
    const withdrawn = await ok(await post(curator, `/clustering-runs/${run.id}/withdraw`, { reason: 'wrong input filter' }));
    expect(withdrawn).toMatchObject({ status: 'withdrawn', withdrawn_reason: 'wrong input filter' });
    expect(withdrawn.completed_at).not.toBeNull();
    expect((await post(curator, `/clustering-runs/${run.id}/withdraw`, { reason: 'again' })).statusCode).toBe(409);
    expect((await post(curator, `/clustering-runs/${run.id}/complete`, {})).statusCode).toBe(409);
    expect((await get(reader, `/clusters/${c1.id}`)).statusCode).toBe(403);
    expect((await get(reader, `/clusters/${c1.id}/provenance`)).statusCode).toBe(403);
    expect((await get(contributor, `/clusters/${c1.id}/provenance`)).statusCode).toBe(200);
    expect((await ok(await get(contributor, `/clustering-runs?status=withdrawn&embedding_space_id=${space.id}`))).items).toHaveLength(1);
    expect((await post(curator, `/labels/${humanLabel.id}/reviews`, { decision: 'rejected' })).statusCode).toBe(409);
    // Chunk provenance no longer lists memberships of the withdrawn run for readers.
    expect((await ok(await get(reader, `/chunks/${chunkIds[0]}/provenance`))).cluster_memberships).toEqual([]);
  });

  describe('cluster and membership batches', () => {
    it('validates clusters: parents, cycles, centroid dimension, duplicates', async () => {
      const f = await fixture(1);
      const url = `/clustering-runs/${f.run.id}/clusters`;
      const res = await post(contributor, url, [
        { cluster_number: 0, parent_cluster_number: 99 },
        { cluster_number: 1, parent_cluster_number: 2 },
        { cluster_number: 2, parent_cluster_number: 1 },
        { cluster_number: 3, parent_cluster_number: 3 },
        { cluster_number: 4, centroid: [1, 2] },
      ]);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details.errors.map((e: any) => [e.index, e.reason])).toEqual([
        [0, 'parent_not_found'],
        [1, 'parent_cycle'],
        [2, 'parent_cycle'],
        [3, 'self_parent'],
        [4, 'invalid_centroid'],
      ]);
      const dup = await post(contributor, url, [{ cluster_number: 5 }, { cluster_number: 5 }]);
      expect(dup.statusCode).toBe(422);
      expect(dup.json().error.details.errors[0]).toMatchObject({ index: 1, reason: 'duplicate_cluster_number' });
      expect((await post(contributor, `/clustering-runs/${randomUUID()}/clusters`, [{ cluster_number: 0 }])).statusCode).toBe(404);
      expect((await post(reader, url, [{ cluster_number: 0 }])).statusCode).toBe(403);

      // A parent stored by an earlier batch; nothing from the failed batches was inserted.
      expect(await ok(await post(contributor, url, [{ cluster_number: 10 }]))).toEqual({ inserted: 1, skipped: 0 });
      expect(await ok(await post(contributor, url, [{ cluster_number: 11, parent_cluster_number: 10 }]))).toEqual({ inserted: 1, skipped: 0 });
      const list = await ok(await get(contributor, `/clustering-runs/${f.run.id}/clusters`));
      expect(list.items.map((c: any) => [c.cluster_number, c.parent_cluster_number])).toEqual([
        [10, null],
        [11, 10],
      ]);
    });

    it('rejects memberships from another space, unknown embeddings/clusters and withdrawn chunks', async () => {
      const f = await fixture(3);
      const other = await fixture(1);
      await ok(await post(contributor, `/clustering-runs/${f.run.id}/clusters`, [{ cluster_number: 0 }]));
      await ok(await post(curator, `/works/${f.work.id}/withdraw`, { reason: 'test' }));
      const res = await post(contributor, `/clustering-runs/${f.run.id}/memberships`, [
        { embedding_id: other.embeddingIds[0], cluster_number: 0 },
        { embedding_id: randomUUID(), cluster_number: 0 },
        { embedding_id: f.embeddingIds[1], cluster_number: 0 },
      ]);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details.errors.map((e: any) => [e.index, e.reason])).toEqual([
        [0, 'wrong_embedding_space'],
        [1, 'embedding_not_found'],
        [2, 'chunk_withdrawn'],
      ]);

      const g = await fixture(1);
      const bad = await post(contributor, `/clustering-runs/${g.run.id}/memberships`, [{ embedding_id: g.embeddingIds[0], cluster_number: 7 }]);
      expect(bad.json().error.details.errors[0]).toMatchObject({ reason: 'cluster_not_found' });
      const dup = await post(contributor, `/clustering-runs/${g.run.id}/memberships`, [
        { embedding_id: g.embeddingIds[0], cluster_number: null },
        { embedding_id: g.embeddingIds[0], cluster_number: null },
      ]);
      expect(dup.statusCode).toBe(422);
      // The database enforces the space rule as well.
      await expectPgError(
        asSystem(ctx.pool, (c) =>
          c.query('INSERT INTO cluster_membership (clustering_run_id, embedding_id) VALUES ($1, $2)', [g.run.id, other.embeddingIds[0]]),
        ),
        'SZ004',
      );
    });

    it('complete requires memberships and matching sizes; open runs can be withdrawn', async () => {
      const f = await fixture(2);
      const base = `/clustering-runs/${f.run.id}`;
      expect((await post(contributor, `${base}/complete`, {})).statusCode).toBe(409); // no memberships
      await ok(await post(contributor, `${base}/clusters`, [{ cluster_number: 0, size: 5 }, { cluster_number: 1 }]));
      await ok(
        await post(contributor, `${base}/memberships`, [
          { embedding_id: f.embeddingIds[0], cluster_number: 0 },
          { embedding_id: f.embeddingIds[1], cluster_number: 1 },
        ]),
      );
      const mismatch = await post(contributor, `${base}/complete`, {});
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json().error.details.mismatches).toEqual([{ cluster_number: 0, size: 5, member_count: 1 }]);
      expect((await ok(await get(contributor, base))).status).toBe('open');

      // The database refuses too (and cluster sizes cannot be changed once set).
      await expectPgError(asSystem(ctx.pool, (c) => c.query(`UPDATE clustering_run SET status = 'complete' WHERE id = $1`, [f.run.id])), 'SZ003');
      await expectPgError(asSystem(ctx.pool, (c) => c.query(`UPDATE cluster SET size = 1 WHERE clustering_run_id = $1 AND cluster_number = 0`, [f.run.id])), 'SZ002');
      await expectPgError(asSystem(ctx.pool, (c) => c.query(`UPDATE cluster SET metadata = '{"a":1}' WHERE clustering_run_id = $1`, [f.run.id])), 'SZ002');

      const withdrawn = await ok(await post(curator, `${base}/withdraw`, { reason: 'bad sizes' }));
      expect(withdrawn).toMatchObject({ status: 'withdrawn', completed_at: null });
      expect((await post(contributor, `${base}/memberships`, [{ embedding_id: f.embeddingIds[0], cluster_number: 0 }])).statusCode).toBe(409);
      expect((await post(curator, `/clustering-runs/${randomUUID()}/withdraw`, { reason: 'x' })).statusCode).toBe(404);
    });
  });

  describe('labels', () => {
    it('validates producer rules, superseding and run state', async () => {
      const a = await completedCluster();
      const b = await completedCluster();
      const url = `/clusters/${a.cluster.id}/labels`;
      expect((await post(reader, url, { language: 'en', label: 'x', producer_kind: 'human' })).statusCode).toBe(403);
      expect((await post(contributor, url, { language: 'en', label: 'x', producer_kind: 'model', model: 'm' })).statusCode).toBe(422);
      expect((await post(contributor, url, { language: 'en', label: 'x', producer_kind: 'model', producer })).statusCode).toBe(422);
      expect((await post(contributor, url, { language: 'en', label: 'x', producer_kind: 'human', model: 'm' })).statusCode).toBe(422);
      expect((await post(contributor, url, { language: 'en', label: 'x', producer_kind: 'robot' })).statusCode).toBe(400);
      expect((await post(contributor, `/clusters/${randomUUID()}/labels`, { language: 'en', label: 'x', producer_kind: 'human' })).statusCode).toBe(404);

      const other = await create(`/clusters/${b.cluster.id}/labels`, { language: 'en', label: 'grace', producer_kind: 'human' });
      const cross = await post(contributor, url, { language: 'en', label: 'y', producer_kind: 'human', supersedes_label_id: other.id });
      expect(cross.statusCode).toBe(422);

      // Labels need a complete run.
      const open = await fixture(1);
      await ok(await post(contributor, `/clustering-runs/${open.run.id}/clusters`, [{ cluster_number: 0 }]));
      const openClusters = await ok(await get(contributor, `/clustering-runs/${open.run.id}/clusters`));
      const openCluster = openClusters.items[0];
      expect((await post(contributor, `/clusters/${openCluster.id}/labels`, { language: 'en', label: 'x', producer_kind: 'human' })).statusCode).toBe(409);
      // ...and readers cannot see clusters of open runs.
      expect((await get(reader, `/clusters/${openCluster.id}`)).statusCode).toBe(403);
      expect((await get(reader, `/clusters/${openCluster.id}/members`)).statusCode).toBe(403);
      expect((await get(reader, `/clusters/${openCluster.id}/labels`)).statusCode).toBe(403);
      expect((await get(reader, `/clustering-runs/${open.run.id}/clusters`)).statusCode).toBe(403);
      expect((await get(contributor, `/clusters/${openCluster.id}/members`)).statusCode).toBe(200);
    });

    it('derives status from the latest review and flags superseded labels', async () => {
      const { cluster } = await completedCluster();
      const l1 = await create(`/clusters/${cluster.id}/labels`, { language: 'en', label: 'Justification', producer_kind: 'human' });
      const status = async (id: string) => (await ok(await get(reader, `/labels/${id}`))).status;
      expect(await status(l1.id)).toBe('proposed');
      expect((await post(contributor, `/labels/${l1.id}/reviews`, { decision: 'accepted' })).statusCode).toBe(403);
      expect((await post(curator, `/labels/${l1.id}/reviews`, { decision: 'maybe' })).statusCode).toBe(400);
      expect((await post(curator, `/labels/${randomUUID()}/reviews`, { decision: 'accepted' })).statusCode).toBe(404);
      for (const decision of ['accepted', 'rejected', 'needs_revision', 'accepted']) {
        await ok(await post(curator, `/labels/${l1.id}/reviews`, { decision }), 201);
        expect(await status(l1.id)).toBe(decision);
      }
      const detail = await ok(await get(reader, `/labels/${l1.id}`));
      expect(detail.reviews.map((r: { decision: string }) => r.decision)).toEqual(['accepted', 'rejected', 'needs_revision', 'accepted']);
      expect(detail).toMatchObject({ superseded: false, review_count: 4 });

      const l2 = await create(`/clusters/${cluster.id}/labels`, {
        language: 'en',
        label: 'Justification by faith',
        producer_kind: 'human',
        supersedes_label_id: l1.id,
      });
      const after = await ok(await get(reader, `/labels/${l1.id}`));
      expect(after).toMatchObject({ status: 'accepted', superseded: true, superseded_by: [l2.id] });
      expect(await status(l2.id)).toBe('proposed');

      const audit = await ctx.pool.query(
        `SELECT action, entity_type FROM audit_event WHERE entity_type IN ('label', 'label_review') AND (entity_id = $1 OR changes->>'label_id' = $1::text)`,
        [l1.id],
      );
      expect(audit.rows.filter((r) => r.entity_type === 'label_review')).toHaveLength(4);
      expect(audit.rows.filter((r) => r.entity_type === 'label')).toHaveLength(1);
    });
  });

  describe('restricted texts', () => {
    it('hides restricted chunk text from readers in members and provenance', async () => {
      const f = await fixture(2, { access_level: 'restricted' });
      await ok(await post(contributor, `/clustering-runs/${f.run.id}/clusters`, [{ cluster_number: 0 }]));
      await ok(
        await post(
          contributor,
          `/clustering-runs/${f.run.id}/memberships`,
          f.embeddingIds.map((embedding_id) => ({ embedding_id, cluster_number: 0 })),
        ),
      );
      await ok(await post(contributor, `/clustering-runs/${f.run.id}/complete`, {}));
      const { items } = await ok(await get(reader, `/clustering-runs/${f.run.id}/clusters`));
      const asReader = await ok(await get(reader, `/clusters/${items[0].id}/members`));
      expect(asReader.items).toHaveLength(2);
      for (const m of asReader.items) expect(m.chunk).toMatchObject({ text: null, restricted: true });
      const asContributor = await ok(await get(contributor, `/clusters/${items[0].id}/members`));
      for (const m of asContributor.items) expect(m.chunk.text).toMatch(/^Pars \d/);

      const readerProv = await ok(await get(reader, `/chunks/${f.chunkIds[0]}/provenance`));
      expect(readerProv.chunk).toMatchObject({ text: null, effective_access_level: 'restricted' });
      expect(readerProv.text.id).toBe(f.text.id);
      const contribProv = await ok(await get(contributor, `/chunks/${f.chunkIds[0]}/provenance`));
      expect(contribProv.chunk.text).toBe('Pars 0 de gratia Dei.');
      expect((await get(reader, `/chunks/${randomUUID()}/provenance`)).statusCode).toBe(404);
      expect((await get(reader, `/clusters/${randomUUID()}/provenance`)).statusCode).toBe(404);
    });
  });

  describe('OpenAPI', () => {
    it('serves the document and the UI without authentication', async () => {
      const res = await get(null, '/docs/json');
      expect(res.statusCode).toBe(200);
      const doc = res.json();
      expect(doc.openapi).toMatch(/^3\./);
      expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
      expect(doc.security).toEqual([{ bearerAuth: [] }]);
      for (const path of [
        '/clustering-runs',
        '/clustering-runs/{id}/clusters',
        '/clustering-runs/{id}/memberships',
        '/clustering-runs/{id}/complete',
        '/clustering-runs/{id}/withdraw',
        '/clusters/{id}/members',
        '/clusters/{id}/labels',
        '/labels/{id}/reviews',
        '/chunks/{id}/provenance',
        '/clusters/{id}/provenance',
        '/search',
        '/texts/{id}/body',
        '/admin/users',
      ]) {
        expect(Object.keys(doc.paths), path).toContain(path);
      }
      expect(doc.paths['/health'].get.security).toEqual([]);
      expect(doc.paths['/clustering-runs'].post.requestBody).toBeDefined();
      expect(Object.keys(doc.paths).some((p) => p.startsWith('/docs'))).toBe(false);

      const ui = await get(null, '/docs');
      expect(ui.statusCode).toBe(200);
      expect(ui.headers['content-type']).toMatch(/text\/html/);
      expect((await get(null, '/docs/static/swagger-ui.css')).statusCode).toBe(200);
      // Other routes still require a token.
      expect((await get(null, '/clustering-runs')).statusCode).toBe(401);
    });
  });
});
