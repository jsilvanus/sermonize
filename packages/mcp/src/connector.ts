/**
 * Typed HTTP client for the Sermonize REST API.
 *
 * This is the only place that talks to Sermonize, and it does so over HTTP only: no database access,
 * no domain logic beyond mapping arguments to paths/query strings/bodies, no AI processing.
 * Every tool call carries the Sermonize API token of the OAuth grant it runs under (obtained when the
 * user signed in with their Sermonize account), so the API's role checks and audit trail apply to the
 * real user. Tokens are never logged or put into error text.
 */

export interface ConnectorContext {
  /** The Sermonize API token of the caller's OAuth grant (resolved server-side, never a tool argument). */
  apiToken: string;
}

/** A JSON object returned by the API (entity shapes are documented by the API's OpenAPI at /docs). */
export type JsonObject = Record<string, unknown>;

export interface Page<T = JsonObject> {
  items: T[];
  next_cursor: string | null;
}

export interface Me {
  user_id: string;
  role: 'reader' | 'contributor' | 'curator' | 'admin';
  kind: 'human' | 'service';
}

export interface LoginResult {
  token: string;
  /** ISO timestamp. */
  expires_at: string;
  user_id: string;
  role: Me['role'];
}

export interface TextBody {
  text_id: string;
  start: number;
  end: number;
  content: string;
}

export interface PageQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

type QueryValue = string | number | boolean | undefined;
export type Query = Record<string, QueryValue>;

export interface PersonQuery extends PageQuery {
  q?: string | undefined;
  include_withdrawn?: boolean | undefined;
}
export interface WorkQuery extends PageQuery {
  genre?: string | undefined;
  person_id?: string | undefined;
  year_from?: number | undefined;
  year_to?: number | undefined;
  part_of_work_id?: string | undefined;
  include_withdrawn?: boolean | undefined;
}
export interface SourceQuery extends PageQuery {
  include_withdrawn?: boolean | undefined;
}
export interface TextQuery extends PageQuery {
  work_id?: string | undefined;
  language?: string | undefined;
  relation?: string | undefined;
  source_id?: string | undefined;
  include_withdrawn?: boolean | undefined;
}
export interface EmbeddingSpaceQuery extends PageQuery {
  include_withdrawn?: boolean | undefined;
}
export interface ClusteringRunQuery extends PageQuery {
  embedding_space_id?: string | undefined;
  status?: 'open' | 'complete' | 'withdrawn' | 'all' | undefined;
}
export interface LabelQuery extends PageQuery {
  language?: string | undefined;
}

export interface SearchRequest {
  embedding_space_id: string;
  vector: number[];
  limit?: number | undefined;
  filters?: JsonObject | undefined;
}

export interface LabelProposal {
  language: string;
  label: string;
  description?: string | null | undefined;
  producer_kind: 'human' | 'model';
  model?: string | null | undefined;
  model_version?: string | null | undefined;
  producer?: JsonObject | null | undefined;
  supersedes_label_id?: string | null | undefined;
  metadata?: JsonObject | undefined;
}

export interface LabelReview {
  decision: 'accepted' | 'rejected' | 'needs_revision';
  note?: string | null | undefined;
}

/** A non-2xx API response (or a transport failure), carrying the API's `{ error: { code, message, details } }`. */
export class SermonizeApiError extends Error {
  constructor(
    /** HTTP status, or 0 for timeouts and network errors. */
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SermonizeApiError';
  }
}

export interface SermonizeClientOptions {
  /** Base URL of the API, e.g. http://127.0.0.1:3000 */
  baseUrl: string;
  /** Per-request timeout in milliseconds (default 15000). */
  timeoutMs?: number;
  /** Injectable fetch, for tests. */
  fetch?: typeof fetch;
}

const seg = (id: string) => encodeURIComponent(id);

