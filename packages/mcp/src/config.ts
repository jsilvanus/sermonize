import { parseTokenKey } from './token-crypto.js';

export interface McpConfig {
  port: number;
  host: string;
  /** Public origin of this MCP server (OAuth issuer; the MCP resource is `<publicUrl>/mcp`). */
  publicUrl: string;
  jwtSecret: Uint8Array;
  storagePath: string;
  defaultUser: { id: string; email: string; password: string };
  /** Base URL of the Sermonize REST API, without a trailing slash. */
  sermonizeApiUrl: string;
  /** AES-256-GCM key for the per-user Sermonize API tokens stored in SQLite. */
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
    publicUrl: (env.MCP_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    jwtSecret: secret,
    storagePath: env.STORAGE_PATH || './data/app.sqlite',
    defaultUser: {
      id: env.MCP_DEFAULT_USER_ID || 'demo-user',
      email: env.MCP_DEFAULT_USER_EMAIL || 'demo@example.com',
      password: required(env, 'MCP_DEFAULT_USER_PASSWORD'),
    },
    sermonizeApiUrl: apiUrl.toString().replace(/\/+$/, ''),
    tokenKey: parseTokenKey(env.SERMONIZE_TOKEN_KEY),
    requestTimeoutMs: positiveInt(env, 'SERMONIZE_REQUEST_TIMEOUT_MS', 15_000),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
