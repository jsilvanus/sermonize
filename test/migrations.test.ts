import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { SYSTEM_USER_ID } from '../src/lib/principal.js';
import { createTestPool } from './helpers.js';

describe('migrations', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = createTestPool();
  });
  afterAll(() => pool.end());

  it('applied 0001_init and re-running is a no-op', async () => {
    const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    expect(rows.map((r) => r.version)).toContain('0001_init');
    expect(await migrate(pool)).toEqual([]);
  });

  it('creates every table from the spec', async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT table_schema || '.' || table_name AS name FROM information_schema.tables
        WHERE table_schema IN ('public', 'private') AND table_type = 'BASE TABLE'`,
    );
    const names = rows.map((r) => r.name);
    for (const t of [
      'public.app_user', 'public.audit_event', 'public.person', 'public.work', 'public.work_person',
      'public.sermon_occasion', 'public.source', 'public.text', 'public.text_person',
      'public.segmentation', 'public.chunk', 'public.embedding_space', 'public.embedding',
      'public.clustering_run', 'public.cluster', 'public.cluster_membership', 'public.label',
      'public.label_review', 'private.auth_identity', 'private.api_token', 'private.user_pii',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('creates the fixed system user', async () => {
    const { rows } = await pool.query('SELECT kind, role, status, created_by FROM app_user WHERE id = $1', [
      SYSTEM_USER_ID,
    ]);
    expect(rows[0]).toEqual({ kind: 'service', role: 'admin', status: 'active', created_by: SYSTEM_USER_ID });
  });

  it('uuid_generate_v7() yields time-ordered version-7 UUIDs', async () => {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT uuid_generate_v7()::text AS id FROM generate_series(1, 50)',
    );
    const ids = rows.map((r) => r.id);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const msPrefix = (id: string) => id.replace(/-/g, '').slice(0, 12);
    expect(ids.map(msPrefix)).toEqual([...ids.map(msPrefix)].sort());
    const tsMs = parseInt(msPrefix(ids[0]!), 16);
    expect(Math.abs(tsMs - Date.now())).toBeLessThan(60_000);
  });

  it('has an index led by a column of every foreign key (except audit-column FKs to app_user)', async () => {
    const { rows } = await pool.query<{ fk: string }>(`
      SELECT c.conrelid::regclass || '(' || array_to_string(ARRAY(
               SELECT a.attname FROM unnest(c.conkey) k JOIN pg_attribute a
                 ON a.attrelid = c.conrelid AND a.attnum = k), ',') || ')' AS fk
        FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.connamespace IN ('public'::regnamespace, 'private'::regnamespace)
         AND NOT EXISTS (
           SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.conrelid
              AND (i.indkey::int2[])[0] = ANY (c.conkey))
         AND NOT (cardinality(c.conkey) = 1 AND EXISTS (
           SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
              AND a.attname IN ('created_by', 'updated_by', 'withdrawn_by')))`);
    expect(rows.map((r) => r.fk)).toEqual([]);
  });
});
