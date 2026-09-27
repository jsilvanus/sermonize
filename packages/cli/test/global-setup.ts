import pg from 'pg';
import { migrate } from '@sermonize/api/db/migrate';
import { TEST_DATABASE_URL } from './db-url.js';

/**
 * Shares the API's test database without resetting it (same rule as packages/web and
 * packages/mcp): only the API suite drops and recreates the schemas. Here we only apply
 * pending migrations. Tests use unique emails and never rely on global counts.
 */
export async function setup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
