import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import pg from 'pg';
import type { AuthConfig } from '../config.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError, badRequest, conflict, unauthorized } from '../lib/errors.js';
import {
  dummyVerify,
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordLength,
  verifyPassword,
} from '../lib/passwords.js';
import type { Role, UserKind } from '../lib/principal.js';
import { generateToken, hashToken } from '../lib/tokens.js';
import { principalOf, requireRole } from '../plugins/auth.js';
import { ErrorResponse, errorResponses, RoleSchema, Uuid } from './schemas.js';

const invalidCredentials = () => new ApiError(401, 'invalid_credentials', 'invalid email or password');

// Schema maxLength only bounds the work argon2 is given; the real rule (code points) is checked below.
const Email = Type.String({ format: 'email', minLength: 3, maxLength: 320 });
const Password = Type.String({ minLength: 1, maxLength: 1024 });

const RegisterBody = Type.Object({
  email: Email,
  password: Password,
  display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

/** Which client asks for the login token: its name and lifetime depend on it. */
export type LoginClient = 'web' | 'mcp';

const LoginBody = Type.Object({
  email: Type.String({ minLength: 1, maxLength: 320 }),
  password: Password,
  client: Type.Optional(
    Type.Union(
      [Type.Literal('web'), Type.Literal('mcp')],
      {
        description:
          "Who asks for the token (default 'web'). The token is named after it and expires after " +
          'LOGIN_TOKEN_TTL_HOURS (web) or MCP_LOGIN_TOKEN_TTL_HOURS (mcp).',
      },
    ),
  ),
});

const authErrors = { ...errorResponses, 429: ErrorResponse };

/**
 * Self-service password accounts (migration 0003):
 *   GET  /auth/config    public: whether registration is open, password rules
 *   POST /auth/register  public, REGISTRATION_OPEN only: creates a human user with REGISTRATION_DEFAULT_ROLE
 *   POST /auth/login     public: email + password (+ client web|mcp) -> expiring API token named after the client
 *   POST /auth/logout    authenticated: revokes the token used for the request
 * PII (email, display name) and the password hash stay in the private schema.
 */
export const authRoutes: FastifyPluginAsyncTypebox<{ auth: AuthConfig }> = async (app, { auth }) => {
  const rateLimit = auth.rateLimit ? { max: auth.rateLimit.max, timeWindow: auth.rateLimit.timeWindowMs } : undefined;
  const publicLimited = { public: true, ...(rateLimit && { rateLimit }) };

  app.get(
    '/auth/config',
    {
      config: { public: true },
      schema: {
        response: {
          200: Type.Object({
            registration_open: Type.Boolean(),
            password_min_length: Type.Integer(),
            password_max_length: Type.Integer(),
          }),
        },
      },
    },
    async () => ({
      registration_open: auth.registrationOpen,
      password_min_length: PASSWORD_MIN_LENGTH,
      password_max_length: PASSWORD_MAX_LENGTH,
    }),
  );

  app.post(
    '/auth/register',
    {
      config: publicLimited,
      schema: {
        body: RegisterBody,
        response: { 201: Type.Object({ user_id: Uuid, role: RoleSchema }), ...authErrors },
      },
    },
    async (request, reply) => {
      if (!auth.registrationOpen) throw new ApiError(403, 'registration_closed', 'self-registration is closed');
      const { password, display_name } = request.body;
      const email = request.body.email.trim();
      const length = passwordLength(password);
      if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
        throw badRequest(`password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters long`);
      }
      const passwordHash = await hashPassword(password);
      const role = auth.registrationDefaultRole;
      let userId: string;
      try {
        userId = await withTransaction(app.pg, null, request.id, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            'SELECT private.register_user($1, $2, $3, $4) AS id',
            [role, email, display_name?.trim() || null, passwordHash],
          );
          return rows[0]!.id;
        });
      } catch (err) {
        if (err instanceof pg.DatabaseError && err.code === '23505') {
          // Do not echo the address or say more than necessary.
          throw conflict('registration failed: this email address cannot be used');
        }
        throw err;
      }
      return reply.status(201).send({ user_id: userId, role });
    },
  );

  app.post(
    '/auth/login',
    {
      config: publicLimited,
      schema: {
        body: LoginBody,
        response: {
          200: Type.Object({
            token: Type.String({ description: 'API token; send as `Authorization: Bearer <token>`.' }),
            expires_at: Type.String({ format: 'date-time' }),
            user_id: Uuid,
            role: RoleSchema,
          }),
          ...authErrors,
        },
      },
    },
    async (request) => {
      const { password } = request.body;
      const client: LoginClient = request.body.client ?? 'web';
      const { rows } = await app.pg.query<{
        user_id: string;
        password_hash: string;
        role: Role;
        kind: UserKind;
        status: 'active' | 'disabled';
      }>('SELECT * FROM private.get_password_credential($1)', [request.body.email.trim()]);
      const cred = rows[0];
      if (!cred) {
        await dummyVerify(password);
        throw invalidCredentials();
      }
      // Verify first, then check the status: the timing does not reveal a disabled account.
      const ok = await verifyPassword(cred.password_hash, password);
      if (!ok || cred.status !== 'active') throw invalidCredentials();

      const token = generateToken();
      const ttlHours = client === 'mcp' ? auth.mcpLoginTokenTtlHours : auth.loginTokenTtlHours;
      const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
      try {
        await withTransaction(app.pg, null, request.id, (db) =>
          db.query('SELECT private.create_login_token($1, $2, $3, $4)', [cred.user_id, hashToken(token), expiresAt, client]),
        );
      } catch (err) {
        // Disabled between the lookup and now.
        if (err instanceof pg.DatabaseError && err.code === '42501') throw invalidCredentials();
        throw err;
      }
      return { token, expires_at: expiresAt.toISOString(), user_id: cred.user_id, role: cred.role };
    },
  );

  app.post(
    '/auth/logout',
    {
      preHandler: requireRole('reader'),
      schema: { response: { 204: Type.Null(), ...errorResponses } },
    },
    async (request, reply) => {
      const tokenSha256 = request.tokenSha256;
      if (!tokenSha256) throw unauthorized();
      await withTransaction(app.pg, principalOf(request), request.id, (client) =>
        client.query('SELECT private.revoke_own_token($1)', [tokenSha256]),
      );
      return reply.status(204).send(null);
    },
  );
};
