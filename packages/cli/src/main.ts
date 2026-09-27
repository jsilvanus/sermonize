/**
 * sermonize-admin: day-to-day user and token administration over the Sermonize REST API.
 * It never touches the database; bootstrap and operations (migrations, the first admin,
 * vector indexes) stay with the API package's DB CLI (`npm run cli`).
 *
 * `main()` is side-effect free apart from HTTP calls and the credentials file: argv, env and
 * the streams are injected, and it returns the exit code (0 ok, 1 API/usage error, 2 auth).
 */
import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  ApiClient,
  ROLES,
  type AdminUser,
  type IssuedToken,
  type LoginResult,
  type Me,
  type Role,
  type TokenInfo,
  type TokenSummary,
} from './api-client.js';
import { credentialsPath, deleteCredentials, loadCredentials, saveCredentials, type Credentials } from './credentials.js';
import { CliError, EXIT_AUTH, EXIT_ERROR, EXIT_OK, UsageError } from './errors.js';
import { keyValues, shortTime, table } from './format.js';
import { Prompter, type InputStream, type OutputStream } from './prompt.js';

export const DEFAULT_API_URL = 'http://127.0.0.1:3000';

export interface CliIo {
  argv: string[];
  env: Record<string, string | undefined>;
  stdin: InputStream;
  stdout: OutputStream;
  stderr: OutputStream;
  fetch?: typeof fetch;
}

export const USAGE = `Usage: sermonize-admin <command> [options]

Account:
  login [--email <email>] [--password-stdin]   sign in (password prompt, hidden); saves a token
  logout                                       revoke the saved token and delete it
  whoami                                       who the current token belongs to
  stats                                        corpus counts (GET /stats)

Users (admin):
  users list [--role <r>] [--status active|disabled] [--kind human|service]
             [--q <text>] [--limit <n>] [--cursor <c>] [--all]
  users get <user-id>
  users create --email <email> --role <role> [--display-name <name>]
               [--kind human|service] [--password-prompt | --password-stdin]
  users set-role <user-id> <role>
  users disable <user-id>
  users enable <user-id>
  users set-password <user-id> [--revoke-tokens] [--password-stdin]

Tokens (admin):
  tokens list <user-id>
  tokens create <user-id> --name <name> [--expires-at <ISO date-time>]
  tokens revoke <token-id>

Options:
  --json     machine-readable output on stdout
  --help     show this help

Roles: ${ROLES.join(' < ')}. Self-registration only ever gives reader/contributor;
promote with \`users set-role <id> curator|admin\`.

Passwords are never accepted as arguments: they are read from a hidden prompt, or from
the first line of stdin with --password-stdin.

Environment:
  SERMONIZE_API_URL   API base URL (default ${DEFAULT_API_URL}, or the URL saved by login)
  SERMONIZE_TOKEN     API token to use instead of the saved one
  XDG_CONFIG_HOME     credentials go to $XDG_CONFIG_HOME/sermonize/credentials.json
                      (default ~/.config/sermonize/credentials.json, mode 0600)

Exit codes: 0 ok, 1 API or usage error, 2 not signed in / not allowed.`;

type Options = NonNullable<ParseArgsConfig['options']>;
type Values = Record<string, string | boolean | undefined>;

interface Context {
  io: CliIo;
  values: Values;
  args: string[];
  json: boolean;
  prompter: Prompter;
  /** Effective API URL and token (see resolveTarget). */
  apiUrl: string;
  token: string | undefined;
  tokenSource: 'env' | 'credentials' | 'none';
  credsPath: string;
  creds: Credentials | null;
  client: ApiClient;
  out(text: string): void;
  outJson(value: unknown): void;
  note(text: string): void;
}

interface Command {
  options?: Options;
  /** Names of the positional arguments (all required). */
  positionals?: string[];
  run(ctx: Context): Promise<void>;
}

