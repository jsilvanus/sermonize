import type { PoolClient } from 'pg';
import type { Role, UserKind } from './principal.js';
import { generateToken, hashToken } from './tokens.js';

/** Public view of an app_user. Never includes PII (that lives in the private schema). */
export interface AppUser {
  id: string;
  kind: UserKind;
  role: Role;
  status: 'active' | 'disabled';
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

interface AppUserRow extends Omit<AppUser, 'created_at' | 'updated_at'> {
  created_at: Date;
  updated_at: Date;
}

const USER_COLUMNS = 'id, kind, role, status, created_by, created_at, updated_by, updated_at';

function toAppUser(row: AppUserRow): AppUser {
  return { ...row, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
}

export interface CreateUserInput {
  kind: UserKind;
  role: Role;
  status?: 'active' | 'disabled';
  email?: string | null;
  displayName?: string | null;
}

/**
 * Creates a user; PII (if any) is written to private.user_pii via a SECURITY
 * DEFINER function. Must run inside withTransaction() as an admin principal.
 */
export async function createUser(client: PoolClient, input: CreateUserInput): Promise<AppUser> {
  const { rows } = await client.query<AppUserRow>(
    `INSERT INTO app_user (kind, role, status) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
    [input.kind, input.role, input.status ?? 'active'],
  );
  const user = toAppUser(rows[0]!);
  if (input.email != null || input.displayName != null) {
    await client.query('SELECT private.set_user_pii($1, $2, $3)', [
      user.id,
      input.email ?? null,
      input.displayName ?? null,
    ]);
  }
  return user;
}

export async function getUser(client: PoolClient, id: string): Promise<AppUser | null> {
  const { rows } = await client.query<AppUserRow>(`SELECT ${USER_COLUMNS} FROM app_user WHERE id = $1`, [id]);
  return rows[0] ? toAppUser(rows[0]) : null;
}

export interface IssuedToken {
  id: string;
  user_id: string;
  name: string;
  expires_at: string | null;
  /** Plaintext token. Returned once; only its SHA-256 is stored. */
  token: string;
}

/** Issues an API token for a user. Must run inside withTransaction() as an admin principal. */
export async function issueToken(
  client: PoolClient,
  input: { userId: string; name: string; expiresAt?: string | null },
): Promise<IssuedToken> {
  const token = generateToken();
  const { rows } = await client.query<{ id: string }>(
    'SELECT private.create_api_token($1, $2, $3, $4) AS id',
    [input.userId, input.name, hashToken(token), input.expiresAt ?? null],
  );
  return {
    id: rows[0]!.id,
    user_id: input.userId,
    name: input.name,
    expires_at: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
    token,
  };
}

/** Revokes a token (idempotent). Returns false if the token does not exist. */
export async function revokeToken(client: PoolClient, tokenId: string): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>('SELECT private.revoke_api_token($1) AS ok', [tokenId]);
  return rows[0]!.ok;
}

/**
 * Stores an argon2id hash (hashed in Node) as the user's password via
 * private.admin_set_password (human users with an email only; SZ004 otherwise).
 * Optionally revokes all of the user's tokens; returns how many were revoked.
 * Must run inside withTransaction() as an admin principal.
 */
export async function setUserPassword(
  client: PoolClient,
  input: { userId: string; passwordHash: string; revokeTokens?: boolean },
): Promise<number> {
  const { rows } = await client.query<{ revoked: number }>(
    'SELECT private.admin_set_password($1, $2, $3) AS revoked',
    [input.userId, input.passwordHash, input.revokeTokens ?? false],
  );
  return rows[0]!.revoked;
}

/** Admin view of a user, including PII (admins manage accounts). Never includes password hashes. */
export interface AdminUser {
  id: string;
  kind: UserKind;
  role: Role;
  status: 'active' | 'disabled';
  email: string | null;
  display_name: string | null;
  has_password: boolean;
  created_at: string;
  updated_at: string;
}

export interface AdminUserFilters {
  id?: string;
  role?: Role;
  status?: 'active' | 'disabled';
  kind?: UserKind;
  /** ILIKE pattern (already escaped). */
  qPattern?: string;
  after?: { createdAt: string; id: string };
  limit: number;
}

/**
 * Lists users with PII through private.admin_list_users (which audits the read).
 * Ordered by (created_at, id); `sortKey` is the keyset cursor key of each row.
 */
export async function listAdminUsers(
  client: PoolClient,
  f: AdminUserFilters,
): Promise<Array<AdminUser & { sortKey: string }>> {
  const { rows } = await client.query<
    Omit<AdminUser, 'created_at' | 'updated_at'> & { created_at: Date; updated_at: Date; sort_created_at: string }
  >('SELECT * FROM private.admin_list_users($1, $2, $3, $4, $5, $6, $7, $8)', [
    f.id ?? null,
    f.role ?? null,
    f.status ?? null,
    f.kind ?? null,
    f.qPattern ?? null,
    f.after?.createdAt ?? null,
    f.after?.id ?? null,
    f.limit,
  ]);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    role: r.role,
    status: r.status,
    email: r.email,
    display_name: r.display_name,
    has_password: r.has_password,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    sortKey: `${r.sort_created_at}|${r.id}`,
  }));
}

export interface TokenInfo {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  /** active | expired | revoked (derived). */
  state: 'active' | 'expired' | 'revoked';
}

/** Token metadata of a user (never the hash). Must run as an admin principal. */
export async function listUserTokens(client: PoolClient, userId: string): Promise<TokenInfo[]> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    created_by: string;
    created_at: Date;
    expires_at: Date | null;
    revoked_at: Date | null;
  }>('SELECT * FROM private.admin_list_tokens($1)', [userId]);
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    created_by: r.created_by,
    created_at: r.created_at.toISOString(),
    expires_at: r.expires_at?.toISOString() ?? null,
    revoked_at: r.revoked_at?.toISOString() ?? null,
    state: r.revoked_at ? 'revoked' : r.expires_at && r.expires_at.getTime() <= now ? 'expired' : 'active',
  }));
}

/** Partial PII update (only the given fields; null clears). Must run as an admin principal. */
export async function updateUserPii(
  client: PoolClient,
  userId: string,
  pii: { email?: string | null; displayName?: string | null },
): Promise<void> {
  await client.query('SELECT private.admin_update_user_pii($1, $2, $3, $4, $5)', [
    userId,
    pii.email !== undefined,
    pii.email ?? null,
    pii.displayName !== undefined,
    pii.displayName ?? null,
  ]);
}
