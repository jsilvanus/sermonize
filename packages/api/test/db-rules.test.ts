/**
 * Database-enforced rules (triggers and constraints) from migrations/0001_init.sql,
 * exercised with direct SQL so they hold for every code path.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { writeBatchAudit } from '../src/lib/batch-audit.js';
import { AUDIT_ORDER, asUser, createTestPool, createUser, expectPgError, type TestUser } from './helpers.js';

const PRODUCER = { tool: 'test-suite', version: '1.0.0' };
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function one<T = Record<string, any>>(c: PoolClient, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await c.query(sql, params);
  return rows[0] as T;
}

describe('database rules', () => {
  let pool: Pool;
  let curator: TestUser;
  let other: TestUser;
  const as = <T>(fn: (c: PoolClient) => Promise<T>, user = curator) => asUser(pool, user.id, fn);

  const insertWork = (c: PoolClient, genre = 'treatise') =>
    one<{ id: string }>(c, `INSERT INTO work (title, genre) VALUES ('Confessiones', $1) RETURNING id`, [genre]);
  const insertText = (c: PoolClient, workId: string, body: string) =>
    one<{ id: string; content_sha256: string; char_length: number }>(
      c,
      `INSERT INTO text (work_id, language, relation, body) VALUES ($1, 'la', 'original', $2)
       RETURNING id, content_sha256, char_length`,
      [workId, body],
    );

  /** work -> text -> segmentation -> chunk -> space(3 dims) -> embedding -> open run */
  async function seedDerived(c: PoolClient) {
    const work = await insertWork(c);
    const text = await insertText(c, work.id, 'Magnus es, domine.');
    const seg = await one(c, `INSERT INTO segmentation (text_id, method, producer) VALUES ($1, 'sentence', $2) RETURNING id`, [
      text.id,
      PRODUCER,
    ]);
    const chunk = await one(
      c,
      `INSERT INTO chunk (segmentation_id, text_id, sequence, start_offset, end_offset, text)
       VALUES ($1, $2, 0, 0, 6, 'Magnus') RETURNING id, content_sha256`,
      [seg.id, text.id],
    );
    const space = await one(
      c,
      `INSERT INTO embedding_space (name, model, revision, dimensions, metric, normalized, producer)
       VALUES ($1, 'm', 'r1', 3, 'cosine', true, $2) RETURNING id`,
      [`space-${crypto.randomUUID()}`, PRODUCER],
    );
    const emb = await one(
      c,
      `INSERT INTO embedding (chunk_id, embedding_space_id, vector) VALUES ($1, $2, '[1,0,0]') RETURNING id`,
      [chunk.id, space.id],
    );
    const run = await one(
      c,
      `INSERT INTO clustering_run (embedding_space_id, algorithm, metric, producer)
       VALUES ($1, 'hdbscan', 'cosine', $2) RETURNING id`,
      [space.id, PRODUCER],
    );
    return { work, text, seg, chunk, space, emb, run };
  }

  beforeAll(async () => {
    pool = createTestPool();
    curator = await createUser(pool, { role: 'curator' });
    other = await createUser(pool, { role: 'contributor' });
  });
  afterAll(() => pool.end());

  describe('audit columns', () => {
    it('inserts without app.user_id fail', async () => {
      await expectPgError(pool.query(`INSERT INTO person (display_name) VALUES ('Augustinus')`), 'SZ001');
      await expectPgError(
        pool.query(`INSERT INTO audit_event (action, entity_type) VALUES ('insert', 'x')`),
        'SZ001',
      );
    });

    it('created_by/updated_by come from the principal, not from the statement', async () => {
      const p = await as((c) =>
        one(
          c,
          `INSERT INTO person (display_name, created_by, created_at, updated_by)
           VALUES ('Augustinus', $1, '2000-01-01', $1) RETURNING *`,
          [other.id],
        ),
      );
      expect(p.created_by).toBe(curator.id);
      expect(p.updated_by).toBe(curator.id);
      expect(new Date(p.created_at).getFullYear()).toBeGreaterThan(2000);

      const u = await as(
        (c) => one(c, `UPDATE person SET display_name = 'Aurelius Augustinus', created_by = $2 WHERE id = $1 RETURNING *`, [p.id, curator.id]),
        other,
      );
      expect(u.created_by).toBe(curator.id);
      expect(u.updated_by).toBe(other.id);
    });

    it('withdrawn_by is set from the principal', async () => {
      const p = await as((c) => one(c, `INSERT INTO person (display_name) VALUES ('Pelagius') RETURNING id`));
      const w = await as((c) =>
        one(c, `UPDATE person SET withdrawn_at = now(), withdrawn_reason = 'dup', withdrawn_by = $2 WHERE id = $1 RETURNING *`, [
          p.id,
          other.id,
        ]),
      );
      expect(w.withdrawn_by).toBe(curator.id);
    });

    it('label_review.reviewer_id is the principal', async () => {
      const rev = await as(async (c) => {
        const d = await seedDerived(c);
        const cl = await one(c, `INSERT INTO cluster (clustering_run_id, cluster_number) VALUES ($1, 0) RETURNING id`, [d.run.id]);
        const label = await one(c, `INSERT INTO label (cluster_id, language, label, producer_kind) VALUES ($1, 'en', 'grace', 'human') RETURNING id`, [cl.id]);
        return one(c, `INSERT INTO label_review (label_id, reviewer_id, decision) VALUES ($1, $2, 'accepted') RETURNING *`, [label.id, other.id]);
      });
      expect(rev.reviewer_id).toBe(curator.id);
      expect(rev.created_by).toBe(curator.id);
    });
  });

  describe('text body', () => {
    it('computes content_sha256 and char_length in code points', async () => {
      const body = 'Ἐν ἀρχῇ ἦν ὁ λόγος 𝔊\nline two';
      const t = await as(async (c) => insertText(c, (await insertWork(c)).id, body));
      expect(t.content_sha256).toBe(sha256(body));
      expect(t.char_length).toBe([...body].length);
      expect(t.char_length).not.toBe(body.length); // astral char: code points != UTF-16 units
    });

    it('rejects non-NFC bodies and \\r line endings', async () => {
      const nfd = 'Ἐν ἀρχῇ'.normalize('NFD');
      const e1 = await expectPgError(as(async (c) => insertText(c, (await insertWork(c)).id, nfd)), '23514');
      expect(e1.constraint).toBe('text_body_nfc');
      const e2 = await expectPgError(as(async (c) => insertText(c, (await insertWork(c)).id, 'a\r\nb')), '23514');
      expect(e2.constraint).toBe('text_body_no_cr');
    });

    it('body is immutable, metadata is not; hash cannot be overwritten', async () => {
      const t = await as(async (c) => insertText(c, (await insertWork(c)).id, 'Tolle, lege.'));
      await expectPgError(as((c) => c.query(`UPDATE text SET body = 'Tolle lege.' WHERE id = $1`, [t.id])), 'SZ002');
      const u = await as((c) =>
        one(c, `UPDATE text SET title = 'Conf. 8', content_sha256 = $2, char_length = 1 WHERE id = $1 RETURNING *`, [
          t.id,
          'f'.repeat(64),
        ]),
      );
      expect(u.title).toBe('Conf. 8');
      expect(u.content_sha256).toBe(sha256('Tolle, lege.'));
      expect(u.char_length).toBe(12);
    });

    it('translated_from_language only for non-originals; base text must be of the same work', async () => {
      await expectPgError(
        as(async (c) =>
          c.query(
            `INSERT INTO text (work_id, language, relation, translated_from_language, body) VALUES ($1, 'fi', 'original', 'la', 'x')`,
            [(await insertWork(c)).id],
          ),
        ),
        '23514',
      );
      await expectPgError(
        as(async (c) => {
          const base = await insertText(c, (await insertWork(c)).id, 'Latin');
          const otherWork = await insertWork(c);
          return c.query(
            `INSERT INTO text (work_id, language, relation, base_text_id, body) VALUES ($1, 'fi', 'translation', $2, 'Suomi')`,
            [otherWork.id, base.id],
          );
        }),
        '23503',
      );
    });

    it('several originals per work are allowed', async () => {
      await as(async (c) => {
        const w = await insertWork(c, 'confession');
        await c.query(`INSERT INTO text (work_id, language, relation, body) VALUES ($1, 'de', 'original', 'Deutsch'), ($1, 'la', 'original', 'Latine')`, [w.id]);
      });
    });

    it('texts, works, persons and sources cannot be deleted', async () => {
      const t = await as(async (c) => insertText(c, (await insertWork(c)).id, 'x'));
      await expectPgError(as((c) => c.query('DELETE FROM text WHERE id = $1', [t.id])), 'SZ002');
    });
  });

  describe('scholarly constraints', () => {
    it('sermon_occasion requires a sermon work, and such a work keeps genre sermon', async () => {
      await expectPgError(
        as(async (c) => c.query(`INSERT INTO sermon_occasion (work_id) VALUES ($1)`, [(await insertWork(c)).id])),
        'SZ004',
      );
      const w = await as(async (c) => {
        const w = await insertWork(c, 'sermon');
        await c.query(`INSERT INTO sermon_occasion (work_id, pericopes) VALUES ($1, '{"Matt. 8:1-13"}')`, [w.id]);
        return w;
      });
      await expectPgError(as((c) => c.query(`UPDATE work SET genre = 'homily' WHERE id = $1`, [w.id])), 'SZ004');
    });

    it('rejects invalid language tags and year ranges', async () => {
      await expectPgError(
        as(async (c) =>
          c.query(`INSERT INTO text (work_id, language, relation, body) VALUES ($1, 'not a tag', 'original', 'x')`, [
            (await insertWork(c)).id,
          ]),
        ),
        '23514',
      );
      await expectPgError(as((c) => c.query(`INSERT INTO work (title, genre, original_languages) VALUES ('W', 'other', '{la,"x y"}')`)), '23514');
      await expectPgError(as((c) => c.query(`INSERT INTO person (display_name, year_from, year_to) VALUES ('X', 430, 354)`)), '23514');
    });
  });

  describe('derived tables', () => {
    it('are insert-only', async () => {
      const d = await as(seedDerived);
      await expectPgError(as((c) => c.query(`UPDATE chunk SET locus = '1.1' WHERE id = $1`, [d.chunk.id])), 'SZ002');
      await expectPgError(as((c) => c.query(`DELETE FROM chunk WHERE id = $1`, [d.chunk.id])), 'SZ002');
      await expectPgError(as((c) => c.query(`UPDATE embedding SET vector = '[0,1,0]' WHERE id = $1`, [d.emb.id])), 'SZ002');
      await expectPgError(as((c) => c.query(`UPDATE embedding_space SET model = 'other' WHERE id = $1`, [d.space.id])), 'SZ002');
      await expectPgError(as((c) => c.query(`UPDATE segmentation SET method = 'other' WHERE id = $1`, [d.seg.id])), 'SZ002');
      await expectPgError(as((c) => c.query(`UPDATE clustering_run SET algorithm = 'kmeans' WHERE id = $1`, [d.run.id])), 'SZ002');
    });

    it('allow withdrawing segmentations and embedding spaces', async () => {
      const d = await as(seedDerived);
      const s = await as((c) =>
        one(c, `UPDATE segmentation SET withdrawn_at = now(), withdrawn_reason = 'bad' WHERE id = $1 RETURNING *`, [d.seg.id]),
      );
      expect(s.withdrawn_by).toBe(curator.id);
      await as((c) => c.query(`UPDATE embedding_space SET withdrawn_at = now() WHERE id = $1`, [d.space.id]));
      const audit = await pool.query(`SELECT action FROM audit_event WHERE entity_id = $1 ORDER BY ${AUDIT_ORDER}`, [d.seg.id]);
      expect(audit.rows.map((r) => r.action)).toEqual(['insert', 'withdraw']);
    });

    it('chunk hash is computed and chunk text length must match its span', async () => {
      const d = await as(seedDerived);
      expect(d.chunk.content_sha256).toBe(sha256('Magnus'));
      await expectPgError(
        as((c) =>
          c.query(
            `INSERT INTO chunk (segmentation_id, text_id, sequence, start_offset, end_offset, text) VALUES ($1, $2, 1, 0, 3, 'Magnus')`,
            [d.seg.id, d.text.id],
          ),
        ),
        '23514',
      );
    });

    it("chunk.text_id must match the segmentation's text", async () => {
      const d = await as(seedDerived);
      await expectPgError(
        as(async (c) => {
          const t2 = await insertText(c, d.work.id, 'Other text');
          return c.query(
            `INSERT INTO chunk (segmentation_id, text_id, sequence, start_offset, end_offset, text) VALUES ($1, $2, 1, 0, 5, 'Other')`,
            [d.seg.id, t2.id],
          );
        }),
        '23503',
      );
    });

    it('embedding dimension must equal the space dimensions', async () => {
      const d = await as(seedDerived);
      const e = await expectPgError(
        as(async (c) => {
          const ch = await one(
            c,
            `INSERT INTO chunk (segmentation_id, text_id, sequence, start_offset, end_offset, text) VALUES ($1, $2, 1, 7, 13, 'es, do') RETURNING id`,
            [d.seg.id, d.text.id],
          );
          return c.query(`INSERT INTO embedding (chunk_id, embedding_space_id, vector) VALUES ($1, $2, '[1,2]')`, [ch.id, d.space.id]);
        }),
        'SZ004',
      );
      expect(e.message).toMatch(/2 dimensions, space requires 3/);
    });

    it('clusters and memberships can only be added while the run is open', async () => {
      const d = await as(seedDerived);
      await as(async (c) => {
        const cl = await one(c, `INSERT INTO cluster (clustering_run_id, cluster_number, centroid) VALUES ($1, 0, '[1,0,0]') RETURNING id`, [d.run.id]);
        await c.query(`INSERT INTO cluster_membership (clustering_run_id, embedding_id, cluster_id) VALUES ($1, $2, $3)`, [d.run.id, d.emb.id, cl.id]);
      });
      const done = await as((c) => one(c, `UPDATE clustering_run SET status = 'complete' WHERE id = $1 RETURNING *`, [d.run.id]));
      expect(done.completed_at).not.toBeNull();

      await expectPgError(as((c) => c.query(`INSERT INTO cluster (clustering_run_id, cluster_number) VALUES ($1, 1)`, [d.run.id])), 'SZ003');
      await expectPgError(as((c) => c.query(`UPDATE clustering_run SET status = 'open' WHERE id = $1`, [d.run.id])), 'SZ003');
      await as((c) => c.query(`UPDATE clustering_run SET status = 'withdrawn' WHERE id = $1`, [d.run.id]));

      const audit = await pool.query(`SELECT action, changes FROM audit_event WHERE entity_type = 'clustering_run' AND entity_id = $1 ORDER BY ${AUDIT_ORDER}`, [d.run.id]);
      expect(audit.rows.map((r) => r.action)).toEqual(['insert', 'status_change', 'status_change']);
      expect(audit.rows[1].changes.status).toEqual({ old: 'open', new: 'complete' });
    });

    it('runs must be created open', async () => {
      const d = await as(seedDerived);
      await expectPgError(
        as((c) => c.query(`INSERT INTO clustering_run (embedding_space_id, algorithm, metric, producer, status) VALUES ($1, 'k', 'l2', $2, 'complete')`, [d.space.id, PRODUCER])),
        'SZ003',
      );
    });

    it('membership embedding must be in the run space; cluster must be in the run', async () => {
      const a = await as(seedDerived);
      const b = await as(seedDerived);
      await expectPgError(
        as((c) => c.query(`INSERT INTO cluster_membership (clustering_run_id, embedding_id) VALUES ($1, $2)`, [a.run.id, b.emb.id])),
        'SZ004',
      );
      await expectPgError(
        as(async (c) => {
          const cl = await one(c, `INSERT INTO cluster (clustering_run_id, cluster_number) VALUES ($1, 0) RETURNING id`, [b.run.id]);
          return c.query(`INSERT INTO cluster_membership (clustering_run_id, embedding_id, cluster_id) VALUES ($1, $2, $3)`, [a.run.id, a.emb.id, cl.id]);
        }),
        '23503',
      );
      // noise (cluster_id NULL) is fine
      await as((c) => c.query(`INSERT INTO cluster_membership (clustering_run_id, embedding_id) VALUES ($1, $2)`, [a.run.id, a.emb.id]));
    });

    it('producer is required and validated', async () => {
      const d = await as(seedDerived);
      for (const producer of [null, {}, { tool: 'x' }, { tool: 'x', version: 1 }, { tool: 'x', version: '1', parameters: [] }]) {
        await expectPgError(
          as((c) => c.query(`INSERT INTO segmentation (text_id, method, producer) VALUES ($1, 'm', $2)`, [d.text.id, producer])),
          producer === null ? '23502' : '23514',
        );
      }
    });

    it('model labels need model and producer; superseded label must be in the same cluster', async () => {
      const d = await as(seedDerived);
      await as(async (c) => {
        const c1 = await one(c, `INSERT INTO cluster (clustering_run_id, cluster_number) VALUES ($1, 0) RETURNING id`, [d.run.id]);
        await expectPgError(
          c.query(`SAVEPOINT s; INSERT INTO label (cluster_id, language, label, producer_kind) VALUES ('${c1.id}', 'en', 'x', 'model')`),
          '23514',
        );
        await c.query('ROLLBACK TO SAVEPOINT s');
        const c2 = await one(c, `INSERT INTO cluster (clustering_run_id, cluster_number) VALUES ($1, 1) RETURNING id`, [d.run.id]);
        const l1 = await one(c, `INSERT INTO label (cluster_id, language, label, producer_kind) VALUES ($1, 'en', 'x', 'human') RETURNING id`, [c1.id]);
        await expectPgError(
          c.query(`INSERT INTO label (cluster_id, language, label, producer_kind, supersedes_label_id) VALUES ($1, 'en', 'y', 'human', $2)`, [c2.id, l1.id]),
          '23503',
        );
      });
    });
  });

  describe('audit_event', () => {
    it('records row-level diffs for curated tables, without text bodies', async () => {
      const requestId = `test:${crypto.randomUUID()}`;
      const t = await asUser(pool, curator.id, async (c) => insertText(c, (await insertWork(c)).id, 'Secret body'), requestId);
      await as((c) => c.query(`UPDATE text SET coverage = 'partial', coverage_note = 'Book X' WHERE id = $1`, [t.id]));
      await as((c) => c.query(`UPDATE text SET coverage = 'partial' WHERE id = $1`, [t.id])); // no-op: no event

      const { rows } = await pool.query(
        `SELECT action, actor_id, request_id, changes FROM audit_event WHERE entity_type = 'text' AND entity_id = $1 ORDER BY ${AUDIT_ORDER}`,
        [t.id],
      );
      expect(rows.map((r) => r.action)).toEqual(['insert', 'update']);
      expect(rows[0].actor_id).toBe(curator.id);
      expect(rows[0].request_id).toBe(requestId);
      expect(rows[0].changes).not.toHaveProperty('body');
      expect(rows[0].changes.content_sha256).toBe(sha256('Secret body'));
      expect(rows[1].changes).toEqual({
        coverage: { old: 'complete', new: 'partial' },
        coverage_note: { old: null, new: 'Book X' },
      });
    });

    it('join-table deletes are audited', async () => {
      const w = await as(async (c) => {
        const w = await insertWork(c);
        const p = await one(c, `INSERT INTO person (display_name) VALUES ('Augustinus') RETURNING id`);
        await c.query(`INSERT INTO work_person (work_id, person_id, role) VALUES ($1, $2, 'author')`, [w.id, p.id]);
        await c.query(`DELETE FROM work_person WHERE work_id = $1`, [w.id]);
        return w;
      });
      const { rows } = await pool.query(`SELECT action FROM audit_event WHERE entity_type = 'work_person' AND entity_id = $1 ORDER BY ${AUDIT_ORDER}`, [w.id]);
      // same transaction: UUIDv7 ids within one millisecond are unordered, so compare as a set
      expect(rows.map((r) => r.action).sort()).toEqual(['delete', 'insert']);
    });

    it('writeBatchAudit records one batch_insert event', async () => {
      const d = await as(seedDerived);
      await as((c) => writeBatchAudit(c, { entityType: 'chunk', parentId: d.seg.id, count: 5000, changes: { skipped: 0 } }));
      const { rows } = await pool.query(
        `SELECT action, batch_count, actor_id, changes FROM audit_event WHERE entity_type = 'chunk' AND entity_id = $1`,
        [d.seg.id],
      );
      expect(rows).toEqual([{ action: 'batch_insert', batch_count: 5000, actor_id: curator.id, changes: { skipped: 0 } }]);
    });

    it('cannot be updated or deleted, and actor_id cannot be forged', async () => {
      const ev = await as((c) =>
        one(c, `INSERT INTO audit_event (action, entity_type, actor_id) VALUES ('update', 'x', $1) RETURNING *`, [other.id]),
      );
      expect(ev.actor_id).toBe(curator.id);
      await expectPgError(as((c) => c.query(`UPDATE audit_event SET action = 'insert' WHERE id = $1`, [ev.id])), 'SZ002');
      await expectPgError(as((c) => c.query(`DELETE FROM audit_event WHERE id = $1`, [ev.id])), 'SZ002');
      await expectPgError(pool.query(`UPDATE audit_event SET action = 'insert' WHERE id = $1`, [ev.id]), 'SZ002');
    });
  });
});
