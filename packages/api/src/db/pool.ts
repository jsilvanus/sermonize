import pg from 'pg';

export type { Pool, PoolClient } from 'pg';

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}
