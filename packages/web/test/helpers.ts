import { randomBytes, randomUUID } from 'node:crypto';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { buildApp, type BuildAppOptions } from '@sermonize/api/app';
import { withTransaction } from '@sermonize/api/db/transaction';
import { SYSTEM_PRINCIPAL, type Role } from '@sermonize/api/lib/principal';
import { createUser, issueToken } from '@sermonize/api/lib/users';
import { buildWebApp, type WebApp } from '../src/app.js';
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

/** A user + API token created directly (as the system user), e.g. to seed corpus data. */
export async function apiUser(pool: pg.Pool, role: Role): Promise<{ id: string; token: string }> {
  return withTransaction(pool, SYSTEM_PRINCIPAL, `web-test:${randomUUID()}`, async (client) => {
    const user = await createUser(client, { kind: 'human', role });
    const token = await issueToken(client, { userId: user.id, name: 'web-test', expiresAt: null });
    return { id: user.id, token: token.token };
  });
}

export function buildWeb(apiUrl: string, opts: { cookieSecure?: boolean } = {}): Promise<WebApp> {
  return buildWebApp({
    sermonizeApiUrl: apiUrl,
    cookieSecret: randomBytes(32).toString('base64'),
    cookieSecure: opts.cookieSecure ?? false,
    requestTimeoutMs: 5_000,
  });
}

/** A minimal browser: keeps cookies between `inject` calls and knows the page's CSRF token. */
export class Browser {
  readonly cookies = new Map<string, string>();
  constructor(private readonly app: WebApp) {}

  async request(opts: InjectOptions): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({ ...opts, cookies: Object.fromEntries(this.cookies) });
    for (const c of res.cookies as { name: string; value: string; expires?: Date; maxAge?: number }[]) {
      const expired = (c.expires && c.expires.getTime() <= Date.now()) || c.maxAge === 0 || c.value === '';
      if (expired) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  get(url: string) {
    return this.request({ method: 'GET', url });
  }

  /** POSTs a form; `_csrf` is taken from the cookie jar unless given (use null to omit). */
  post(url: string, form: Record<string, string>, csrf?: string | null) {
    const token = csrf === undefined ? this.csrf() : csrf;
    const fields = token === null ? form : { _csrf: token, ...form };
    return this.request({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(fields).toString(),
    });
  }

  /** The CSRF token as embedded in forms (the cookie value without its signature). */
  csrf(): string {
    const raw = this.cookies.get('sz_csrf');
    if (!raw) throw new Error('no CSRF cookie yet: GET a page first');
    return raw.slice(0, raw.lastIndexOf('.'));
  }

  /** The API token inside the signed session cookie. */
  sessionToken(): string | undefined {
    const raw = this.cookies.get('sz_session');
    return raw?.slice(0, raw.lastIndexOf('.'));
  }
}

/** Extracts the hidden CSRF field of the first form in a page. */
export function csrfFromPage(body: string): string | undefined {
  return /name="_csrf" value="([^"]+)"/.exec(body)?.[1];
}
