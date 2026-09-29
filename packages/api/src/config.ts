import type { Role } from './lib/principal.js';

/** Roles a self-registered user may get (REGISTRATION_DEFAULT_ROLE). */
export const SELF_REGISTRATION_ROLES = ['reader', 'contributor'] as const satisfies readonly Role[];
export type SelfRegistrationRole = (typeof SELF_REGISTRATION_ROLES)[number];

/** Password registration/login settings (see routes/auth.ts). */
export interface AuthConfig {
  /** POST /auth/register is enabled (REGISTRATION_OPEN=true). */
  registrationOpen: boolean;
  /** Role of self-registered users: reader (default) or contributor. */
  registrationDefaultRole: SelfRegistrationRole;
  /** Lifetime of tokens issued by POST /auth/login for the web UI (`client: 'web'`, the default), in hours. */
  loginTokenTtlHours: number;
  /** Lifetime of tokens issued by POST /auth/login for the MCP server (`client: 'mcp'`), in hours. */
  mcpLoginTokenTtlHours: number;
  /** Lifetime of tokens issued by POST /auth/login for `sermonize-admin login` (`client: 'cli'`), in hours. */
  cliLoginTokenTtlHours: number;
  /** Per-IP limit on POST /auth/register, /auth/login and /auth/oidc; null disables it. */
  rateLimit: { max: number; timeWindowMs: number } | null;
  /** OIDC sign-in (POST /auth/oidc); null (OIDC_ISSUER unset) = the route does not exist. */
  oidc: OidcConfig | null;
}

/** OIDC sign-in settings (see src/lib/oidc.ts and POST /auth/oidc). */
export interface OidcConfig {
  /** OIDC_ISSUER, exactly as the IdP publishes it (the ID token's `iss` must equal it). */
  issuer: string;
  /** OIDC_CLIENT_IDS: the ID token's `aud` must contain one of them (the clients that sign users in, e.g. the MCP server). */
  clientIds: string[];
  /** OIDC_CREATE_USERS: create an account (REGISTRATION_DEFAULT_ROLE) for an identity that matches none. */
  createUsers: boolean;
  /** OIDC_TRUST_EMAIL: link by email even when `email_verified` is not true. */
  trustEmail: boolean;
}

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  logLevel: string;
  maxBatchItems: number;
  /** Fastify `trustProxy` (TRUST_PROXY): false, true, or comma-separated trusted proxy addresses/CIDRs. */
  trustProxy: boolean | string;
  /**
   * Path prefix under which a reverse proxy publishes the API (PUBLIC_BASE_PATH, e.g. `/api` when nginx
   * forwards `/api/*` to the API's root routes), without a trailing slash; '' when served at the root.
   * Only changes the OpenAPI document's `servers` and the Swagger UI asset URLs, never the routes.
   */
  publicBasePath: string;
  auth: AuthConfig;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false", got "${raw}"`);
}

export function parseRegistrationRole(raw: string | undefined): SelfRegistrationRole {
  if (raw === undefined || raw === '') return 'reader';
  if ((SELF_REGISTRATION_ROLES as readonly string[]).includes(raw)) return raw as SelfRegistrationRole;
  throw new Error(`REGISTRATION_DEFAULT_ROLE must be one of ${SELF_REGISTRATION_ROLES.join(', ')}, got "${raw}"`);
}

function trustProxyFromEnv(raw: string | undefined): boolean | string {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  return raw;
}

/**
 * PUBLIC_BASE_PATH: unset, '' or '/' -> '' (served at the root); otherwise an absolute path of
 * unreserved characters (`/api`, `/sermonize/api`), returned without a trailing slash.
 */
export function parsePublicBasePath(raw: string | undefined): string {
  if (raw === undefined || raw === '' || raw === '/') return '';
  if (!/^(\/[A-Za-z0-9._~-]+)+\/?$/.test(raw) || /(^|\/)\.{1,2}(\/|$)/.test(raw)) {
    throw new Error(`PUBLIC_BASE_PATH must be an absolute path such as /api (letters, digits, . _ ~ -), got "${raw}"`);
  }
  return raw.replace(/\/+$/, '');
}

/**
 * OIDC_ISSUER must be an absolute http(s) URL without query, fragment or credentials; `https:` is
 * required when `production` (NODE_ENV=production). Returned unchanged (a trailing slash is significant).
 */
export function parseOidcIssuer(raw: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`OIDC_ISSUER must be an absolute URL, got "${raw}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`OIDC_ISSUER must be an http(s) URL, got "${raw}"`);
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(`OIDC_ISSUER must not contain a query, fragment or credentials, got "${raw}"`);
  }
  if (production && url.protocol !== 'https:') throw new Error('OIDC_ISSUER must be an https URL in production');
  return raw;
}

/** OIDC settings from the environment; null when OIDC_ISSUER is unset or empty (OIDC off). */
export function loadOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const createUsers = boolFromEnv(env, 'OIDC_CREATE_USERS', false);
  const trustEmail = boolFromEnv(env, 'OIDC_TRUST_EMAIL', false);
  const raw = env.OIDC_ISSUER?.trim();
  if (!raw) return null;
  const issuer = parseOidcIssuer(raw, env.NODE_ENV === 'production');
  const clientIds = (env.OIDC_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (clientIds.length === 0) throw new Error('OIDC_CLIENT_IDS is required when OIDC_ISSUER is set');
  return { issuer, clientIds, createUsers, trustEmail };
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const max = intFromEnv(env, 'AUTH_RATE_LIMIT_MAX', 10, 0);
  return {
    oidc: loadOidcConfig(env),
    registrationOpen: boolFromEnv(env, 'REGISTRATION_OPEN', false),
    registrationDefaultRole: parseRegistrationRole(env.REGISTRATION_DEFAULT_ROLE),
    loginTokenTtlHours: intFromEnv(env, 'LOGIN_TOKEN_TTL_HOURS', 12),
    mcpLoginTokenTtlHours: intFromEnv(env, 'MCP_LOGIN_TOKEN_TTL_HOURS', 720),
    cliLoginTokenTtlHours: intFromEnv(env, 'CLI_LOGIN_TOKEN_TTL_HOURS', 12),
    rateLimit:
      max === 0 ? null : { max, timeWindowMs: intFromEnv(env, 'AUTH_RATE_LIMIT_WINDOW_SECONDS', 60) * 1000 },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    databaseUrl,
    port: intFromEnv(env, 'PORT', 3000),
    host: env.HOST || '127.0.0.1',
    logLevel: env.LOG_LEVEL || 'info',
    maxBatchItems: intFromEnv(env, 'MAX_BATCH_ITEMS', 5000),
    trustProxy: trustProxyFromEnv(env.TRUST_PROXY),
    publicBasePath: parsePublicBasePath(env.PUBLIC_BASE_PATH),
    auth: loadAuthConfig(env),
  };
}
