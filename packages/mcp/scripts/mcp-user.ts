import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { SqliteUserStore } from '../src/storage/sqlite.js';
import { SqliteApiTokenStore } from '../src/storage/api-tokens.js';
import { parseTokenKey } from '../src/token-crypto.js';
import type { McpUser } from '../src/storage/interface.js';

const dbPath = process.env.STORAGE_PATH ?? './data/app.sqlite';
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, password_hash TEXT, created_at INTEGER NOT NULL);');
try { db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT'); } catch { /* already exists */ }
SqliteApiTokenStore.migrate(db);
const users = new SqliteUserStore(db);

const [command, ...args] = process.argv.slice(2);
const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const has = (flag: string) => args.includes(flag);
const hashPassword = (password: string) => hash(password, { algorithm: 2 });

// The token store needs SERMONIZE_TOKEN_KEY only when a token is written.
const tokenStore = () => new SqliteApiTokenStore(db, parseTokenKey(process.env.SERMONIZE_TOKEN_KEY));
const hasToken = (id: string) => db.prepare('SELECT 1 FROM sermonize_api_tokens WHERE user_id = ?').get(id) !== undefined;

/** The Sermonize API token from --api-token <token> or --api-token-stdin (keeps it out of shell history), else undefined. */
function apiTokenArg(): string | undefined {
  if (has('--api-token-stdin')) {
    const token = readFileSync(0, 'utf8').trim();
    if (!token) throw new Error('--api-token-stdin: no token on standard input');
    return token;
  }
  if (has('--api-token')) {
    const token = value('--api-token');
    if (!token || token.startsWith('--')) throw new Error('--api-token requires a value');
    return token;
  }
  return undefined;
}

/** Never prints password hashes or API tokens; only whether a token is linked. */
function safe(user: McpUser) {
  const { passwordHash: _, ...rest } = user;
  return { ...rest, has_api_token: hasToken(user.id) };
}

switch (command) {
  case 'create': {
    const name = value('--name');
    const password = value('--password');
    if (!name || !password) throw new Error('create requires --name and --password');
    const apiToken = apiTokenArg();
    const store = apiToken ? tokenStore() : undefined; // fail on a missing key before creating the user
    const id = value('--id') ?? randomUUID();
    const email = value('--email');
    users.createUser({ id, name, ...(email ? {email} : {}), passwordHash: await hashPassword(password), createdAt: Date.now() });
    if (store && apiToken) store.set(id, apiToken);
    console.log(JSON.stringify(safe(users.getUser(id)!), null, 2));
    break;
  }
  case 'list': {
    console.log(JSON.stringify(users.listUsers().map(safe), null, 2));
    break;
  }
  case 'get': {
    const id = args[0];
    if (!id) throw new Error('get requires <id>');
    const user = users.getUser(id);
    console.log(user ? JSON.stringify(safe(user), null, 2) : 'null');
    break;
  }
  case 'update': {
    const id = args[0];
    if (!id) throw new Error('update requires <id>');
    const password = value('--password');
    const apiToken = apiTokenArg();
    const store = apiToken ? tokenStore() : undefined;
    const name = value('--name');
    const email = value('--email');
    const user = users.updateUser(id, {
      ...(name ? {name} : {}),
      ...(email ? {email} : {}),
      ...(password ? {passwordHash:await hashPassword(password)} : {}),
    });
    if (!user) throw new Error('User not found: ' + id);
    if (store && apiToken) store.set(id, apiToken);
    if (has('--clear-api-token')) db.prepare('DELETE FROM sermonize_api_tokens WHERE user_id = ?').run(id);
    console.log(JSON.stringify(safe(user), null, 2));
    break;
  }
  case 'delete': {
    const id = args[0];
    if (!id) throw new Error('delete requires <id>');
    if (!users.deleteUser(id)) throw new Error('User not found: ' + id);
    db.prepare('DELETE FROM sermonize_api_tokens WHERE user_id = ?').run(id);
    console.log('Deleted ' + id);
    break;
  }
  default:
    console.log('Usage: npm run user -- <create|list|get|update|delete> ...');
    console.log('  create --name "Name" --email "user@example.com" --password "secret" [--id <id>] [--api-token <token> | --api-token-stdin]');
    console.log('  update <id> [--name "New name"] [--email "new@example.com"] [--password "new-secret"]');
    console.log('              [--api-token <token> | --api-token-stdin | --clear-api-token]');
    console.log('  list | get <id> | delete <id>');
    console.log('The Sermonize API token is encrypted with SERMONIZE_TOKEN_KEY and never printed.');
    process.exitCode = 1;
}
