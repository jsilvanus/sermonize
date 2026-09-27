/**
 * Per-space partial HNSW indexes on `embedding`, managed by the operator CLI
 * (`create-index`, `drop-index`), never by the public API.
 *
 * `CREATE/DROP INDEX CONCURRENTLY` cannot run inside a transaction block, so
 * these functions use the pool directly (autocommit), not withTransaction().
 */
import type { Pool } from 'pg';
import type { Db } from './sql.js';
import { castType, indexName, MAX_INDEX_DIMENSIONS, opclass, type Metric } from './vector.js';

export interface SpaceIndexTarget {
  id: string;
  dimensions: number;
  metric: Metric;
}

/** The CREATE INDEX statement for a space (the id is a validated UUID; dimensions an integer). */
export function createIndexSql(space: SpaceIndexTarget): string {
  if (space.dimensions > MAX_INDEX_DIMENSIONS) {
    throw new Error(
      `embedding space ${space.id} has ${space.dimensions} dimensions; HNSW indexes support at most ${MAX_INDEX_DIMENSIONS}`,
    );
  }
  const name = indexName(space.id); // also validates the id
  return `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON embedding
    USING hnsw ((vector::${castType(space.dimensions)}) ${opclass(space.metric, space.dimensions)})
    WHERE embedding_space_id = '${space.id.toLowerCase()}'`;
}

async function loadSpace(pool: Pool, spaceId: string): Promise<SpaceIndexTarget> {
  indexName(spaceId); // reject malformed ids before querying
  const { rows } = await pool.query<SpaceIndexTarget>(
    'SELECT id, dimensions, metric FROM embedding_space WHERE id = $1',
    [spaceId],
  );
  if (!rows[0]) throw new Error(`embedding space ${spaceId} not found`);
  return rows[0];
}

/** Index state: absent, valid, or invalid (a failed CONCURRENTLY build). */
export async function indexStatus(pool: Db, spaceId: string): Promise<'absent' | 'valid' | 'invalid'> {
  const { rows } = await pool.query<{ valid: boolean }>(
    `SELECT i.indisvalid AS valid FROM pg_index i
      WHERE i.indexrelid = to_regclass(current_schema() || '.' || $1)`,
    [indexName(spaceId)],
  );
  if (!rows[0]) return 'absent';
  return rows[0].valid ? 'valid' : 'invalid';
}

/**
 * Creates the space's HNSW index if missing. An invalid leftover from an
 * interrupted build is dropped and rebuilt. Returns the index name and
 * whether it was (re)built.
 */
export async function createVectorIndex(pool: Pool, spaceId: string): Promise<{ name: string; created: boolean }> {
  const space = await loadSpace(pool, spaceId);
  const sql = createIndexSql(space);
  const name = indexName(space.id);
  const status = await indexStatus(pool, space.id);
  if (status === 'valid') return { name, created: false };
  if (status === 'invalid') await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
  await pool.query(sql);
  return { name, created: true };
}

/** Drops the space's HNSW index if present. Returns whether it existed. */
export async function dropVectorIndex(pool: Pool, spaceId: string): Promise<{ name: string; dropped: boolean }> {
  const name = indexName(spaceId);
  const existed = (await indexStatus(pool, spaceId)) !== 'absent';
  await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
  return { name, dropped: existed };
}
