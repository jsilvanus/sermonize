/**
 * sermonize-admin against the real API (from source) on an ephemeral port, with a
 * temporary XDG_CONFIG_HOME per test. The CLI only ever talks HTTP.
 */
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_PRINCIPAL } from '@sermonize/api/lib/principal';
import { credentialsPath } from '../src/credentials.js';
import { asSystem, cli, passwordUser, startApi, tempConfigHome, tokenFor, uniqueEmail, type RunningApi } from './helpers.js';

const ADMIN_PASSWORD = 'admin password for the cli tests';
const NEW_PASSWORD = 'a brand new password 123';

describe('sermonize-admin', () => {
  let api: RunningApi;
  let admin: { id: string; email: string };
  let config: { dir: string; cleanup(): Promise<void> };
  let env: Record<string, string | undefined>;

  beforeAll(async () => {
    api = await startApi();
    admin = await passwordUser(api.pool, 'admin', ADMIN_PASSWORD);
  });
  afterAll(() => api.close());
  beforeEach(async () => {
    config = await tempConfigHome();
    env = { SERMONIZE_API_URL: api.url, XDG_CONFIG_HOME: config.dir, HOME: config.dir };
  });
  afterEach(() => config.cleanup());

  const login = () => cli(['login', '--email', admin.email], { env, input: [ADMIN_PASSWORD] });

  it('--help and usage errors', async () => {
    const help = await cli(['--help'], { env });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('users set-role <user-id> <role>');
    expect((await cli([], { env })).code).toBe(1);
    const unknown = await cli(['users', 'frobnicate'], { env });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('unknown command: users frobnicate');
    const badOpt = await cli(['users', 'list', '--colour'], { env });
    expect(badOpt.code).toBe(1);
    const missing = await cli(['users', 'get'], { env });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('<user-id>');
    for (const argv of [['login', '--email', 'x@example.org', '--password', 'secret123456'], ['users', 'create', '--password=secret123456']]) {
      const res = await cli(argv, { env });
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('never accepted as arguments');
    }
  });

  it('without credentials: exit 2 and a hint to log in', async () => {
    const res = await cli(['users', 'list'], { env });
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/not logged in to .*sermonize-admin login/);
    const bad = await cli(['whoami'], { env: { ...env, SERMONIZE_TOKEN: 'sz_invalid' } });
    expect(bad.code).toBe(2);
  });

  it('login stores a cli token in a 0600 file; whoami; logout revokes and deletes it', async () => {
    const res = await login();
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain(`Logged in to ${api.url} as ${admin.email} (admin)`);
    expect(res.stdout + res.stderr).not.toContain(ADMIN_PASSWORD);
    expect(res.stderr).toContain('Password: ');

    const path = credentialsPath(env);
    expect(path).toBe(join(config.dir, 'sermonize', 'credentials.json'));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(config.dir, 'sermonize'))).mode & 0o777).toBe(0o700);
    const creds = JSON.parse(await readFile(path, 'utf8'));
    expect(creds).toMatchObject({ api_url: api.url, user_id: admin.id, role: 'admin', email: admin.email });
    expect(JSON.stringify(creds)).not.toContain(ADMIN_PASSWORD);
    const { rows } = await api.pool.query(
      `SELECT name, expires_at FROM private.api_token WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [admin.id],
    );
    expect(rows[0].name).toBe('cli');
    expect(Math.abs(rows[0].expires_at.getTime() - (Date.now() + 12 * 3_600_000))).toBeLessThan(60_000);

    const who = await cli(['whoami'], { env });
    expect(who.code, who.stderr).toBe(0);
    expect(who.stdout).toMatch(new RegExp(`user id:\\s+${admin.id}`));
    expect(who.stdout).toMatch(/role:\s+admin/);
    expect(who.stdout).toContain(admin.email);
    const whoJson = JSON.parse((await cli(['whoami', '--json'], { env })).stdout);
    expect(whoJson).toMatchObject({ user_id: admin.id, role: 'admin', kind: 'human', email: admin.email, token_source: 'credentials' });

    // A saved token is never sent to another API URL.
    const elsewhere = await cli(['whoami'], { env: { ...env, SERMONIZE_API_URL: 'http://127.0.0.1:9' } });
    expect(elsewhere.code).toBe(2);

    const out = await cli(['logout'], { env });
    expect(out.code, out.stderr).toBe(0);
    await expect(stat(path)).rejects.toThrow();
    const after = await api.pool.query('SELECT revoked_at FROM private.api_token WHERE user_id = $1 AND name = $2', [admin.id, 'cli']);
    expect(after.rows.every((r) => r.revoked_at !== null)).toBe(true);
    expect((await cli(['whoami'], { env })).code).toBe(2);
    expect((await cli(['logout'], { env })).stdout).toContain('Not logged in');
  });

  it('login with a wrong password: exit 2, nothing saved, password not echoed', async () => {
    const res = await cli(['login', '--email', admin.email], { env, input: ['wrong password here'] });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('invalid email or password');
    expect(res.stdout + res.stderr).not.toContain('wrong password here');
    await expect(stat(credentialsPath(env))).rejects.toThrow();
  });

  it('hidden prompt on a terminal does not echo; --password-stdin works', async () => {
    const res = await cli(['login', '--email', admin.email], { env, input: [ADMIN_PASSWORD], tty: true });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout + res.stderr).not.toContain(ADMIN_PASSWORD);
    const piped = await cli(['login', '--password-stdin', '--email', admin.email], { env, input: [ADMIN_PASSWORD] });
    expect(piped.code, piped.stderr).toBe(0);
    expect(piped.stderr).not.toContain('Password:');
  });

  it('users create / list / get / set-role / disable / enable / set-password', async () => {
    await login();
    const email = uniqueEmail('managed');
    const created = await cli(
      ['users', 'create', '--email', email, '--role', 'reader', '--display-name', 'Cli Person', '--password-prompt', '--json'],
      { env, input: [NEW_PASSWORD, NEW_PASSWORD] },
    );
    expect(created.code, created.stderr).toBe(0);
    expect(created.stdout + created.stderr).not.toContain(NEW_PASSWORD);
    const user = JSON.parse(created.stdout);
    expect(user).toMatchObject({ email, display_name: 'Cli Person', role: 'reader', kind: 'human', has_password: true });

    // The new user can sign in with the password set through the prompt.
    const userEnv = { ...env, XDG_CONFIG_HOME: join(config.dir, 'other') };
    expect((await cli(['login', '--email', email], { env: userEnv, input: [NEW_PASSWORD] })).code).toBe(0);
    // ...but is not an admin.
    const forbidden = await cli(['users', 'list'], { env: userEnv });
    expect(forbidden.code).toBe(2);
    expect(forbidden.stderr).toContain('forbidden');

    const list = await cli(['users', 'list', '--q', email.toUpperCase()], { env });
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toMatch(/^ID\s+EMAIL\s+NAME\s+KIND\s+ROLE\s+STATUS\s+PASSWORD\s+CREATED/);
    expect(list.stdout).toContain(user.id);
    expect(list.stdout).toContain('Cli Person');
    const listJson = JSON.parse((await cli(['users', 'list', '--q', email, '--json'], { env })).stdout);
    expect(listJson).toEqual({ items: [expect.objectContaining({ id: user.id })], next_cursor: null });
    const filtered = JSON.parse((await cli(['users', 'list', '--q', email, '--role', 'admin', '--json'], { env })).stdout);
    expect(filtered.items).toEqual([]);
    expect((await cli(['users', 'list', '--role', 'root'], { env })).code).toBe(1);

    const get = await cli(['users', 'get', user.id], { env });
    expect(get.code).toBe(0);
    expect(get.stdout).toMatch(/email:\s+/);
    expect(get.stdout).toMatch(/tokens:\s+1 active/);

    const promote = await cli(['users', 'set-role', user.id, 'curator'], { env });
    expect(promote.code, promote.stderr).toBe(0);
    expect(promote.stdout).toContain('now has role curator');
    expect((await cli(['users', 'set-role', user.id, 'root'], { env })).code).toBe(1);

    const disable = await cli(['users', 'disable', user.id, '--json'], { env });
    expect(JSON.parse(disable.stdout).status).toBe('disabled');
    // Immediately: the user's saved token stops working.
    expect((await cli(['whoami'], { env: userEnv })).code).toBe(2);
    const enable = await cli(['users', 'enable', user.id], { env });
    expect(enable.stdout).toContain('is active');
    expect((await cli(['whoami'], { env: userEnv })).code).toBe(0);

    const setPw = await cli(['users', 'set-password', user.id, '--revoke-tokens'], { env, input: ['another new password!', 'another new password!'] });
    expect(setPw.code, setPw.stderr).toBe(0);
    expect(setPw.stdout).toContain('Revoked 1 token(s)');
    expect(setPw.stdout + setPw.stderr).not.toContain('another new password!');
    expect((await cli(['whoami'], { env: userEnv })).code).toBe(2);
    expect((await cli(['login', '--email', email, '--password-stdin'], { env: userEnv, input: ['another new password!'] })).code).toBe(0);

    const mismatch = await cli(['users', 'set-password', user.id], { env, input: ['first password 123', 'second password 123'] });
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain('do not match');
    const short = await cli(['users', 'set-password', user.id, '--password-stdin'], { env, input: ['short'] });
    expect(short.code).toBe(1);
    expect(short.stderr).toContain('12 to 256');

    expect((await cli(['users', 'get', 'not-a-uuid'], { env })).code).toBe(1);
    const missing = await cli(['users', 'get', '0190a000-0000-7000-8000-00000000cafe'], { env });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('user not found');
  });

  it('users list --all follows the cursor', async () => {
    await login();
    const tag = uniqueEmail('page').split('@')[0]!;
    for (let i = 0; i < 3; i++) {
      expect((await cli(['users', 'create', '--email', `${tag}.${i}@example.org`, '--role', 'reader'], { env })).code).toBe(0);
    }
    const page = await cli(['users', 'list', '--q', tag, '--limit', '2'], { env });
    expect(page.stderr).toContain('More users');
    const all = JSON.parse((await cli(['users', 'list', '--q', tag, '--limit', '2', '--all', '--json'], { env })).stdout);
    expect(all.items).toHaveLength(3);
    expect(all.next_cursor).toBeNull();
  });

  it('service users and tokens: create, list, revoke', async () => {
    await login();
    const created = await cli(['users', 'create', '--kind', 'service', '--role', 'contributor', '--display-name', 'embedder', '--json'], { env });
    expect(created.code, created.stderr).toBe(0);
    const svc = JSON.parse(created.stdout);
    expect(svc).toMatchObject({ kind: 'service', email: null, has_password: false });
    expect((await cli(['users', 'create', '--kind', 'service', '--role', 'reader', '--password-prompt'], { env })).code).toBe(1);
    expect((await cli(['users', 'set-password', svc.id, '--password-stdin'], { env, input: [NEW_PASSWORD] })).code).toBe(1);

    const tok = await cli(['tokens', 'create', svc.id, '--name', 'embeddings', '--expires-at', '2099-01-01T00:00:00Z'], { env });
    expect(tok.code, tok.stderr).toBe(0);
    expect(tok.stderr).toContain('only time the token is shown');
    const token = tok.stdout.trim();
    expect(token).toMatch(/^sz_/);
    const who = JSON.parse((await cli(['whoami', '--json'], { env: { ...env, SERMONIZE_TOKEN: token } })).stdout);
    expect(who).toMatchObject({ user_id: svc.id, role: 'contributor', kind: 'service', token_source: 'env' });

    const list = await cli(['tokens', 'list', svc.id], { env });
    expect(list.stdout).toMatch(/embeddings\s+active/);
    expect(list.stdout).not.toContain(token);
    const listed = JSON.parse((await cli(['tokens', 'list', svc.id, '--json'], { env })).stdout);
    expect(listed.items).toEqual([expect.objectContaining({ name: 'embeddings', state: 'active', expires_at: '2099-01-01T00:00:00.000Z' })]);

    const rev = await cli(['tokens', 'revoke', listed.items[0].id], { env });
    expect(rev.code).toBe(0);
    expect((await cli(['whoami'], { env: { ...env, SERMONIZE_TOKEN: token } })).code).toBe(2);
    expect(JSON.parse((await cli(['tokens', 'list', svc.id, '--json'], { env })).stdout).items[0].state).toBe('revoked');
    expect((await cli(['tokens', 'create', svc.id], { env })).code).toBe(1); // --name required
    expect((await cli(['tokens', 'create', svc.id, '--name', 'x', '--expires-at', 'soon'], { env })).code).toBe(1);
  });

  it('guards are explained: self-demotion and the last active admin', async () => {
    await login();
    const self = await cli(['users', 'set-role', admin.id, 'reader'], { env });
    expect(self.code).toBe(1);
    expect(self.stderr).toContain('you cannot demote or disable your own account');
    const selfJson = await cli(['users', 'disable', admin.id, '--json'], { env });
    expect(JSON.parse(selfJson.stderr).error).toMatchObject({ code: 'conflict', details: { reason: 'self' } });

    // Acting as the system user (a bootstrap token), with every other admin disabled for a moment.
    const system = await tokenFor(api.pool, SYSTEM_PRINCIPAL.userId);
    const { rows } = await api.pool.query<{ id: string }>(
      `SELECT id FROM app_user WHERE role = 'admin' AND status = 'active' AND id NOT IN ($1, $2)`,
      [SYSTEM_PRINCIPAL.userId, admin.id],
    );
    const others = rows.map((r) => r.id);
    await asSystem(api.pool, (c) => c.query(`UPDATE app_user SET status = 'disabled' WHERE id = ANY($1)`, [others]));
    try {
      const last = await cli(['users', 'disable', admin.id], { env: { ...env, SERMONIZE_TOKEN: system.token } });
      expect(last.code).toBe(1);
      expect(last.stderr).toContain('last active admin');
      expect(last.stderr).toContain('Promote another user to admin first');
    } finally {
      await asSystem(api.pool, (c) => c.query(`UPDATE app_user SET status = 'active' WHERE id = ANY($1)`, [others]));
      await asSystem(api.pool, (c) => c.query('SELECT private.revoke_api_token($1)', [system.id]));
    }
  });

  it('stats needs no token; unreachable API is exit 1', async () => {
    const stats = await cli(['stats'], { env });
    expect(stats.code, stats.stderr).toBe(0);
    expect(stats.stdout).toMatch(/persons:\s+\d+/);
    expect(JSON.parse((await cli(['stats', '--json'], { env })).stdout)).toHaveProperty('embeddings');
    const down = await cli(['stats'], { env: { ...env, SERMONIZE_API_URL: 'http://127.0.0.1:9' } });
    expect(down.code).toBe(1);
    expect(down.stderr).toContain('cannot reach the Sermonize API');
  });

  it('ignores a corrupt credentials file', async () => {
    const path = credentialsPath(env);
    await mkdir(join(config.dir, 'sermonize'), { recursive: true });
    await writeFile(path, 'not json');
    expect((await cli(['whoami'], { env })).code).toBe(2);
  });
});
