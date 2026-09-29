import type { FastifyContextConfig, FastifyInstance, FastifyReply } from 'fastify';
import type { UpstreamSessions } from '../grants.js';
import type { AuthStore, GrantRecord } from '../storage/interface.js';
import { fetchCimdMetadata, isCimdClientId, type CimdMetadata } from './cimd.js';
import { randomToken, verifyS256 } from './pkce.js';
import { ACCESS_TOKEN_TTL_SECONDS, issueAccessToken } from './jwt.js';
import { contentSecurityPolicy, redirectSource } from '../csp.js';
import type { SignInResult } from '../grants.js';
import { OIDC_COOKIE, OIDC_STATE_TTL_MS, readCookie, stateCookie, type OidcRelyingParty, type OidcStateStore } from './oidc.js';

function escapeHtml(value: string): string {
  return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
}

function page(title: string, body: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    escapeHtml(title) +
    '</title><style>body{font-family:system-ui,sans-serif;background:#f6f7f9;margin:0;padding:4rem 1rem}main{max-width:420px;margin:0 auto;background:#fff;padding:2rem;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.08)}h1{margin-top:0}label{display:block;margin:.9rem 0 .35rem}input{display:block;width:100%;box-sizing:border-box;padding:.7rem;border:1px solid #ccc;border-radius:7px}button,.button{display:inline-block;margin-top:1rem;padding:.7rem 1.1rem;border:0;border-radius:7px;cursor:pointer;background:#e9e9ed;color:#000;font:inherit;text-decoration:none}.secondary{margin-left:.5rem;background:#eee}.error{color:#b00020}.sso{margin:1.2rem 0;padding-bottom:1.2rem;border-bottom:1px solid #eee}</style></head><body><main>' +
    body +
    '</main></body></html>';
}

/** Sign-in page options: the single sign-on button's label, when OIDC is configured. */
interface LoginOptions {
  ssoLabel?: string | undefined;
}

