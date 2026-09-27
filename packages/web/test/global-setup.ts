import pg from 'pg';
import { migrate } from '@sermonize/api/db/migrate';
import { TEST_DATABASE_URL } from './db-url.js';

/**
 * Shares the API's test database without resetting it (same rule as packages/mcp): the API
 * suite drops and recreates the schemas in its own globalSetup, and the root `npm test` runs
 * the workspaces one after another. Here we only apply pending migrations, which also makes
 * `npm test -w @sermonize/web` work on a fresh database. Tests use unique emails and assert
 * on count deltas only.
 */
export async function setup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
