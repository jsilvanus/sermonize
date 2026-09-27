import pg from 'pg';
import { migrate } from '@sermonize/api/db/migrate';
import { TEST_DATABASE_URL } from './db-url.js';

/**
 * Shares the API's test database without resetting it. The API suite drops and recreates the
 * schemas in its own globalSetup; the root `npm test` runs the workspaces one after another, so the
 * two never overlap. Here we only apply pending migrations (idempotent, advisory-locked), which
 * also makes `npm test -w @sermonize/mcp` work on a fresh database. Tests create their own
 * uniquely named rows and never depend on global counts.
 */
export async function setup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
