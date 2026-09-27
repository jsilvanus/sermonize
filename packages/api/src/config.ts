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
  /** Per-IP limit on POST /auth/register and /auth/login; null disables it. */
  rateLimit: { max: number; timeWindowMs: number } | null;
}

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  logLevel: string;
  maxBatchItems: number;
  /** Fastify `trustProxy` (TRUST_PROXY): false, true, or comma-separated trusted proxy addresses/CIDRs. */
  trustProxy: boolean | string;
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

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const max = intFromEnv(env, 'AUTH_RATE_LIMIT_MAX', 10, 0);
  return {
    registrationOpen: boolFromEnv(env, 'REGISTRATION_OPEN', false),
    registrationDefaultRole: parseRegistrationRole(env.REGISTRATION_DEFAULT_ROLE),
    loginTokenTtlHours: intFromEnv(env, 'LOGIN_TOKEN_TTL_HOURS', 12),
    mcpLoginTokenTtlHours: intFromEnv(env, 'MCP_LOGIN_TOKEN_TTL_HOURS', 720),
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
    auth: loadAuthConfig(env),
  };
}
