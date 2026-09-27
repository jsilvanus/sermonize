import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuthStore, AuthorizationCodeRecord, RefreshTokenRecord } from './interface.js';

/**
 * Schema version kept in `PRAGMA user_version`.
 *
 * 0/1: the scaffold's schema plus MCP's own users (`users` with argon2 password hashes) and per-user
 *      linked API tokens (`sermonize_api_tokens`).
 * 2:   sign-in through the Sermonize API; one encrypted upstream token per OAuth grant (`grants`),
 *      codes and refresh tokens reference their grant.
 *
 * Upgrading from 0/1 DROPS the old tables: the old OAuth subjects were MCP user ids, not Sermonize
 * user ids, and the old tokens were linked by hand, so nothing can be carried over. Every MCP client
 * simply signs in again with its Sermonize (web) account. Nothing else lives in this file.
 */
export const SCHEMA_VERSION = 2;

export function migrateSchema(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version === SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) {
    throw new Error(`STORAGE_PATH has schema version ${version}, newer than this server (${SCHEMA_VERSION})`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(
      'DROP TABLE IF EXISTS authorization_codes; DROP TABLE IF EXISTS refresh_tokens;' +
        'DROP TABLE IF EXISTS sermonize_api_tokens; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS grants;' +
        'CREATE TABLE grants (id TEXT PRIMARY KEY, subject TEXT NOT NULL, client_id TEXT NOT NULL,' +
        ' api_token TEXT NOT NULL, api_token_expires INTEGER NOT NULL,' +
        ' ticket_sha256 TEXT UNIQUE, request_sha256 TEXT, expires INTEGER NOT NULL, created_at INTEGER NOT NULL);' +
        'CREATE INDEX grants_expires ON grants (expires);' +
        'CREATE TABLE authorization_codes (code TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants (id) ON DELETE CASCADE,' +
        ' client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, subject TEXT NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL);' +
        'CREATE INDEX authorization_codes_grant ON authorization_codes (grant_id);' +
        'CREATE TABLE refresh_tokens (token TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants (id) ON DELETE CASCADE,' +
        ' client_id TEXT NOT NULL, subject TEXT NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL);' +
        'CREATE INDEX refresh_tokens_grant ON refresh_tokens (grant_id);' +
        `PRAGMA user_version = ${SCHEMA_VERSION};`,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Opens (creating if needed) the SQLite file and brings its schema up to date. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrateSchema(db);
  return db;
}

type CodeRow = { code: string; grant_id: string; client_id: string; redirect_uri: string; challenge: string; subject: string; scope: string; expires: number };
type RefreshRow = { token: string; grant_id: string; client_id: string; subject: string; scope: string; expires: number };

export class SqliteAuthStore implements AuthStore {
  constructor(private readonly db: DatabaseSync) {}

  getDatabase(): DatabaseSync {
    return this.db;
  }

  saveAuthorizationCode(record: AuthorizationCodeRecord): void {
    this.db.prepare('INSERT INTO authorization_codes (code, grant_id, client_id, redirect_uri, challenge, subject, scope, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.code, record.grantId, record.clientId, record.redirectUri, record.challenge, record.subject, record.scope, record.expires);
  }

  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | undefined {
    const row = this.db.prepare('SELECT code, grant_id, client_id, redirect_uri, challenge, subject, scope, expires FROM authorization_codes WHERE code = ? AND expires >= ?')
      .get(code, Date.now()) as CodeRow | undefined;
    this.db.prepare('DELETE FROM authorization_codes WHERE code = ?').run(code);
    if (!row) return undefined;
    return { code: row.code, grantId: row.grant_id, clientId: row.client_id, redirectUri: row.redirect_uri, challenge: row.challenge, subject: row.subject, scope: row.scope, expires: row.expires };
  }

  saveRefreshToken(record: RefreshTokenRecord): void {
    this.db.prepare('INSERT INTO refresh_tokens (token, grant_id, client_id, subject, scope, expires) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.token, record.grantId, record.clientId, record.subject, record.scope, record.expires);
  }

  getRefreshToken(token: string): RefreshTokenRecord | undefined {
    const row = this.db.prepare('SELECT token, grant_id, client_id, subject, scope, expires FROM refresh_tokens WHERE token = ?')
      .get(token) as RefreshRow | undefined;
    if (!row || row.expires < Date.now()) {
      if (row) this.db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(token);
      return undefined;
    }
    return { token: row.token, grantId: row.grant_id, clientId: row.client_id, subject: row.subject, scope: row.scope, expires: row.expires };
  }
}
