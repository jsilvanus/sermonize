import type { FastifyInstance, FastifyReply } from 'fastify';
import type { UpstreamSessions } from '../grants.js';
import type { AuthStore, GrantRecord } from '../storage/interface.js';
import { fetchCimdMetadata, isCimdClientId, type CimdMetadata } from './cimd.js';
import { randomToken, verifyS256 } from './pkce.js';
import { ACCESS_TOKEN_TTL_SECONDS, issueAccessToken } from './jwt.js';
import { contentSecurityPolicy, redirectSource } from '../csp.js';

function escapeHtml(value: string): string {
  return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
}

function page(title: string, body: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    escapeHtml(title) +
    '</title><style>body{font-family:system-ui,sans-serif;background:#f6f7f9;margin:0;padding:4rem 1rem}main{max-width:420px;margin:0 auto;background:#fff;padding:2rem;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.08)}h1{margin-top:0}label{display:block;margin:.9rem 0 .35rem}input{display:block;width:100%;box-sizing:border-box;padding:.7rem;border:1px solid #ccc;border-radius:7px}button{margin-top:1rem;padding:.7rem 1.1rem;border:0;border-radius:7px;cursor:pointer}.secondary{margin-left:.5rem;background:#eee}.error{color:#b00020}</style></head><body><main>' +
    body +
    '</main></body></html>';
}

function loginPage(oauth: string, error?: string, email = ''): string {
  return page('Sign in to Sermonize',
    '<h1>Sign in</h1><p>Sign in with your Sermonize account (the same email and password as on the Sermonize web site) ' +
    'to let this MCP client use Sermonize on your behalf.</p>' +
    (error ? '<p class="error" role="alert">' + escapeHtml(error) + '</p>' : '') +
    '<form method="post" action="/oauth/authorize">' +
    '<input type="hidden" name="oauth" value="' + escapeHtml(oauth) + '">' +
    '<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required autofocus value="' + escapeHtml(email) + '">' +
    '<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>' +
    '<button type="submit">Sign in</button></form>');
}

function consentPage(oauth: string, ticket: string, userName: string, clientName: string): string {
  return page('Authorize MCP client',
    '<h1>Authorize MCP client</h1><p><strong>' + escapeHtml(clientName) +
    '</strong> wants access to Sermonize as <strong>' + escapeHtml(userName) +
    '</strong>, with your Sermonize role and permissions.</p><form method="post" action="/oauth/authorize">' +
    '<input type="hidden" name="oauth" value="' + escapeHtml(oauth) + '">' +
    '<input type="hidden" name="ticket" value="' + escapeHtml(ticket) + '">' +
    '<button type="submit" name="action" value="approve">Approve</button>' +
    '<button class="secondary" type="submit" name="action" value="deny">Deny</button></form>');
}