const USER_FILTERS: Options = {
  role: { type: 'string' },
  status: { type: 'string' },
  kind: { type: 'string' },
  q: { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  all: { type: 'boolean' },
};

function oneOf<T extends string>(name: string, value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`--${name} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function str(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === 'string' ? v : undefined;
}

function required(values: Values, name: string): string {
  const v = str(values, name);
  if (v === undefined || v === '') throw new UsageError(`--${name} is required`);
  return v;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidArg(value: string, what: string): string {
  if (!UUID.test(value)) throw new UsageError(`${what} must be a UUID, got "${value}"`);
  return value.toLowerCase();
}

function userRows(users: AdminUser[]): string {
  return table(
    ['ID', 'EMAIL', 'NAME', 'KIND', 'ROLE', 'STATUS', 'PASSWORD', 'CREATED'],
    users.map((u) => [u.id, u.email, u.display_name, u.kind, u.role, u.status, u.has_password, shortTime(u.created_at)]),
  );
}

function userDetails(u: AdminUser & { tokens?: TokenSummary }): string {
  const pairs: Array<[string, string | number | boolean | null]> = [
    ['id', u.id],
    ['email', u.email],
    ['display name', u.display_name],
    ['kind', u.kind],
    ['role', u.role],
    ['status', u.status],
    ['password', u.has_password],
    ['created', u.created_at],
    ['updated', u.updated_at],
  ];
  if (u.tokens) {
    const t = u.tokens;
    pairs.push(['tokens', `${t.active} active, ${t.expired} expired, ${t.revoked} revoked (${t.total} total)`]);
  }
  return keyValues(pairs);
}

async function readPassword(ctx: Context, fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    const password = await ctx.prompter.line('', { hidden: true });
    if (!password) throw new UsageError('--password-stdin: the first line of stdin is empty');
    return password;
  }
  return ctx.prompter.newPassword();
}

async function patchUser(ctx: Context, body: Record<string, unknown>, done: (u: AdminUser) => string): Promise<void> {
  const id = uuidArg(ctx.args[0]!, 'user id');
  const user = await ctx.client.request<AdminUser>('PATCH', `/admin/users/${id}`, body);
  if (ctx.json) ctx.outJson(user);
  else ctx.out(done(user));
}

const COMMANDS: Record<string, Command> = {
  login: {
    options: { email: { type: 'string' }, 'password-stdin': { type: 'boolean' } },
    async run(ctx) {
      const email = str(ctx.values, 'email') || (await ctx.prompter.line('Email: ')).trim();
      if (!email) throw new UsageError('an email address is required');
      const password = ctx.values['password-stdin']
        ? await readPassword(ctx, true)
        : await ctx.prompter.line('Password: ', { hidden: true });
      const client = new ApiClient(ctx.apiUrl, undefined, ctx.io.fetch);
      let res: LoginResult;
      try {
        res = await client.request<LoginResult>('POST', '/auth/login', { email, password, client: 'cli' }, { auth: false });
      } catch (err) {
        if (err instanceof CliError && err.status === 401) {
          throw new CliError('login failed: invalid email or password (or the account is disabled)', EXIT_AUTH, err.apiError, 401);
        }
        throw err;
      }
      const creds: Credentials = {
        api_url: ctx.apiUrl,
        token: res.token,
        expires_at: res.expires_at,
        user_id: res.user_id,
        role: res.role,
        email,
      };
      await saveCredentials(ctx.credsPath, creds);
      if (ctx.json) {
        ctx.outJson({ api_url: ctx.apiUrl, user_id: res.user_id, role: res.role, expires_at: res.expires_at, credentials: ctx.credsPath });
      } else {
        ctx.out(`Logged in to ${ctx.apiUrl} as ${email} (${res.role}); the token expires ${res.expires_at}.\n`);
        ctx.out(`Saved to ${ctx.credsPath}\n`);
      }
      if (res.role !== 'admin') ctx.note(`note: your role is ${res.role}; the users and tokens commands need admin.\n`);
      if (ctx.io.env.SERMONIZE_TOKEN) ctx.note('note: SERMONIZE_TOKEN is set and takes precedence over the saved token.\n');
    },
  },

  logout: {
    async run(ctx) {
      const creds = ctx.creds;
      if (!creds) {
        if (ctx.json) ctx.outJson({ logged_out: false });
        else ctx.out('Not logged in (no saved credentials).\n');
        return;
      }
      let revoked = false;
      try {
        await new ApiClient(creds.api_url, creds.token, ctx.io.fetch).request('POST', '/auth/logout');
        revoked = true;
      } catch (err) {
        // An expired or revoked token is fine: forget it anyway. Anything else: keep the file.
        if (!(err instanceof CliError && err.status === 401)) throw err;
      }
      await deleteCredentials(ctx.credsPath);
      if (ctx.json) ctx.outJson({ logged_out: true, revoked });
      else ctx.out(`Logged out of ${creds.api_url}${revoked ? '' : ' (the token had already expired or been revoked)'}.\n`);
    },
  },

  whoami: {
    async run(ctx) {
      const me = await ctx.client.request<Me>('GET', '/me');
      let user: AdminUser | undefined;
      if (me.role === 'admin') user = await ctx.client.request<AdminUser>('GET', `/admin/users/${me.user_id}`);
      const expires = ctx.tokenSource === 'credentials' ? ctx.creds?.expires_at : undefined;
      if (ctx.json) {
        ctx.outJson({ api_url: ctx.apiUrl, token_source: ctx.tokenSource, ...me, email: user?.email ?? null, ...(expires && { expires_at: expires }) });
        return;
      }
      ctx.out(
        keyValues([
          ['api', ctx.apiUrl],
          ['user id', me.user_id],
          ['email', user?.email ?? (ctx.tokenSource === 'credentials' ? ctx.creds?.email : null)],
          ['role', me.role],
          ['kind', me.kind],
          ['token', ctx.tokenSource === 'env' ? 'SERMONIZE_TOKEN' : ctx.credsPath],
          ...(expires ? ([['expires', expires]] as Array<[string, string]>) : []),
        ]),
      );
    },
  },

  stats: {
    async run(ctx) {
      const stats = await ctx.client.request<Record<string, number | Record<string, number>>>('GET', '/stats', undefined, { auth: false });
      if (ctx.json) return ctx.outJson(stats);
      const pairs: Array<[string, string | number]> = [];
      for (const [key, value] of Object.entries(stats)) {
        if (typeof value === 'object' && value !== null) {
          const parts = Object.entries(value).map(([k, v]) => `${k} ${v}`);
          pairs.push([key.replace(/_/g, ' '), parts.length ? parts.join(', ') : '-']);
        } else {
          pairs.push([key.replace(/_/g, ' '), value]);
        }
      }
      ctx.out(keyValues(pairs));
    },
  },

  'users list': {
    options: USER_FILTERS,
    async run(ctx) {
      const v = ctx.values;
      const params = new URLSearchParams();
      const role = oneOf('role', v.role, ROLES);
      const status = oneOf('status', v.status, ['active', 'disabled'] as const);
      const kind = oneOf('kind', v.kind, ['human', 'service'] as const);
      if (role) params.set('role', role);
      if (status) params.set('status', status);
      if (kind) params.set('kind', kind);
      if (str(v, 'q')) params.set('q', str(v, 'q')!);
      const limitRaw = str(v, 'limit');
      if (limitRaw !== undefined) {
        const n = Number(limitRaw);
        if (!Number.isInteger(n) || n < 1 || n > 500) throw new UsageError('--limit must be an integer from 1 to 500');
        params.set('limit', String(n));
      } else if (v.all) {
        params.set('limit', '200');
      }
      let cursor = str(v, 'cursor') ?? null;
      const items: AdminUser[] = [];
      do {
        if (cursor) params.set('cursor', cursor);
        const page = await ctx.client.request<{ items: AdminUser[]; next_cursor: string | null }>('GET', `/admin/users?${params}`);
        items.push(...page.items);
        cursor = page.next_cursor;
      } while (v.all && cursor);
      if (ctx.json) return ctx.outJson({ items, next_cursor: cursor });
      if (items.length === 0) ctx.out('No users.\n');
      else ctx.out(userRows(items));
      if (cursor) ctx.note(`More users: add --all, or --cursor ${cursor}\n`);
    },
  },

  'users get': {
    positionals: ['user-id'],
    async run(ctx) {
      const id = uuidArg(ctx.args[0]!, 'user id');
      const user = await ctx.client.request<AdminUser & { tokens: TokenSummary }>('GET', `/admin/users/${id}`);
      if (ctx.json) ctx.outJson(user);
      else ctx.out(userDetails(user));
    },
  },

  'users create': {
    options: {
      email: { type: 'string' },
      role: { type: 'string' },
      'display-name': { type: 'string' },
      kind: { type: 'string' },
      'password-prompt': { type: 'boolean' },
      'password-stdin': { type: 'boolean' },
    },
    async run(ctx) {
      const v = ctx.values;
      const kind = oneOf('kind', v.kind, ['human', 'service'] as const) ?? 'human';
      const role = oneOf('role', required(v, 'role'), ROLES)!;
      const email = str(v, 'email');
      if (kind === 'human' && !email) throw new UsageError('--email is required for human users');
      const wantsPassword = v['password-prompt'] === true || v['password-stdin'] === true;
      if (v['password-prompt'] && v['password-stdin']) throw new UsageError('use either --password-prompt or --password-stdin');
      if (wantsPassword && kind !== 'human') throw new UsageError('service accounts cannot have a password; use `tokens create`');
      const password = wantsPassword ? await readPassword(ctx, v['password-stdin'] === true) : undefined;
      const body: Record<string, unknown> = { kind, role };
      if (email) body.email = email;
      if (str(v, 'display-name')) body.display_name = str(v, 'display-name');
      if (password !== undefined) body.password = password;
      const created = await ctx.client.request<{ id: string }>('POST', '/admin/users', body);
      const user = await ctx.client.request<AdminUser & { tokens: TokenSummary }>('GET', `/admin/users/${created.id}`);
      if (ctx.json) ctx.outJson(user);
      else ctx.out(`Created user ${user.id}\n${userDetails(user)}`);
    },
  },

  'users set-role': {
    positionals: ['user-id', 'role'],
    async run(ctx) {
      const role = oneOf<Role>('role', ctx.args[1], ROLES)!;
      await patchUser(ctx, { role }, (u) => `User ${u.id} (${u.email ?? u.kind}) now has role ${u.role}.\n`);
    },
  },

  'users disable': {
    positionals: ['user-id'],
    async run(ctx) {
      await patchUser(ctx, { status: 'disabled' }, (u) => `User ${u.id} (${u.email ?? u.kind}) is disabled; its tokens stop working at once.\n`);
    },
  },

  'users enable': {
    positionals: ['user-id'],
    async run(ctx) {
      await patchUser(ctx, { status: 'active' }, (u) => `User ${u.id} (${u.email ?? u.kind}) is active.\n`);
    },
  },

  'users set-password': {
    positionals: ['user-id'],
    options: { 'revoke-tokens': { type: 'boolean' }, 'password-stdin': { type: 'boolean' } },
    async run(ctx) {
      const id = uuidArg(ctx.args[0]!, 'user id');
      const password = await readPassword(ctx, ctx.values['password-stdin'] === true);
      const res = await ctx.client.request<{ user_id: string; revoked_tokens: number }>('PUT', `/admin/users/${id}/password`, {
        password,
        revoke_tokens: ctx.values['revoke-tokens'] === true,
      });
      if (ctx.json) return ctx.outJson(res);
      ctx.out(
        `Password set for ${id}.` +
          (ctx.values['revoke-tokens'] ? ` Revoked ${res.revoked_tokens} token(s).` : '') +
          '\n',
      );
    },
  },

  'tokens list': {
    positionals: ['user-id'],
    async run(ctx) {
      const id = uuidArg(ctx.args[0]!, 'user id');
      const res = await ctx.client.request<{ items: TokenInfo[] }>('GET', `/admin/users/${id}/tokens`);
      if (ctx.json) return ctx.outJson(res);
      if (res.items.length === 0) return ctx.out('No tokens.\n');
      ctx.out(
        table(
          ['ID', 'NAME', 'STATE', 'CREATED', 'EXPIRES', 'REVOKED'],
          res.items.map((t) => [t.id, t.name, t.state, shortTime(t.created_at), shortTime(t.expires_at), shortTime(t.revoked_at)]),
        ),
      );
    },
  },

  'tokens create': {
    positionals: ['user-id'],
    options: { name: { type: 'string' }, 'expires-at': { type: 'string' } },
    async run(ctx) {
      const id = uuidArg(ctx.args[0]!, 'user id');
      const body: Record<string, unknown> = { name: required(ctx.values, 'name') };
      const expires = str(ctx.values, 'expires-at');
      if (expires !== undefined) {
        const t = Date.parse(expires);
        if (Number.isNaN(t)) throw new UsageError('--expires-at must be an ISO date-time, e.g. 2027-01-01T00:00:00Z');
        body.expires_at = new Date(t).toISOString();
      }
      const token = await ctx.client.request<IssuedToken>('POST', `/admin/users/${id}/tokens`, body);
      ctx.note(
        `Token ${token.id} (${token.name}) for user ${token.user_id}, expires ${token.expires_at ?? 'never'}.\n` +
          'WARNING: this is the only time the token is shown. Store it securely now; only its hash is kept.\n',
      );
      if (ctx.json) ctx.outJson(token);
      else ctx.out(`${token.token}\n`);
    },
  },

  'tokens revoke': {
    positionals: ['token-id'],
    async run(ctx) {
      const id = uuidArg(ctx.args[0]!, 'token id');
      await ctx.client.request('DELETE', `/admin/tokens/${id}`);
      if (ctx.json) ctx.outJson({ revoked: id });
      else ctx.out(`Revoked token ${id}.\n`);
    },
  },
};

const GROUPS = new Set(['users', 'tokens']);

function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`SERMONIZE_API_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError('SERMONIZE_API_URL must be an http(s) URL');
  }
  return parsed.toString().replace(/\/+$/, '');
}

