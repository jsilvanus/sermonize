/**
 * Shared test helpers. Typical use in a test file:
 *
 *   const ctx = await setupTestApp();          // in beforeAll
 *   const admin = await createUser(ctx.pool, { role: 'admin' });
 *   const res = await api(ctx.app, admin, { method: 'GET', url: '/me' });
 *   await ctx.close();                         // in afterAll
 *
 * The database is reset once per test run (test/global-setup.ts), not per file,
 * so tests must not depend on global row counts: create what you need and
 * filter by the ids you created.
 */
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { buildApp, type App, type BuildAppOptions } from '../src/app.js';
import { withTransaction } from '../src/db/transaction.js';
import { SYSTEM_PRINCIPAL, type Role, type UserKind } from '../src/lib/principal.js';
import { createUser as createAppUser, issueToken } from '../src/lib/users.js';
import { TEST_DATABASE_URL } from './db-url.js';

export { TEST_DATABASE_URL, SYSTEM_PRINCIPAL };

/**
 * `ORDER BY` for audit_event rows in tests. Rows written in one transaction share `occurred_at` (the
 * transaction time) and their UUIDv7 ids are not ordered within a millisecond, so the order of rows
 * within one transaction is not meaningful: they are sorted by what the assertions compare (action,
 * entity type, changes), which is deterministic. Transactions themselves stay in time order.
 */
export const AUDIT_ORDER = 'occurred_at, action, entity_type, changes::text, id';

export interface TestContext {
  app: App;
  pool: Pool;
  close(): Promise<void>;
}

export function createTestPool(): Pool {
  return new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
}

/** Builds the app against the test database. Call `close()` in afterAll. */
export async function setupTestApp(
  opts: Pick<BuildAppOptions, 'maxBatchItems' | 'auth' | 'trustProxy' | 'publicBasePath'> = {},
): Promise<TestContext> {
  const pool = createTestPool();
  const app = await buildApp({ pool, ...opts });
  return {
    app,
    pool,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

/** A user created directly in the database, with a working API token. */
export interface TestUser {
  id: string;
  role: Role;
  kind: UserKind;
  token: string;
  tokenId: string;
}

/** Creates a user (as the system principal) and issues it a token. */
export async function createUser(
  pool: Pool,
  opts: { role: Role; kind?: UserKind; status?: 'active' | 'disabled'; tokenExpiresAt?: string } = {
    role: 'reader',
  },
): Promise<TestUser> {
  return asSystem(pool, async (client) => {
    const user = await createAppUser(client, { kind: opts.kind ?? 'human', role: opts.role, status: opts.status });
    const token = await issueToken(client, {
      userId: user.id,
      name: 'test',
      expiresAt: opts.tokenExpiresAt ?? null,
    });
    return { id: user.id, role: user.role, kind: user.kind, token: token.token, tokenId: token.id };
  });
}

/** Runs `fn` in a transaction as the given user (sets app.user_id / app.request_id). */
export function asUser<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
  requestId = `test:${randomUUID()}`,
): Promise<T> {
  return withTransaction(pool, { userId }, requestId, fn);
}

/** Runs `fn` in a transaction as the fixed system admin user. */
export function asSystem<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return asUser(pool, SYSTEM_PRINCIPAL.userId, fn);
}

/** `app.inject` with `Authorization: Bearer <token>` for a TestUser, a raw token, or none (null). */
export function api(
  app: App,
  as: TestUser | string | null,
  opts: InjectOptions,
): Promise<LightMyRequestResponse> {
  const token = as === null ? null : typeof as === 'string' ? as : as.token;
  const headers = { ...(opts.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  return app.inject({ ...opts, headers });
}

/** Expects a PostgreSQL error with the given SQLSTATE from `promise`. */
export async function expectPgError(promise: Promise<unknown>, sqlstate: string): Promise<pg.DatabaseError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof pg.DatabaseError && err.code === sqlstate) return err;
    throw new Error(`expected SQLSTATE ${sqlstate}, got: ${(err as Error).message} (${(err as pg.DatabaseError).code})`);
  }
  throw new Error(`expected SQLSTATE ${sqlstate}, but the statement succeeded`);
}
