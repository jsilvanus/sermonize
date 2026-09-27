import type { DatabaseSync } from 'node:sqlite';
import { decryptToken, encryptToken } from '../token-crypto.js';

/**
 * Per-MCP-user Sermonize API tokens, encrypted at rest (see src/token-crypto.ts).
 * Kept in its own table next to the scaffold's `users` table so the scaffold's user store stays unchanged.
 * Plaintext tokens only exist in memory, for the duration of one tool call.
 */
export class SqliteApiTokenStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly key: Buffer,
  ) {
    SqliteApiTokenStore.migrate(db);
  }

  static migrate(db: DatabaseSync): void {
    db.exec(
      'CREATE TABLE IF NOT EXISTS sermonize_api_tokens (user_id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL);',
    );
  }

  set(userId: string, token: string): void {
    this.db
      .prepare(
        'INSERT INTO sermonize_api_tokens (user_id, ciphertext, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT (user_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at',
      )
      .run(userId, encryptToken(this.key, userId, token), Date.now());
  }

  /** The decrypted token, or undefined if the user has none. Throws if the stored value fails authentication. */
  get(userId: string): string | undefined {
    const row = this.db.prepare('SELECT ciphertext FROM sermonize_api_tokens WHERE user_id = ?').get(userId) as
      | { ciphertext: string }
      | undefined;
    return row ? decryptToken(this.key, userId, row.ciphertext) : undefined;
  }

  has(userId: string): boolean {
    return this.db.prepare('SELECT 1 FROM sermonize_api_tokens WHERE user_id = ?').get(userId) !== undefined;
  }

  delete(userId: string): boolean {
    return this.db.prepare('DELETE FROM sermonize_api_tokens WHERE user_id = ?').run(userId).changes > 0;
  }
}

/** What the MCP layer needs: the Sermonize API token of an authenticated MCP user. */
export interface ApiTokenResolver {
  get(userId: string): string | undefined;
}
