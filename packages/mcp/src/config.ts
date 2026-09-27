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
}

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
  };
}
