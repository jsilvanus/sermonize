export interface WebConfig {
  port: number;
  host: string;
  /** Base URL of the Sermonize REST API, without a trailing slash. */
  sermonizeApiUrl: string;
  /** Secret used to sign the session and CSRF cookies (WEB_COOKIE_SECRET, at least 32 characters). */
  cookieSecret: string;
  /** Mark cookies `Secure` (HTTPS only). Default: true when NODE_ENV=production. */
  cookieSecure: boolean;
  /** Timeout of one API request, in milliseconds. */
  requestTimeoutMs: number;
  /**
   * Fastify `trustProxy` (TRUST_PROXY): false, true, or comma-separated trusted proxy addresses/CIDRs.
   * Decides `request.ip`, which is forwarded to the API as X-Forwarded-For on register/login.
   */
  trustProxy: boolean | string;
  logLevel: string;
}

/** Same semantics as the API's TRUST_PROXY: unset/"false" -> false, "true" -> true, else an address list. */
export function parseTrustProxy(raw: string | undefined): boolean | string {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  return raw;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false", got "${raw}"`);
}

export function parseApiUrl(raw: string | undefined): string {
  if (!raw) throw new Error('SERMONIZE_API_URL is required');
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('SERMONIZE_API_URL must be an http(s) URL');
  return url.toString().replace(/\/+$/, '');
}

export function parseCookieSecret(raw: string | undefined): string {
  if (!raw || raw.length < 32) {
    throw new Error('WEB_COOKIE_SECRET is required and must be at least 32 characters (openssl rand -base64 32)');
  }
  return raw;
}

/** Reads the configuration from the environment (the process reads no .env file itself). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  return {
    port: positiveInt(env, 'PORT', 3100),
    host: env.HOST || '127.0.0.1',
    sermonizeApiUrl: parseApiUrl(env.SERMONIZE_API_URL),
    cookieSecret: parseCookieSecret(env.WEB_COOKIE_SECRET),
    cookieSecure: bool(env, 'WEB_COOKIE_SECURE', env.NODE_ENV === 'production'),
    requestTimeoutMs: positiveInt(env, 'SERMONIZE_REQUEST_TIMEOUT_MS', 10_000),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
