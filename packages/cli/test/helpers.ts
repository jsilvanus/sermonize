import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import pg from 'pg';
import { buildApp, type BuildAppOptions } from '@sermonize/api/app';
import { withTransaction } from '@sermonize/api/db/transaction';
import { hashPassword } from '@sermonize/api/lib/passwords';
import { SYSTEM_PRINCIPAL, type Role } from '@sermonize/api/lib/principal';
import { createUser, issueToken, setUserPassword } from '@sermonize/api/lib/users';
import { main } from '../src/main.js';
import { TEST_DATABASE_URL } from './db-url.js';

export interface RunningApi {
  url: string;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Starts the real Sermonize API (from source) on an ephemeral port against the test database. */
export async function startApi(auth: BuildAppOptions['auth'] = {}): Promise<RunningApi> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  const app = await buildApp({ pool, auth });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    pool,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

const run = randomUUID().slice(0, 8);
let seq = 0;
/** A unique email per call (the test database is shared across packages and runs). */
export const uniqueEmail = (prefix = 'cli') => `${prefix}.${run}.${++seq}@example.org`;

export const asSystem = <T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>) =>
  withTransaction(pool, SYSTEM_PRINCIPAL, `cli-test:${randomUUID()}`, fn);

/** A human user with email + password, created directly in the database (the bootstrap path). */
export async function passwordUser(pool: pg.Pool, role: Role, password: string): Promise<{ id: string; email: string }> {
  const email = uniqueEmail(role);
  const passwordHash = await hashPassword(password);
  const id = await asSystem(pool, async (c) => {
    const user = await createUser(c, { kind: 'human', role, email });
    await setUserPassword(c, { userId: user.id, passwordHash });
    return user.id;
  });
  return { id, email };
}

/** An API token for an existing user (e.g. the system user), issued directly. */
export async function tokenFor(pool: pg.Pool, userId: string): Promise<{ id: string; token: string }> {
  return asSystem(pool, (c) => issueToken(c, { userId, name: 'cli-test' }));
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A per-test temporary XDG_CONFIG_HOME. */
export async function tempConfigHome(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'sermonize-cli-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Runs the CLI's main() with injected streams. `input` lines are fed to stdin (as a pipe,
 * or as a fake terminal with `tty: true`).
 */
export async function cli(
  argv: string[],
  opts: { env: Record<string, string | undefined>; input?: string[]; tty?: boolean },
): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  let stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  if (opts.tty) {
    const tty = new PassThrough() as PassThrough & { isTTY?: boolean };
    tty.isTTY = true;
    // Typed keystrokes arrive after the prompt.
    setImmediate(() => {
      for (const line of opts.input ?? []) tty.write(`${line}\r`);
    });
    stdin = tty;
  } else {
    stdin = Readable.from((opts.input ?? []).map((l) => `${l}\n`));
  }
  const code = await main({
    argv,
    env: opts.env,
    stdin,
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
  });
  return { code, stdout, stderr };
}
