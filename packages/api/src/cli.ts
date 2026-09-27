import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { withTransaction } from './db/transaction.js';
import { ROLES, SYSTEM_PRINCIPAL, USER_KINDS, type Role, type UserKind } from './lib/principal.js';
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordLength } from './lib/passwords.js';
import { createUser, getUser, issueToken, revokeToken, setUserPassword } from './lib/users.js';
import { createVectorIndex, dropVectorIndex } from './lib/vector-index.js';

const USAGE = `Usage: npm run cli -- <command> [options]

Commands:
  migrate                                           apply pending migrations
  create-user --kind human|service --role <role>    create a user, prints its id
              [--email <email>] [--display-name <name>]
              [--password-stdin]                    also set a password, read from stdin
                                                    (human users with --email only; 12-256 chars)
  create-token --user <id> --name <name>            issue an API token, prints it once
              [--expires-at <ISO timestamp>]
  revoke-token <token-id>                           revoke an API token
  create-index <embedding-space-id>                 build the space's partial HNSW index
                                                    (CREATE INDEX CONCURRENTLY; ≤ 4000 dimensions)
  drop-index <embedding-space-id>                   drop the space's HNSW index (CONCURRENTLY)

Roles: ${ROLES.join(', ')}. All writes run as the system user ${SYSTEM_PRINCIPAL.userId}.

This CLI talks to the database directly and is meant for bootstrap and operations
(migrations, the first admin, vector indexes). Day-to-day user management goes
through the API with \`sermonize-admin\` (packages/cli), e.g. after
  printf '%s\n' "$PASSWORD" | npm run cli -- create-user --kind human --role admin --email you@example.org --password-stdin
  sermonize-admin login --email you@example.org`;

/** Reads all of stdin and strips one trailing newline (the password itself may contain spaces). */
async function readStdinSecret(): Promise<string> {
  if (process.stdin.isTTY) fail('--password-stdin expects the password on a pipe, e.g. printf \'%s\\n\' "$PW" | ...');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      kind: { type: 'string' },
      role: { type: 'string' },
      email: { type: 'string' },
      'display-name': { type: 'string' },
      user: { type: 'string' },
      name: { type: 'string' },
      'expires-at': { type: 'string' },
      'password-stdin': { type: 'boolean' },
    },
  });

  const pool = createPool(loadConfig().databaseUrl, 2);
  const requestId = `cli:${command}:${randomUUID()}`;
  const asSystem = <T>(fn: Parameters<typeof withTransaction<T>>[3]) =>
    withTransaction(pool, SYSTEM_PRINCIPAL, requestId, fn);

  try {
    switch (command) {
      case 'migrate': {
        const applied = await migrate(pool);
        console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
        break;
      }
      case 'create-user': {
        const kind = values.kind as UserKind | undefined;
        const role = values.role as Role | undefined;
        if (!kind || !USER_KINDS.includes(kind)) fail('--kind must be human or service');
        if (!role || !ROLES.includes(role)) fail(`--role must be one of ${ROLES.join(', ')}`);
        let passwordHash: string | undefined;
        if (values['password-stdin']) {
          if (kind !== 'human') fail('only human users can have a password');
          if (!values.email) fail('--password-stdin needs --email (the password signs in with it)');
          const password = await readStdinSecret();
          const length = passwordLength(password);
          if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
            fail(`password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters long`);
          }
          passwordHash = await hashPassword(password);
        }
        const user = await asSystem(async (c) => {
          const created = await createUser(c, { kind, role, email: values.email, displayName: values['display-name'] });
          if (passwordHash) await setUserPassword(c, { userId: created.id, passwordHash });
          return created;
        });
        console.log(user.id);
        break;
      }
      case 'create-token': {
        if (!values.user || !values.name) fail('--user and --name are required');
        const userId = values.user;
        const token = await asSystem(async (c) => {
          if (!(await getUser(c, userId))) fail(`user ${userId} not found`);
          return issueToken(c, { userId, name: values.name!, expiresAt: values['expires-at'] ?? null });
        });
        console.error(`token id: ${token.id} (store the token now; it is not shown again)`);
        console.log(token.token);
        break;
      }
      case 'revoke-token': {
        const id = positionals[0];
        if (!id) fail('token id is required');
        const found = await asSystem((c) => revokeToken(c, id));
        if (!found) fail(`token ${id} not found`);
        console.log(`revoked ${id}`);
        break;
      }
      case 'create-index': {
        const id = positionals[0];
        if (!id) fail('embedding space id is required');
        const { name, created } = await createVectorIndex(pool, id);
        console.log(created ? `created ${name}` : `${name} already exists`);
        break;
      }
      case 'drop-index': {
        const id = positionals[0];
        if (!id) fail('embedding space id is required');
        const { name, dropped } = await dropVectorIndex(pool, id);
        console.log(dropped ? `dropped ${name}` : `${name} does not exist`);
        break;
      }
      default:
        fail(`unknown command: ${command}`);
    }
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
