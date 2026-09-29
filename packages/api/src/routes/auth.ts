import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import pg from 'pg';
import type { AuthConfig } from '../config.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError, conflict, unauthorized } from '../lib/errors.js';
import {
  dummyVerify,
  checkPasswordLength,
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from '../lib/passwords.js';
import { createOidcVerifier } from '../lib/oidc.js';
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

const ClientSchema = Type.Union([Type.Literal('web'), Type.Literal('mcp'), Type.Literal('cli')], {
  description:
    "Who asks for the token (default 'web'). The token is named after it and expires after " +
    'LOGIN_TOKEN_TTL_HOURS (web), MCP_LOGIN_TOKEN_TTL_HOURS (mcp) or CLI_LOGIN_TOKEN_TTL_HOURS (cli, sermonize-admin).',
});

/** Which client asks for the login token: its name and lifetime depend on it. */
export type LoginClient = 'web' | 'mcp' | 'cli';

const LoginBody = Type.Object({
  email: Type.String({ minLength: 1, maxLength: 320 }),
  password: Password,
  client: Type.Optional(ClientSchema),
});

const OidcBody = Type.Object({
  id_token: Type.String({
    minLength: 1,
    maxLength: 16_384,
    description: 'ID token the client received from the IdP (OIDC_ISSUER) in its authorization-code flow.',
  }),
  access_token: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 16_384,
      description: "The IdP access token; used only to read the IdP's userinfo when the ID token carries no email.",
    }),
  ),
  client: Type.Optional(ClientSchema),
});

const LoginResponse = Type.Object({
  token: Type.String({ description: 'API token; send as `Authorization: Bearer <token>`.' }),
  expires_at: Type.String({ format: 'date-time' }),
  user_id: Uuid,
  role: RoleSchema,
});

const authErrors = { ...errorResponses, 429: ErrorResponse };

/**
 * Self-service password accounts (private.register_user etc. in the migration):
 *   GET  /auth/config    public: whether registration is open, password rules
 *   POST /auth/register  public, REGISTRATION_OPEN only: creates a human user with REGISTRATION_DEFAULT_ROLE
 *   POST /auth/login     public: email + password (+ client web|mcp|cli) -> expiring API token named after the client
 *   POST /auth/oidc      public, OIDC_ISSUER only: verified ID token (+ client) -> the same kind of login token
 *   POST /auth/logout    authenticated: revokes the token used for the request
 * PII (email, display name) and the password hash stay in the private schema.
 */
export const authRoutes: FastifyPluginAsyncTypebox<{ auth: AuthConfig }> = async (app, { auth }) => {
  const rateLimit = auth.rateLimit ? { max: auth.rateLimit.max, timeWindow: auth.rateLimit.timeWindowMs } : undefined;
  const publicLimited = { public: true, ...(rateLimit && { rateLimit }) };
  const loginTokenExpiry = (client: LoginClient) => {
    const ttlHours =
      client === 'mcp' ? auth.mcpLoginTokenTtlHours : client === 'cli' ? auth.cliLoginTokenTtlHours : auth.loginTokenTtlHours;
    return new Date(Date.now() + ttlHours * 3_600_000);
  };

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
      checkPasswordLength(password);
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
        response: { 200: LoginResponse, ...authErrors },
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
      const expiresAt = loginTokenExpiry(client);
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

  if (auth.oidc) {
    const oidc = createOidcVerifier(auth.oidc);
    app.post(
      '/auth/oidc',
      {
        config: publicLimited,
        schema: {
          description:
            'Sign-in with an ID token from the OIDC provider (only when OIDC_ISSUER is set; otherwise 404). ' +
            'The API verifies the token itself (JWKS signature, iss, aud in OIDC_CLIENT_IDS, exp, iat at most 10 minutes old), ' +
            'maps (issuer, subject) to an account (linked identity; else an existing account with the same email when the ' +
            'email is verified or OIDC_TRUST_EMAIL=true; else a new account when OIDC_CREATE_USERS=true) and issues the same ' +
            'expiring login token as POST /auth/login. 401 invalid_id_token, 403 no_account, 401 invalid_credentials ' +
            '(disabled account), 503 oidc_unavailable (IdP unreachable).',
          body: OidcBody,
          response: { 200: LoginResponse, ...authErrors, 503: ErrorResponse },
        },
      },
      async (request) => {
        const client: LoginClient = request.body.client ?? 'web';
        const identity = await oidc.verify(request.body.id_token, request.body.access_token);
        const trustedEmail = identity.email && (identity.emailVerified || oidc.config.trustEmail) ? identity.email : null;
        const displayName = (identity.name ?? identity.email)?.slice(0, 200) ?? null;
        const token = generateToken();
        const expiresAt = loginTokenExpiry(client);
        const result = await withTransaction(app.pg, null, request.id, async (db) => {
          const { rows } = await db.query<{ user_id: string; role: Role; status: 'active' | 'disabled'; linked_via: string }>(
            'SELECT * FROM private.oidc_resolve_user($1, $2, $3, $4, $5, $6)',
            [identity.issuer, identity.subject, trustedEmail, displayName, oidc.config.createUsers, auth.registrationDefaultRole],
          );
          const user = rows[0];
          if (!user) {
            throw new ApiError(403, 'no_account', 'no Sermonize account for this sign-in; ask the administrator');
          }
          // Refused like the password path refuses it; the transaction rolls back, so no link is kept.
          if (user.status !== 'active') throw invalidCredentials();
          await db.query('SELECT * FROM private.create_oidc_login_token($1, $2, $3, $4, $5)', [
            identity.issuer,
            identity.subject,
            hashToken(token),
            expiresAt,
            client,
          ]);
          return user;
        });
        request.log.info({ userId: result.user_id, linkedVia: result.linked_via, client }, 'OIDC sign-in');
        return { token, expires_at: expiresAt.toISOString(), user_id: result.user_id, role: result.role };
      },
    );
  }

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
