import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuthStore, AuthorizationCodeRecord, RefreshTokenRecord, McpUser, UserStore } from './interface.js';

export class SqliteAuthStore implements AuthStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, password_hash TEXT, created_at INTEGER NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS authorization_codes (code TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, subject TEXT NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS refresh_tokens (token TEXT PRIMARY KEY, client_id TEXT NOT NULL, subject TEXT NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL);'
    );
    try { this.db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT'); } catch { /* already exists */ }
  }

  getDatabase(): DatabaseSync {
    return this.db;
  }

  saveAuthorizationCode(record: AuthorizationCodeRecord): void {
    this.db.prepare('INSERT INTO authorization_codes (code, client_id, redirect_uri, challenge, subject, scope, expires) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(record.code, record.clientId, record.redirectUri, record.challenge, record.subject, record.scope, record.expires);
  }

  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | undefined {
    const row = this.db.prepare('SELECT code, client_id, redirect_uri, challenge, subject, scope, expires FROM authorization_codes WHERE code = ? AND expires >= ?')
      .get(code, Date.now()) as {code:string;client_id:string;redirect_uri:string;challenge:string;subject:string;scope:string;expires:number}|undefined;
    if (!row) {
      this.db.prepare('DELETE FROM authorization_codes WHERE code = ?').run(code);
      return undefined;
    }
    this.db.prepare('DELETE FROM authorization_codes WHERE code = ?').run(code);
    return { code: row.code, clientId: row.client_id, redirectUri: row.redirect_uri, challenge: row.challenge, subject: row.subject, scope: row.scope, expires: row.expires };
  }

  saveRefreshToken(record: RefreshTokenRecord): void {
    this.db.prepare('INSERT INTO refresh_tokens (token, client_id, subject, scope, expires) VALUES (?, ?, ?, ?, ?)')
      .run(record.token, record.clientId, record.subject, record.scope, record.expires);
  }

  getRefreshToken(token: string): RefreshTokenRecord | undefined {
    const row = this.db.prepare('SELECT token, client_id, subject, scope, expires FROM refresh_tokens WHERE token = ?')
      .get(token) as {token:string;client_id:string;subject:string;scope:string;expires:number}|undefined;
    if (!row || row.expires < Date.now()) {
      if (row) this.db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(token);
      return undefined;
    }
    return { token: row.token, clientId: row.client_id, subject: row.subject, scope: row.scope, expires: row.expires };
  }
}

export class SqliteUserStore implements UserStore {
  constructor(private readonly db: DatabaseSync) {}

  createUser(user: McpUser): void {
    this.db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, user.name, user.email ?? null, user.passwordHash ?? null, user.createdAt);
  }

  listUsers(): McpUser[] {
    const rows = this.db.prepare('SELECT id, name, email, password_hash, created_at FROM users ORDER BY name, id').all() as Array<{id:string;name:string;email:string|null;password_hash:string|null;created_at:number}>;
    return rows.map(row => ({ id: row.id, name: row.name, ...(row.email ? {email:row.email} : {}), ...(row.password_hash ? {passwordHash:row.password_hash} : {}), createdAt: row.created_at }));
  }

  getUser(id: string): McpUser | undefined {
    return this.map(this.db.prepare('SELECT id, name, email, password_hash, created_at FROM users WHERE id = ?').get(id) as {id:string;name:string;email:string|null;password_hash:string|null;created_at:number}|undefined);
  }

  getUserByEmail(email: string): McpUser | undefined {
    return this.map(this.db.prepare('SELECT id, name, email, password_hash, created_at FROM users WHERE lower(email) = lower(?)').get(email) as {id:string;name:string;email:string|null;password_hash:string|null;created_at:number}|undefined);
  }

  updateUser(id: string, patch: {name?:string;email?:string;passwordHash?:string}): McpUser | undefined {
    const current = this.getUser(id);
    if (!current) return undefined;
    this.db.prepare('UPDATE users SET name = ?, email = ?, password_hash = ? WHERE id = ?')
      .run(patch.name ?? current.name, patch.email ?? current.email ?? null, patch.passwordHash ?? current.passwordHash ?? null, id);
    return this.getUser(id);
  }

  deleteUser(id: string): boolean {
    return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  }

  private map(row: {id:string;name:string;email:string|null;password_hash:string|null;created_at:number}|undefined): McpUser|undefined {
    return row ? {id:row.id,name:row.name,...(row.email ? {email:row.email}:{}),...(row.password_hash ? {passwordHash:row.password_hash}:{}),createdAt:row.created_at} : undefined;
  }
}
