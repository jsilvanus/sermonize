import type { Pool, PoolClient } from 'pg';
import type { Principal } from '../lib/principal.js';

/**
 * Runs `fn` in one transaction with `app.user_id` and `app.request_id` set
 * (SET LOCAL semantics), so database triggers can fill created_by/updated_by
 * and write audit events. Every write must go through this helper.
 */
export async function withTransaction<T>(
  pool: Pool,
  /** null only for the self-service auth functions, which set their own actor (see migration 0003). */
  principal: Pick<Principal, 'userId'> | null,
  requestId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.request_id', $2, true)`,
      [principal?.userId ?? '', requestId],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      broken = rollbackErr as Error; // connection is unusable; destroy it on release
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
