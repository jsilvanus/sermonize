import { parseTokenKey } from './token-crypto.js';

export interface McpConfig {
  port: number;
  host: string;
  /** Public origin of this MCP server (OAuth issuer; the MCP resource is `<publicUrl>/mcp`). */
  publicUrl: string;
  jwtSecret: Uint8Array;
  /** SQLite file: OAuth grants (with the encrypted upstream API tokens), authorization codes, refresh tokens. */
  storagePath: string;
  /**
   * Fastify `trustProxy` (TRUST_PROXY): false, true, or comma-separated trusted proxy addresses/CIDRs.
   * Decides `request.ip`, which is forwarded to the API as X-Forwarded-For at sign-in (rate limiting).
   */
  trustProxy: boolean | string;
  /** Base URL of the Sermonize REST API, without a trailing slash. */
  sermonizeApiUrl: string;
  /** AES-256-GCM key for the per-grant Sermonize API tokens stored in SQLite. */
  tokenKey: Buffer;
  /** Timeout of one upstream API request, in milliseconds. */
  requestTimeoutMs: number;
  logLevel: string;
  /** OIDC single sign-on on the sign-in page; null when OIDC_ISSUER is unset or empty (no button, no /oidc/* routes). */
  oidc: OidcConfig | null;
}

/** OIDC Relying Party settings (src/oauth/oidc.ts). */
export interface OidcConfig {
  /** OIDC_ISSUER, exactly as the IdP publishes it (authentik keeps a trailing slash). */
  issuer: string;
  clientId: string;
  /** Set = confidential client (client_secret_basic); undefined = public client. PKCE is always used. */
  clientSecret?: string | undefined;
  /** OIDC_SCOPES (always contains `openid`). */
  scopes: string;
  /** Text of the sign-in button. */
  buttonLabel: string;
  /** NODE_ENV=production: https issuer required, and plain-http IdP requests are never allowed. */
  production: boolean;
}

export const DEFAULT_OIDC_SCOPES = 'openid email profile';
export const DEFAULT_OIDC_BUTTON_LABEL = 'Sign in with single sign-on';

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

/** Same semantics as the API's TRUST_PROXY: unset/"false" -> false, "true" -> true, else an address list. */
export function parseTrustProxy(raw: string | undefined): boolean | string {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  return raw;
}

/**
 * MCP_PUBLIC_URL: the public http(s) origin (no path, query or fragment). It is the OAuth issuer and
 * the MCP resource is `<origin>/mcp`. The server's routes (/mcp, /oauth/*, /.well-known/*) live at the
 * root of that origin, which may be shared with other services behind a reverse proxy.
 */
export function parsePublicUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MCP_PUBLIC_URL must be an absolute http(s) URL, got "${raw}"`);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.pathname !== '/' || url.search || url.hash || url.username || url.password
  ) {
    throw new Error(`MCP_PUBLIC_URL must be an http(s) origin without path, query, fragment or credentials, got "${raw}"`);
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * OIDC_* settings; null when OIDC_ISSUER is unset or empty. OIDC_CLIENT_ID is then required, OIDC_SCOPES
 * must contain `openid`, and the issuer must be an absolute URL (https in production, NODE_ENV=production).
 */
export function loadOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = env.OIDC_ISSUER?.trim();
  if (!issuer) return null;
  const production = env.NODE_ENV === 'production';
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`OIDC_ISSUER must be an absolute URL, got "${issuer}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`OIDC_ISSUER must be an http(s) URL, got "${issuer}"`);
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(`OIDC_ISSUER must not contain a query, fragment or credentials, got "${issuer}"`);
  }
  if (production && url.protocol !== 'https:') throw new Error('OIDC_ISSUER must be an https URL in production');
  const clientId = env.OIDC_CLIENT_ID?.trim();
  if (!clientId) throw new Error('OIDC_CLIENT_ID is required when OIDC_ISSUER is set');
  const scopes = (env.OIDC_SCOPES?.trim() || DEFAULT_OIDC_SCOPES).split(/\s+/).join(' ');
  if (!scopes.split(' ').includes('openid')) throw new Error(`OIDC_SCOPES must contain "openid", got "${scopes}"`);
  return {
    issuer,
    clientId,
    clientSecret: env.OIDC_CLIENT_SECRET || undefined,
    scopes,
    buttonLabel: env.OIDC_BUTTON_LABEL?.trim() || DEFAULT_OIDC_BUTTON_LABEL,
    production,
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Reads the server configuration from the environment (the process reads no .env file itself). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const port = positiveInt(env, 'PORT', 5999);
  const secret = Buffer.from(required(env, 'JWT_SECRET'), 'base64');
  if (secret.length < 32) throw new Error('JWT_SECRET must decode to at least 32 bytes');

  const apiUrl = new URL(required(env, 'SERMONIZE_API_URL'));
  if (apiUrl.protocol !== 'http:' && apiUrl.protocol !== 'https:') {
    throw new Error('SERMONIZE_API_URL must be an http(s) URL');
  }

  return {
    port,
    host: env.HOST || '127.0.0.1',
    publicUrl: parsePublicUrl(env.MCP_PUBLIC_URL || `http://localhost:${port}`),
    jwtSecret: secret,
    storagePath: env.STORAGE_PATH || './data/app.sqlite',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sermonizeApiUrl: apiUrl.toString().replace(/\/+$/, ''),
    tokenKey: parseTokenKey(env.SERMONIZE_TOKEN_KEY),
    requestTimeoutMs: positiveInt(env, 'SERMONIZE_REQUEST_TIMEOUT_MS', 15_000),
    logLevel: env.LOG_LEVEL || 'info',
    oidc: loadOidcConfig(env),
  };
}