function loginPage(oauth: string, error?: string, email = '', options: LoginOptions = {}): string {
  // A link, not a form: CSP form-action would also apply to /oidc/login's redirect to the IdP.
  const sso = options.ssoLabel
    ? '<p class="sso"><a class="button" href="/oidc/login?oauth=' + encodeURIComponent(oauth) + '">' +
      escapeHtml(options.ssoLabel) + '</a></p><p>Or sign in with your Sermonize email and password:</p>'
    : '';
  return page('Sign in to Sermonize',
    '<h1>Sign in</h1><p>Sign in with your Sermonize account (the same email and password as on the Sermonize web site) ' +
    'to let this MCP client use Sermonize on your behalf.</p>' +
    (error ? '<p class="error" role="alert">' + escapeHtml(error) + '</p>' : '') + sso +
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
  no_account: { status: 403, message: 'No account for this sign-in; ask the administrator.' },
  rate_limited: { status: 429, message: 'Too many sign-in attempts. Please wait a minute and try again.' },
  unavailable: { status: 503, message: 'Sermonize cannot be reached right now. Please try again in a few minutes.' },
} as const;

const OIDC_STATE_TTL_SECONDS = OIDC_STATE_TTL_MS / 1000;
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

/** Single sign-on (OIDC Relying Party); absent when OIDC_ISSUER is unset: no button, no /oidc/* routes. */
export interface OidcOptions {
  relyingParty: OidcRelyingParty;
  states: OidcStateStore;
  /** Mark the state cookie Secure (production or an https public URL). */
  secureCookie: boolean;
  /** Per-IP limit on /oidc/login and /oidc/callback (requires @fastify/rate-limit to be registered). */
  rateLimit?: { max: number; timeWindow: number } | undefined;
}

export interface AuthorizationServerOptions {
  authStore: AuthStore;
  oidc?: OidcOptions | undefined;
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
  const oidc = options.oidc;
  const loginOptions: LoginOptions = { ssoLabel: oidc?.relyingParty.config.buttonLabel };

  /**
   * After a successful sign-in (password or single sign-on): a pending grant holding the API token and
   * the consent page, whose ticket proves this browser signed in for this very OAuth request.
   */
  function continueToConsent(
    reply: FastifyReply,
    oauth: string,
    q: Record<string, string | undefined>,
    metadata: CimdMetadata,
    result: Extract<SignInResult, { ok: true }>,
    userLabel: string,
  ) {
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
    return sendHtml(reply, consentPage(oauth, newTicket, userLabel, metadata.client_name ?? q.client_id!), [redirectSource(q.redirect_uri!)]);
  }

  app.get('/oauth/authorize', async (request, reply) => {
    const q = request.query as Record<string,string|undefined>;
    try {
      await validateRequest(q, resolveClient);
      return sendHtml(reply, loginPage(encodeOAuth(q), undefined, '', loginOptions));
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
        return sendHtml(reply, loginPage(oauth, 'Please enter your email and password.', email, loginOptions), [], 400);
      }
      const result = await sessions.signIn(email, password, request.ip);
      if (!result.ok) {
        const { status, message } = SIGN_IN_ERRORS[result.reason];
        return sendHtml(reply, loginPage(oauth, message, email, loginOptions), [], status);
      }
      return continueToConsent(reply, oauth, q, metadata, result, email);
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

  if (oidc) mountOidcRoutes(oidc);

  /** GET /oidc/login?oauth=… and GET /oidc/callback: single sign-on at the IdP instead of the password form. */
  function mountOidcRoutes({ relyingParty, states, secureCookie, rateLimit }: OidcOptions) {
    const config: FastifyContextConfig = rateLimit ? { rateLimit } : {};
    const errorPage = (reply: FastifyReply, status: number, title: string, message: string, oauth?: string) =>
      sendHtml(reply, page(title,
        '<h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(message) + '</p>' +
        (oauth
          ? '<p><a class="button" href="/oauth/authorize?' + escapeHtml(Buffer.from(oauth, 'base64url').toString('utf8')) + '">Back to sign-in</a></p>'
          : '<p>Please start again from your MCP client.</p>')), [], status);

    app.get('/oidc/login', { config }, async (request, reply) => {
      const oauth = (request.query as Record<string, unknown>).oauth;
      if (typeof oauth !== 'string' || !oauth) {
        return sendHtml(reply, page('Invalid request', '<h1>Invalid authorization request</h1>'), [], 400);
      }
      try {
        await validateRequest(decodeOAuth(oauth), resolveClient);
      } catch {
        return sendHtml(reply, page('Invalid request', '<h1>Invalid authorization request</h1>'), [], 400);
      }
      let start: Awaited<ReturnType<OidcRelyingParty['start']>>;
      try {
        start = await relyingParty.start();
      } catch (error) {
        request.log.warn({ err: error instanceof Error ? error.message : 'error' }, 'OIDC discovery failed');
        return errorPage(reply, 503, 'Single sign-on unavailable',
          'The single sign-on service cannot be reached right now. Try again later, or sign in with your email and password.', oauth);
      }
      states.save(start.state, { codeVerifier: start.codeVerifier, nonce: start.nonce, purpose: 'oauth', oauth });
      reply.header('Set-Cookie', stateCookie(start.state, OIDC_STATE_TTL_SECONDS, secureCookie));
      reply.header('Cache-Control', 'no-store');
      return reply.redirect(start.url.toString());
    });

    app.get('/oidc/callback', { config }, async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const state = typeof query.state === 'string' ? query.state : undefined;
      const cookieState = readCookie(request.headers.cookie, OIDC_COOKIE);
      reply.header('Set-Cookie', stateCookie('', 0, secureCookie)); // one attempt per cookie, whatever happens
      reply.header('Cache-Control', 'no-store');
      // Login CSRF: the state must come back to the browser that started this sign-in.
      if (!state || !cookieState || state !== cookieState) {
        request.log.warn({ reason: !state ? 'no_state' : !cookieState ? 'no_cookie' : 'state_mismatch' }, 'OIDC callback refused');
        return errorPage(reply, 400, 'Sign-in failed', 'This sign-in could not be verified (it was started in another browser, or it expired).');
      }
      const saved = states.consume(state);
      if (!saved) {
        request.log.warn({ reason: 'unknown_or_used_state' }, 'OIDC callback refused');
        return errorPage(reply, 400, 'Sign-in expired', 'This sign-in has expired or was already used.');
      }
      if (typeof query.error === 'string') {
        request.log.warn({ error: query.error.slice(0, 100) }, 'OIDC provider returned an error');
        return errorPage(reply, 400, 'Sign-in cancelled', 'The single sign-on service did not sign you in.', saved.oauth);
      }
      let q: Record<string, string | undefined>;
      let metadata: CimdMetadata;
      try {
        q = decodeOAuth(saved.oauth);
        metadata = await validateRequest(q, resolveClient);
      } catch {
        return sendHtml(reply, page('Invalid request', '<h1>Invalid authorization request</h1>'), [], 400);
      }
      const rawQuery = request.raw.url?.split('?')[1] ?? '';
      let signIn: Awaited<ReturnType<OidcRelyingParty['finish']>>;
      try {
        signIn = await relyingParty.finish(rawQuery, { state, nonce: saved.nonce, codeVerifier: saved.codeVerifier });
      } catch (error) {
        const name = error instanceof Error ? error.name : 'error';
        const code = (error as { code?: unknown } | null)?.code;
        request.log.warn({ err: name, code: typeof code === 'string' ? code : undefined }, 'OIDC code exchange failed');
        return errorPage(reply, 502, 'Sign-in failed', 'The single sign-on could not be completed. Please try again.', saved.oauth);
      }
      const result = await sessions.signInWithIdToken({ idToken: signIn.idToken, accessToken: signIn.accessToken }, request.ip);
      if (!result.ok) {
        const reason = result.reason === 'invalid_credentials' ? 'This account cannot sign in to Sermonize.' : SIGN_IN_ERRORS[result.reason].message;
        request.log.warn({ reason: result.reason }, 'OIDC sign-in refused by the Sermonize API');
        return errorPage(reply, SIGN_IN_ERRORS[result.reason].status, 'Sign-in failed', reason, saved.oauth);
      }
      return continueToConsent(reply, saved.oauth, q, metadata, result, signIn.label);
    });
  }

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
