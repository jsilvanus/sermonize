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
