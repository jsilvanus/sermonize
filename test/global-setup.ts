import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { TEST_DATABASE_URL } from './db-url.js';

/**
 * Runs once per `vitest run`: drops the `public` and `private` schemas of the
 * test database, recreates `public`, and applies all migrations.
 */
export async function setup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await pool.query('DROP SCHEMA IF EXISTS private CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
