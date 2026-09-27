/**
 * sermonize-admin's only way to the data: HTTP calls to the Sermonize REST API.
 * API errors become CliError with a readable message (exit 2 for 401/403, else 1).
 */
import { CliError, EXIT_AUTH, EXIT_ERROR } from './errors.js';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export type Role = 'reader' | 'contributor' | 'curator' | 'admin';
export const ROLES: readonly Role[] = ['reader', 'contributor', 'curator', 'admin'];

export interface AdminUser {
  id: string;
  kind: 'human' | 'service';
  role: Role;
  status: 'active' | 'disabled';
  email: string | null;
  display_name: string | null;
  has_password: boolean;
  created_at: string;
  updated_at: string;
}

export interface TokenSummary {
  total: number;
  active: number;
  expired: number;
  revoked: number;
}

export interface TokenInfo {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  state: 'active' | 'expired' | 'revoked';
}

export interface IssuedToken {
  id: string;
  user_id: string;
  name: string;
  expires_at: string | null;
  token: string;
}

export interface Me {
  user_id: string;
  role: Role;
  kind: 'human' | 'service';
}

export interface LoginResult {
  token: string;
  expires_at: string;
  user_id: string;
  role: Role;
}

const TIMEOUT_MS = 30_000;

/** Explains the API's conflict reasons from PATCH /admin/users/:id in plain words. */
function describeApiError(status: number, body: ApiErrorBody['error']): string {
  const reason = (body.details as { reason?: string } | undefined)?.reason;
  if (status === 409 && reason === 'last_admin') {
    return 'refused: this is the last active admin account. Promote another user to admin first (sermonize-admin users set-role <id> admin).';
  }
  if (status === 409 && reason === 'self') {
    return 'refused: you cannot demote or disable your own account. Ask another admin to do it.';
  }
  if (status === 409 && reason === 'system_user') return 'refused: the built-in system user cannot be changed.';
  if (status === 401) {
    return `not authenticated (${body.message}). Run \`sermonize-admin login\` or set SERMONIZE_TOKEN.`;
  }
  if (status === 403) return `forbidden: ${body.message}. These commands need an admin account.`;
  return `${body.message} (${status} ${body.code})`;
}

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false) {
      if (!this.token) {
        throw new CliError(
          `not logged in to ${this.baseUrl}. Run \`sermonize-admin login --email <email>\` or set SERMONIZE_TOKEN.`,
          EXIT_AUTH,
        );
      }
      headers.authorization = `Bearer ${this.token}`;
    }
    let res: Response;
    try {
      // `path` is relative to the base URL, which may itself have a path (https://example.org/api behind
      // a reverse proxy): resolve it without its leading slash so the base path is kept.
      res = await this.fetchImpl(new URL(path.replace(/^\/+/, ''), `${this.baseUrl}/`), {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw new CliError(`cannot reach the Sermonize API at ${this.baseUrl}: ${cause}`, EXIT_ERROR);
    }
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const error =
        json && typeof json === 'object' && 'error' in json
          ? (json as ApiErrorBody).error
          : { code: `http_${res.status}`, message: res.statusText || 'request failed' };
      const exit = res.status === 401 || res.status === 403 ? EXIT_AUTH : EXIT_ERROR;
      throw new CliError(describeApiError(res.status, error), exit, error, res.status);
    }
    return json as T;
  }
}
