import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { decryptToken, encryptToken } from '../token-crypto.js';
import type { GrantRecord, GrantStore, NewGrant } from './interface.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type GrantRow = { id: string; subject: string; client_id: string; api_token_expires: number; expires: number };
const toRecord = (row: GrantRow): GrantRecord => ({
  id: row.id,
  subject: row.subject,
  clientId: row.client_id,
  apiTokenExpires: row.api_token_expires,
  expires: row.expires,
});
const COLUMNS = 'id, subject, client_id, api_token_expires, expires';

/**
 * OAuth grants with their upstream Sermonize API tokens, encrypted at rest (src/token-crypto.ts) with
 * the grant id as additional authenticated data. Plaintext tokens only exist in memory, for the
 * duration of one tool call or one logout request. The consent ticket is stored as a SHA-256 hash.
 * Deleting a grant cascades to its authorization codes and refresh tokens (foreign keys are on,
 * see openDatabase).
 */
export class SqliteGrantStore implements GrantStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly key: Buffer,
  ) {}

  createPendingGrant(grant: NewGrant): void {
    this.db
      .prepare(
        'INSERT INTO grants (id, subject, client_id, api_token, api_token_expires, ticket_sha256, request_sha256, expires, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        grant.id,
        grant.subject,
        grant.clientId,
        encryptToken(this.key, grant.id, grant.apiToken),
        grant.apiTokenExpires,
        sha256(grant.ticket),
        sha256(grant.requestFingerprint),
        grant.expires,
        Date.now(),
      );
  }

  activateGrant(ticket: string, requestFingerprint: string, expires: number): GrantRecord | undefined {
    const row = this.db
      .prepare(
        `UPDATE grants SET ticket_sha256 = NULL, request_sha256 = NULL, expires = ? ` +
          `WHERE ticket_sha256 = ? AND request_sha256 = ? AND expires >= ? RETURNING ${COLUMNS}`,
      )
      .get(expires, sha256(ticket), sha256(requestFingerprint), Date.now()) as GrantRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  getGrant(id: string): GrantRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM grants WHERE id = ? AND ticket_sha256 IS NULL AND expires >= ?`)
      .get(id, Date.now()) as GrantRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  setGrantExpiry(id: string, expires: number): void {
    this.db.prepare('UPDATE grants SET expires = ? WHERE id = ?').run(expires, id);
  }

  getApiToken(id: string, subject: string): string | undefined {
    const row = this.db
      .prepare('SELECT api_token FROM grants WHERE id = ? AND subject = ? AND ticket_sha256 IS NULL AND expires >= ? AND api_token_expires > ?')
      .get(id, subject, Date.now(), Date.now()) as { api_token: string } | undefined;
    return row ? decryptToken(this.key, id, row.api_token) : undefined;
  }

  deleteGrant(id: string): { apiToken?: string } | undefined {
    const row = this.db.prepare('DELETE FROM grants WHERE id = ? RETURNING id, api_token').get(id) as
      | { id: string; api_token: string }
      | undefined;
    if (!row) return undefined;
    const apiToken = this.tryDecrypt(row.id, row.api_token);
    return apiToken === undefined ? {} : { apiToken };
  }

  deleteEndedGrants(now: number): string[] {
    const rows = this.db.prepare('DELETE FROM grants WHERE expires < ? RETURNING id, api_token').all(now) as Array<{
      id: string;
      api_token: string;
    }>;
    return rows.map((r) => this.tryDecrypt(r.id, r.api_token)).filter((t): t is string => t !== undefined);
  }

  private tryDecrypt(id: string, stored: string): string | undefined {
    try {
      return decryptToken(this.key, id, stored);
    } catch {
      return undefined; // e.g. SERMONIZE_TOKEN_KEY was rotated; the API token then simply expires
    }
  }
}
