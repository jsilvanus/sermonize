/**
 * The web app's only way to the data: HTTP calls to the Sermonize REST API.
 * Network errors, timeouts and 5xx answers become ApiUnavailableError (-> friendly 503 page).
 */
export class ApiUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiUnavailableError';
  }
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiErrorBody['error'] };

export interface Stats {
  persons: number;
  works: number;
  works_by_genre: Record<string, number>;
  sermons: number;
  texts: number;
  texts_by_language: Record<string, number>;
  sources: number;
  segmentations: number;
  chunks: number;
  embedding_spaces: number;
  embeddings: number;
  complete_clustering_runs: number;
  clusters: number;
  labels: number;
}

export interface AuthConfig {
  registration_open: boolean;
  password_min_length: number;
  password_max_length: number;
}

export interface Me {
  user_id: string;
  role: string;
  kind: string;
}

export interface LoginResult {
  token: string;
  expires_at: string;
  user_id: string;
  role: string;
}

interface RequestOptions {
  token?: string | undefined;
  body?: unknown;
  /** The browser's IP, forwarded as X-Forwarded-For (the API honours it only with TRUST_PROXY). */
  clientIp?: string | undefined;
}

export class SermonizeApi {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.clientIp) headers['x-forwarded-for'] = opts.clientIp;
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      throw new ApiUnavailableError(`API request ${method} ${path} failed`, { cause: err });
    }
    if (res.status >= 500) throw new ApiUnavailableError(`API request ${method} ${path} answered ${res.status}`);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiUnavailableError(`API request ${method} ${path} returned invalid JSON`);
    }
    if (res.ok) return { ok: true, status: res.status, data: json as T };
    const error = (json as Partial<ApiErrorBody> | null)?.error ?? { code: 'unknown', message: res.statusText };
    return { ok: false, status: res.status, error };
  }

  stats() {
    return this.request<Stats>('GET', '/stats');
  }
  authConfig() {
    return this.request<AuthConfig>('GET', '/auth/config');
  }
  me(token: string) {
    return this.request<Me>('GET', '/me', { token });
  }
  register(body: { email: string; password: string; display_name?: string }, clientIp?: string) {
    return this.request<{ user_id: string; role: string }>('POST', '/auth/register', { body, clientIp });
  }
  login(body: { email: string; password: string }, clientIp?: string) {
    // client 'web': the token is named web and lives LOGIN_TOKEN_TTL_HOURS (the API's default client).
    return this.request<LoginResult>('POST', '/auth/login', { body: { ...body, client: 'web' }, clientIp });
  }
  logout(token: string) {
    return this.request<null>('POST', '/auth/logout', { token });
  }
}