/** First value of a form field (a repeated field arrives as an array), or undefined. */
function field(body: unknown, name: string): string | undefined {
  const raw = (body as Record<string, unknown> | undefined)?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

const SIGN_IN_ERRORS = {
  invalid_credentials: { status: 401, message: 'Invalid email or password.' },
  rate_limited: { status: 429, message: 'Too many sign-in attempts. Please wait a minute and try again.' },
  unavailable: { status: 503, message: 'Sermonize cannot be reached right now. Please try again in a few minutes.' },
} as const;

/** How long a signed-in user has to approve or deny (the grant stays pending meanwhile). */
const PENDING_GRANT_MS = 10 * 60_000;
/** Authorization code lifetime; the grant is kept a little longer so the token exchange can find it. */
const CODE_MS = 60_000;
const CODE_GRANT_MS = 5 * 60_000;
/** Upper bound of a refresh token's lifetime; it is also capped by the upstream API token's expiry. */
const REFRESH_TOKEN_MS = 30 * 86_400_000;

async function validateRequest(query: Record<string,string|undefined>, resolveClient: ClientResolver) {
  if (query.response_type !== 'code' || !query.client_id || !query.redirect_uri || !query.code_challenge || query.code_challenge_method !== 'S256') {
    throw new Error('Invalid OAuth request');
  }
  if (!isCimdClientId(query.client_id)) throw new Error('Invalid client_id');
  const metadata = await resolveClient(query.client_id);
  if (!metadata.redirect_uris.includes(query.redirect_uri)) throw new Error('Invalid redirect_uri');
  return metadata;
}

function encodeOAuth(query: Record<string,string|undefined>): string {
  return Buffer.from(new URLSearchParams(Object.entries(query).filter((entry): entry is [string,string] => typeof entry[1] === 'string')).toString()).toString('base64url');
}

function decodeOAuth(value: string): Record<string,string|undefined> {
  return Object.fromEntries(new URLSearchParams(Buffer.from(value,'base64url').toString('utf8')));
}

function sendHtml(reply: FastifyReply, html: string, formAction: string[] = [], status = 200) {
  return reply.code(status).header('Content-Security-Policy', contentSecurityPolicy(formAction)).type('text/html').send(html);
}

export type ClientResolver = (clientId: string) => Promise<CimdMetadata>;

export interface AuthorizationServerOptions {
  authStore: AuthStore;
  /** Sign-in against the Sermonize API and the grants holding the upstream API tokens. */
  sessions: UpstreamSessions;
  /** Resolves a CIMD client_id to its metadata; defaults to fetching the document (tests inject one). */
  resolveClient?: ClientResolver;
}

export async function mountAuthorizationServer(
  app: FastifyInstance,
  issuer: string,
  resource: string,
  secret: Uint8Array,
  options: AuthorizationServerOptions,
): Promise<void> {
  const { authStore, sessions } = options;
  const grants = sessions.store;
  const resolveClient = options.resolveClient ?? fetchCimdMetadata;

  app.get('/oauth/authorize', async (request, reply) => {
    const q = request.query as Record<string,string|undefined>;
    try {
      await validateRequest(q, resolveClient);
      return sendHtml(reply, loginPage(encodeOAuth(q)));
    } catch {
      return sendHtml(reply, page('Invalid request','<h1>Invalid authorization request</h1>'), [], 400);
    }
  });

  app.post('/oauth/authorize', async (request, reply) => {
    const oauth = field(request.body, 'oauth');
    if (!oauth) {
      return sendHtml(reply, page('Login required','<h1>Login required</h1>'), [], 400);
    }

    let q: Record<string,string|undefined>;
    let metadata: CimdMetadata;
    try {
      q = decodeOAuth(oauth);
      metadata = await validateRequest(q, resolveClient);
    } catch {
      return sendHtml(reply, page('Invalid request','<h1>Invalid authorization request</h1>'), [], 400);
    }

    const ticket = field(request.body, 'ticket');
    if (ticket === undefined) {
      // Step 1: sign-in. The API verifies the password; this server never stores or hashes it.
      const email = (field(request.body, 'email') ?? '').trim().slice(0, 320);
      const password = (field(request.body, 'password') ?? '').slice(0, 1024);
      if (!email || !password) {
        return sendHtml(reply, loginPage(oauth, 'Please enter your email and password.', email), [], 400);
      }
      const result = await sessions.signIn(email, password, request.ip);
      if (!result.ok) {
        const { status, message } = SIGN_IN_ERRORS[result.reason];
        return sendHtml(reply, loginPage(oauth, message, email), [], status);
      }
      const newTicket = randomToken();
      grants.createPendingGrant({
        id: randomToken(18),
        subject: result.userId,
        clientId: q.client_id!,
        apiToken: result.apiToken,
        apiTokenExpires: result.expiresAt,
        ticket: newTicket,
        requestFingerprint: oauth,
        expires: Math.min(Date.now() + PENDING_GRANT_MS, result.expiresAt),
      });
      // Approve/deny redirect to the client: form-action must allow its redirect_uri, or browsers block the redirect.
      return sendHtml(reply, consentPage(oauth, newTicket, email, metadata.client_name ?? q.client_id!), [redirectSource(q.redirect_uri!)]);
    }

    // Step 2: consent. The ticket proves this browser signed in for this very OAuth request.
    const approve = field(request.body, 'action') === 'approve';
    const grant = grants.activateGrant(ticket, oauth, Date.now() + CODE_GRANT_MS);
    if (!grant || grant.clientId !== q.client_id) {
      if (grant) await sessions.end(grant.id);
      return sendHtml(reply, page('Sign-in expired',
        '<h1>Sign-in expired</h1><p>This sign-in is no longer valid. Please start again from your MCP client.</p>'), [], 400);
    }

    if (!approve) {
      await sessions.end(grant.id); // revokes the API token obtained at sign-in
      const target = new URL(q.redirect_uri!);
      target.searchParams.set('error','access_denied');
      target.searchParams.set('iss',issuer);
      if (q.state) target.searchParams.set('state',q.state);
      return reply.redirect(target.toString());
    }

    const code = randomToken();
    authStore.saveAuthorizationCode({
      code,
      grantId: grant.id,
      clientId: q.client_id!,
      redirectUri: q.redirect_uri!,
      challenge: q.code_challenge!,
      subject: grant.subject,
      scope: q.scope ?? 'mcp',
      expires: Date.now() + CODE_MS,
    });

    const target = new URL(q.redirect_uri!);
    target.searchParams.set('code',code);
    target.searchParams.set('iss',issuer);
    if (q.state) target.searchParams.set('state',q.state);
    return reply.redirect(target.toString());
  });

  /** Access token for a grant: at most ACCESS_TOKEN_TTL_SECONDS, and never past the upstream token's expiry. */
  async function accessTokenFor(grant: GrantRecord, clientId: string, scope: string) {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = Math.min(now + ACCESS_TOKEN_TTL_SECONDS, Math.floor(grant.apiTokenExpires / 1000));
    const token = await issueAccessToken(secret, issuer, resource, grant.subject, clientId, scope, { grantId: grant.id, expiresAt });
    return { access_token: token, token_type: 'Bearer', expires_in: Math.max(expiresAt - now, 0), scope };
  }

  app.post('/oauth/token', async (request, reply) => {
    const b = request.body as Record<string,string|undefined>;
    reply.header('Cache-Control', 'no-store'); // RFC 6749 §5.1

    if (b.grant_type === 'authorization_code') {
      const code = b.code ? authStore.consumeAuthorizationCode(b.code) : undefined;
      if (!code || b.client_id !== code.clientId || b.redirect_uri !== code.redirectUri || !b.code_verifier || !verifyS256(b.code_verifier,code.challenge)) {
        return reply.code(400).send({error:'invalid_grant'});
      }
      const grant = grants.getGrant(code.grantId);
      if (!grant || grant.subject !== code.subject || grant.apiTokenExpires <= Date.now()) {
        await sessions.end(code.grantId);
        return reply.code(400).send({error:'invalid_grant'});
      }
      // The refresh token (and so the grant) never outlives the upstream API token.
      const refreshExpires = Math.min(Date.now() + REFRESH_TOKEN_MS, grant.apiTokenExpires);
      grants.setGrantExpiry(grant.id, refreshExpires);
      const refreshToken = randomToken();
      authStore.saveRefreshToken({token:refreshToken,grantId:grant.id,clientId:code.clientId,subject:code.subject,scope:code.scope,expires:refreshExpires});
      return { ...(await accessTokenFor(grant, code.clientId, code.scope)), refresh_token: refreshToken };
    }

    if (b.grant_type === 'refresh_token') {
      const refreshToken = b.refresh_token ? authStore.getRefreshToken(b.refresh_token) : undefined;
      if (!refreshToken || b.client_id !== refreshToken.clientId) return reply.code(400).send({error:'invalid_grant'});
      const grant = grants.getGrant(refreshToken.grantId);
      if (!grant || grant.subject !== refreshToken.subject || grant.apiTokenExpires <= Date.now()) {
        await sessions.end(refreshToken.grantId);
        return reply.code(400).send({error:'invalid_grant'});
      }
      return accessTokenFor(grant, refreshToken.clientId, refreshToken.scope);
    }

    return reply.code(400).send({error:'unsupported_grant_type'});
  });
}