export async function main(io: CliIo): Promise<number> {
  const argv = io.argv;
  let json = argv.includes('--json');
  const prompter = new Prompter(io.stdin, io.stderr);
  try {
    // Refuse passwords in argv before anything else (they would end up in shell history and ps).
    if (argv.some((a) => /^--(password|pass|pw)(=|$)/.test(a))) {
      throw new UsageError('passwords are never accepted as arguments; use the prompt or --password-stdin');
    }
    const help = argv.includes('--help') || argv.includes('-h');
    // The command comes first: `<command>` or `<group> <sub-command>` (global flags may precede it).
    const lead = argv.filter((a) => a !== '--json' && a !== '--help' && a !== '-h');
    const first = lead[0];
    if (first === undefined || first === 'help') {
      if (first === undefined && !help) {
        io.stderr.write(`${USAGE}\n`);
        return EXIT_ERROR;
      }
      io.stdout.write(`${USAGE}\n`);
      return EXIT_OK;
    }
    if (first.startsWith('-')) throw new UsageError(`expected a command before ${first}`);
    const second = lead[1];
    const name = GROUPS.has(first) && second !== undefined && !second.startsWith('-') ? `${first} ${second}` : first;
    const command = COMMANDS[name];
    if (!command) throw new UsageError(`unknown command: ${name}`);
    if (help) {
      io.stdout.write(`${USAGE}\n`);
      return EXIT_OK;
    }
    // Remove the command words (first occurrences) and parse the rest.
    const rest = [...argv];
    for (const w of name.split(' ')) rest.splice(rest.indexOf(w), 1);
    let parsed: { values: Values; positionals: string[] };
    try {
      parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: { ...command.options, json: { type: 'boolean' }, help: { type: 'boolean' } },
      }) as { values: Values; positionals: string[] };
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    json = parsed.values.json === true;
    const expected = command.positionals ?? [];
    if (parsed.positionals.length !== expected.length) {
      throw new UsageError(
        `${name} expects ${expected.length ? expected.map((p) => `<${p}>`).join(' ') : 'no arguments'}` +
          (parsed.positionals.length > expected.length ? `, got extra "${parsed.positionals.slice(expected.length).join(' ')}"` : ''),
      );
    }

    const credsPath = credentialsPath(io.env);
    const creds = await loadCredentials(credsPath);
    const apiUrl = normalizeUrl(io.env.SERMONIZE_API_URL || creds?.api_url || DEFAULT_API_URL);
    let token: string | undefined;
    let tokenSource: Context['tokenSource'] = 'none';
    if (io.env.SERMONIZE_TOKEN) {
      token = io.env.SERMONIZE_TOKEN;
      tokenSource = 'env';
    } else if (creds && creds.api_url === apiUrl) {
      // Never send a saved token to a different server than the one it came from.
      token = creds.token;
      tokenSource = 'credentials';
    }
    const ctx: Context = {
      io,
      values: parsed.values,
      args: parsed.positionals,
      json,
      prompter,
      apiUrl,
      token,
      tokenSource,
      credsPath,
      creds,
      client: new ApiClient(apiUrl, token, io.fetch),
      out: (text) => io.stdout.write(text),
      outJson: (value) => io.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
      note: (text) => io.stderr.write(text),
    };
    await command.run(ctx);
    return EXIT_OK;
  } catch (err) {
    if (err instanceof CliError) {
      if (json) {
        io.stderr.write(
          `${JSON.stringify({ error: err.apiError ?? { code: err instanceof UsageError ? 'usage' : 'error', message: err.message }, message: err.message })}\n`,
        );
      } else {
        io.stderr.write(`error: ${err.message}\n`);
        if (err instanceof UsageError) io.stderr.write('Run `sermonize-admin --help` for usage.\n');
      }
      return err.exitCode;
    }
    io.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_ERROR;
  } finally {
    prompter.close();
  }
}