/** Encodes defined values only; booleans and numbers as their string forms. */
export function toQueryString(query: Query | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.append(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export class SermonizeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SermonizeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async request<T>(
    context: ConnectorContext,
    method: 'GET' | 'POST',
    path: string,
    options: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    return this.send<T>(method, path, { ...options, token: context.apiToken });
  }

  /** One HTTP call; `token` becomes the Bearer header, `clientIp` the X-Forwarded-For header. */
  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { query?: Query; body?: unknown; token?: string; clientIp?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.clientIp) headers['x-forwarded-for'] = options.clientIp;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path + toQueryString(options.query), {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new SermonizeApiError(0, 'timeout', `the Sermonize API did not answer within ${this.timeoutMs} ms`);
      }
      throw new SermonizeApiError(0, 'upstream_unavailable', 'the Sermonize API could not be reached');
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (response.ok) return json as T;

    const error = (json as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined)?.error;
    throw new SermonizeApiError(
      response.status,
      typeof error?.code === 'string' ? error.code : `http_${response.status}`,
      typeof error?.message === 'string' ? error.message : response.statusText || 'request failed',
      error?.details,
    );
  }

  // --- sign-in (no token; used by the OAuth sign-in page and grant cleanup) -------------------

  /**
   * `POST /auth/login` with `client: 'mcp'`: verifies the user's Sermonize email and password and
   * returns a new API token (named `mcp`, lifetime MCP_LOGIN_TOKEN_TTL_HOURS on the API).
   * `clientIp` is the end user's address, forwarded so the API's per-IP rate limit sees the person,
   * not this server (the API trusts it only if its TRUST_PROXY lists this server).
   */
  login(credentials: { email: string; password: string }, clientIp?: string): Promise<LoginResult> {
    return this.send<LoginResult>('POST', '/auth/login', {
      body: { email: credentials.email, password: credentials.password, client: 'mcp' },
      ...(clientIp ? { clientIp } : {}),
    });
  }

  /**
   * `POST /auth/oidc` with `client: 'mcp'` (only when the API has OIDC_ISSUER set): the API verifies the
   * ID token from the IdP itself, maps it to a Sermonize account and returns a new API token like
   * `login()`. `accessToken` (the IdP's) lets the API read the IdP's userinfo when the ID token has no email.
   */
  oidcLogin(tokens: { idToken: string; accessToken?: string | undefined }, clientIp?: string): Promise<LoginResult> {
    return this.send<LoginResult>('POST', '/auth/oidc', {
      body: { id_token: tokens.idToken, ...(tokens.accessToken ? { access_token: tokens.accessToken } : {}), client: 'mcp' },
      ...(clientIp ? { clientIp } : {}),
    });
  }

  /** `POST /auth/logout`: revokes this API token. */
  async logout(apiToken: string): Promise<void> {
    await this.send<null>('POST', '/auth/logout', { token: apiToken });
  }

  private get<T = JsonObject>(context: ConnectorContext, path: string, query?: Query): Promise<T> {
    return this.request<T>(context, 'GET', path, query ? { query } : {});
  }

  private post<T = JsonObject>(context: ConnectorContext, path: string, body: unknown): Promise<T> {
    return this.request<T>(context, 'POST', path, { body });
  }

  // --- identity -----------------------------------------------------------------------------
  me(c: ConnectorContext) { return this.get<Me>(c, '/me'); }

  // --- scholarly layer ----------------------------------------------------------------------
  listPersons(c: ConnectorContext, q: PersonQuery = {}) { return this.get<Page>(c, '/persons', { ...q }); }
  getPerson(c: ConnectorContext, id: string) { return this.get(c, `/persons/${seg(id)}`); }
  createPerson(c: ConnectorContext, body: JsonObject) { return this.post(c, '/persons', body); }

  listWorks(c: ConnectorContext, q: WorkQuery = {}) { return this.get<Page>(c, '/works', { ...q }); }
  getWork(c: ConnectorContext, id: string) { return this.get(c, `/works/${seg(id)}`); }
  createWork(c: ConnectorContext, body: JsonObject) { return this.post(c, '/works', body); }

  listSources(c: ConnectorContext, q: SourceQuery = {}) { return this.get<Page>(c, '/sources', { ...q }); }
  getSource(c: ConnectorContext, id: string) { return this.get(c, `/sources/${seg(id)}`); }
  createSource(c: ConnectorContext, body: JsonObject) { return this.post(c, '/sources', body); }

  listTexts(c: ConnectorContext, q: TextQuery = {}) { return this.get<Page>(c, '/texts', { ...q }); }
  getText(c: ConnectorContext, id: string) { return this.get(c, `/texts/${seg(id)}`); }
  getTextBody(c: ConnectorContext, id: string, range: { start?: number | undefined; end?: number | undefined } = {}) {
    return this.get<TextBody>(c, `/texts/${seg(id)}/body`, { ...range });
  }
  createText(c: ConnectorContext, body: JsonObject) { return this.post(c, '/texts', body); }

  // --- derived layer ------------------------------------------------------------------------
  getChunk(c: ConnectorContext, id: string, q: { include_embeddings?: boolean | undefined } = {}) {
    return this.get(c, `/chunks/${seg(id)}`, { ...q });
  }
  getChunkProvenance(c: ConnectorContext, id: string) { return this.get(c, `/chunks/${seg(id)}/provenance`); }

  listEmbeddingSpaces(c: ConnectorContext, q: EmbeddingSpaceQuery = {}) {
    return this.get<Page>(c, '/embedding-spaces', { ...q });
  }
  getEmbeddingSpace(c: ConnectorContext, id: string) { return this.get(c, `/embedding-spaces/${seg(id)}`); }
  search(c: ConnectorContext, body: SearchRequest) { return this.post(c, '/search', body); }

  listClusteringRuns(c: ConnectorContext, q: ClusteringRunQuery = {}) {
    return this.get<Page>(c, '/clustering-runs', { ...q });
  }
  getClusteringRun(c: ConnectorContext, id: string) { return this.get(c, `/clustering-runs/${seg(id)}`); }
  listRunClusters(c: ConnectorContext, runId: string, q: PageQuery = {}) {
    return this.get<Page>(c, `/clustering-runs/${seg(runId)}/clusters`, { ...q });
  }
  getCluster(c: ConnectorContext, id: string) { return this.get(c, `/clusters/${seg(id)}`); }
  listClusterMembers(c: ConnectorContext, id: string, q: PageQuery = {}) {
    return this.get<Page>(c, `/clusters/${seg(id)}/members`, { ...q });
  }
  listClusterLabels(c: ConnectorContext, id: string, q: LabelQuery = {}) {
    return this.get<Page>(c, `/clusters/${seg(id)}/labels`, { ...q });
  }
  getClusterProvenance(c: ConnectorContext, id: string) { return this.get(c, `/clusters/${seg(id)}/provenance`); }
  proposeLabel(c: ConnectorContext, clusterId: string, body: LabelProposal) {
    return this.post(c, `/clusters/${seg(clusterId)}/labels`, body);
  }
  reviewLabel(c: ConnectorContext, labelId: string, body: LabelReview) {
    return this.post(c, `/labels/${seg(labelId)}/reviews`, body);
  }
}

