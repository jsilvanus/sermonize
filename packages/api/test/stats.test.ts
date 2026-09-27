/**
 * GET /stats: public aggregate counts. The test database is shared across files, so
 * this compares counts before and after creating (and withdrawing) known records.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createUser, setupTestApp, type TestContext, type TestUser } from './helpers.js';

const producer = { tool: 'stats-test', version: '1.0.0' };

describe('GET /stats', () => {
  let ctx: TestContext;
  let contributor: TestUser;
  let curator: TestUser;

  beforeAll(async () => {
    ctx = await setupTestApp();
    contributor = await createUser(ctx.pool, { role: 'contributor' });
    curator = await createUser(ctx.pool, { role: 'curator' });
  });
  afterAll(() => ctx.close());

  async function ok(res: { statusCode: number; body: string; json(): any }, status = 200) {
    expect(res.statusCode, res.body).toBe(status);
    return res.json();
  }
  const post = (as: TestUser, url: string, payload: unknown) => api(ctx.app, as, { method: 'POST', url, payload: payload as object });
  const create = async (url: string, body: object, as = contributor) => ok(await post(as, url, body), 201);
  const stats = async () => ok(await api(ctx.app, null, { method: 'GET', url: '/stats' }));

  it('is public and has the documented shape', async () => {
    const s = await stats();
    expect(Object.keys(s).sort()).toEqual(
      [
        'persons', 'works', 'works_by_genre', 'sermons', 'texts', 'texts_by_language', 'sources', 'segmentations',
        'chunks', 'embedding_spaces', 'embeddings', 'complete_clustering_runs', 'clusters', 'labels',
      ].sort(),
    );
    expect(s.sermons).toBe(s.works_by_genre.sermon ?? 0);
  });

  it('counts created records and excludes withdrawn ones', async () => {
    const before = await stats();

    const person = await create('/persons', { display_name: `Stats Person ${randomUUID()}` });
    const withdrawnPerson = await create('/persons', { display_name: `Stats Withdrawn ${randomUUID()}` });
    await ok(await post(curator, `/persons/${withdrawnPerson.id}/withdraw`, { reason: 'test' }));
    const source = await create('/sources', { kind: 'other', citation: `Stats source ${randomUUID()}` });
    const sermon = await create('/works', { title: `Stats sermon ${randomUUID()}`, genre: 'sermon', persons: [{ person_id: person.id, role: 'author', certainty: 'certain' }] });
    await create('/works', { title: `Stats treatise ${randomUUID()}`, genre: 'treatise' });
    const parts = ['Gratia Dei.', 'Pax vobis.'];
    const text = await create('/texts', { work_id: sermon.id, source_id: source.id, language: 'la', relation: 'original', body: parts.join('\n') });
    await create('/texts', { work_id: sermon.id, language: 'fi', relation: 'translation', translated_from_language: 'la', body: 'Jumalan armo.' });
    const seg = await create('/segmentations', { text_id: text.id, method: 'paragraph', producer });
    await ok(
      await post(contributor, `/segmentations/${seg.id}/chunks`, [
        { sequence: 0, start_offset: 0, end_offset: 11, text: 'Gratia Dei.' },
        { sequence: 1, start_offset: 12, end_offset: 22, text: 'Pax vobis.' },
      ]),
    );
    const chunks = await ok(await api(ctx.app, contributor, { method: 'GET', url: `/segmentations/${seg.id}/chunks` }));
    const space = await create('/embedding-spaces', {
      name: `stats-space-${randomUUID()}`, model: 'm', revision: 'r', dimensions: 3, metric: 'cosine', normalized: false, producer,
    });
    await ok(
      await post(contributor, `/embedding-spaces/${space.id}/embeddings`,
        chunks.items.map((c: { id: string }, i: number) => ({ chunk_id: c.id, vector: [1, i + 1, 0] }))),
    );
    const embeddingIds: string[] = [];
    for (const c of chunks.items) {
      const chunk = await ok(await api(ctx.app, contributor, { method: 'GET', url: `/chunks/${c.id}?include_embeddings=true` }));
      embeddingIds.push(chunk.embeddings[0].id);
    }
    const runBody = { embedding_space_id: space.id, algorithm: 'kmeans', producer };
    const run = await create('/clustering-runs', runBody);
    await ok(await post(contributor, `/clustering-runs/${run.id}/clusters`, [{ cluster_number: 0 }, { cluster_number: 1 }]));
    await ok(await post(contributor, `/clustering-runs/${run.id}/memberships`, embeddingIds.map((embedding_id, i) => ({ embedding_id, cluster_number: i }))));
    await ok(await post(contributor, `/clustering-runs/${run.id}/complete`, {}));
    const clusters = await ok(await api(ctx.app, contributor, { method: 'GET', url: `/clustering-runs/${run.id}/clusters` }));
    await create(`/clusters/${clusters.items[0].id}/labels`, { language: 'en', label: 'grace', producer_kind: 'human' });
    // An open run with a cluster: counted neither as a run nor for its clusters.
    const openRun = await create('/clustering-runs', runBody);
    await ok(await post(contributor, `/clustering-runs/${openRun.id}/clusters`, [{ cluster_number: 0 }]));

    const after = await stats();
    const delta = (k: string) => after[k] - before[k];
    expect({
      persons: delta('persons'), works: delta('works'), sermons: delta('sermons'), texts: delta('texts'),
      sources: delta('sources'), segmentations: delta('segmentations'), chunks: delta('chunks'),
      embedding_spaces: delta('embedding_spaces'), embeddings: delta('embeddings'),
      complete_clustering_runs: delta('complete_clustering_runs'), clusters: delta('clusters'), labels: delta('labels'),
    }).toEqual({
      persons: 1, works: 2, sermons: 1, texts: 2, sources: 1, segmentations: 1, chunks: 2,
      embedding_spaces: 1, embeddings: 2, complete_clustering_runs: 1, clusters: 2, labels: 1,
    });
    expect((after.works_by_genre.treatise ?? 0) - (before.works_by_genre.treatise ?? 0)).toBe(1);
    expect((after.texts_by_language.la ?? 0) - (before.texts_by_language.la ?? 0)).toBe(1);
    expect((after.texts_by_language.fi ?? 0) - (before.texts_by_language.fi ?? 0)).toBe(1);

    // A withdrawn work drops out of works and sermons.
    await ok(await post(curator, `/works/${sermon.id}/withdraw`, { reason: 'test' }));
    const withdrawn = await stats();
    expect(withdrawn.works - before.works).toBe(1);
    expect(withdrawn.sermons - before.sermons).toBe(0);
  });
});