/** Guidance when the upstream API token no longer works (expired, revoked, or the account was disabled). */
export const SIGN_IN_AGAIN =
  'Your Sermonize sign-in has expired or was revoked (or your account was disabled). ' +
  'Please sign in again: reconnect or re-authorize this MCP server in your MCP client, using your Sermonize account.';

/** Human-readable tool error text for an API error: `<code> (HTTP <status>): <message>`, plus guidance and details. */
export function describeApiError(error: unknown): string {
  if (!(error instanceof SermonizeApiError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const lines = [
    `Sermonize API error ${error.code}` + (error.status ? ` (HTTP ${error.status})` : '') + `: ${error.message}`,
  ];
  if (error.status === 401) {
    lines.push(SIGN_IN_AGAIN);
  } else if (error.status === 403) {
    lines.push(
      'Your Sermonize account is not allowed to do this. Roles are reader < contributor < curator < admin; ' +
        'restricted text bodies and chunks, creating records and proposing labels need contributor, reviewing labels needs curator. ' +
        'Call whoami to see your role.',
    );
  }
  if (error.details !== undefined) {
    const details = JSON.stringify(error.details);
    lines.push(`details: ${details.length > 4000 ? details.slice(0, 4000) + '… (truncated)' : details}`);
  }
  return lines.join('\n');
}
