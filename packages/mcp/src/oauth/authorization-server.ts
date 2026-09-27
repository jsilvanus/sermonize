import type { FastifyInstance, FastifyReply } from 'fastify';
import { verify } from '@node-rs/argon2';
import type { AuthStore, UserStore } from '../storage/interface.js';
import { fetchCimdMetadata, isCimdClientId } from './cimd.js';
import { randomToken, verifyS256 } from './pkce.js';
import { issueAccessToken } from './jwt.js';
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

function loginPage(oauth: string, error?: string): string {
  return page('MCP sign in',
    '<h1>Sign in</h1><p>Sign in to authorize this MCP client to access the connector.</p>' +
    (error ? '<p class="error">' + escapeHtml(error) + '</p>' : '') +
    '<form method="post" action="/oauth/authorize">' +
    '<input type="hidden" name="oauth" value="' + escapeHtml(oauth) + '">' +
    '<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required autofocus>' +
    '<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>' +
    '<button type="submit">Sign in</button></form>');
}

function consentPage(oauth: string, userName: string, clientName: string): string {
  return page('Authorize MCP client',
    '<h1>Authorize MCP client</h1><p><strong>' + escapeHtml(clientName) +
    '</strong> wants access to this connector as <strong>' + escapeHtml(userName) +
    '</strong>.</p><form method="post" action="/oauth/authorize">' +
    '<input type="hidden" name="oauth" value="' + escapeHtml(oauth) + '">' +
    '<input type="hidden" name="action" value="approve">' +
    '<button type="submit">Approve</button>' +
    '<button class="secondary" type="submit" name="action" value="deny">Deny</button></form>');
}

async function validateRequest(query: Record<string,string|undefined>) {
  if (query.response_type !== 'code' || !query.client_id || !query.redirect_uri || !query.code_challenge || query.code_challenge_method !== 'S256') {
    throw new Error('Invalid OAuth request');
  }
  if (!isCimdClientId(query.client_id)) throw new Error('Invalid client_id');
  const metadata = await fetchCimdMetadata(query.client_id);
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

export async function mountAuthorizationServer(
  app: FastifyInstance,
  issuer: string,
  resource: string,
  secret: Uint8Array,
  authStore: AuthStore,
  users: UserStore,
): Promise<void> {
  app.get('/oauth/authorize', async (request, reply) => {
    const q = request.query as Record<string,string|undefined>;
    try {
      await validateRequest(q);
      return sendHtml(reply, loginPage(encodeOAuth(q)));
    } catch {
      return sendHtml(reply, page('Invalid request','<h1>Invalid authorization request</h1>'), [], 400);
    }
  });

  app.post('/oauth/authorize', async (request, reply) => {
    const body = request.body as Record<string,string|undefined>;
    if (!body.oauth || !body.email || !body.password) {
      return sendHtml(reply, page('Login required','<h1>Login required</h1>'), [], 400);
    }

    let q: Record<string,string|undefined>;
    let metadata: Awaited<ReturnType<typeof validateRequest>>;
    try {
      q = decodeOAuth(body.oauth);
      metadata = await validateRequest(q);
    } catch {
      return sendHtml(reply, page('Invalid request','<h1>Invalid authorization request</h1>'), [], 400);
    }

    const user = users.getUserByEmail(body.email);
    if (!user?.passwordHash || !(await verify(user.passwordHash, body.password))) {
      return sendHtml(reply, loginPage(body.oauth, 'Invalid email or password.'), [], 401);
    }

    if (body.action === undefined) {
      // Approve/deny redirect to the client: form-action must allow its redirect_uri, or browsers block the redirect.
      return sendHtml(reply, consentPage(body.oauth, user.name, metadata.client_name ?? q.client_id!), [redirectSource(q.redirect_uri!)]);
    }

    if (body.action !== 'approve') {
      const target = new URL(q.redirect_uri!);
      target.searchParams.set('error','access_denied');
      target.searchParams.set('iss',issuer);
      if (q.state) target.searchParams.set('state',q.state);
      return reply.redirect(target.toString());
    }

    const code = randomToken();
    authStore.saveAuthorizationCode({
      code,
      clientId: q.client_id!,
      redirectUri: q.redirect_uri!,
      challenge: q.code_challenge!,
      subject: user.id,
      scope: q.scope ?? 'mcp',
      expires: Date.now() + 60_000,
    });

    const target = new URL(q.redirect_uri!);
    target.searchParams.set('code',code);
    target.searchParams.set('iss',issuer);
    if (q.state) target.searchParams.set('state',q.state);
    return reply.redirect(target.toString());
  });

  app.post('/oauth/token', async (request, reply) => {
    const b = request.body as Record<string,string|undefined>;
    reply.header('Cache-Control', 'no-store'); // RFC 6749 §5.1

    if (b.grant_type === 'authorization_code') {
      const code = b.code ? authStore.consumeAuthorizationCode(b.code) : undefined;
      if (!code || b.client_id !== code.clientId || b.redirect_uri !== code.redirectUri || !b.code_verifier || !verifyS256(b.code_verifier,code.challenge)) {
        return reply.code(400).send({error:'invalid_grant'});
      }
      const access = await issueAccessToken(secret,issuer,resource,code.subject,code.clientId,code.scope);
      const refreshToken = randomToken();
      authStore.saveRefreshToken({token:refreshToken,clientId:code.clientId,subject:code.subject,scope:code.scope,expires:Date.now()+30*86_400_000});
      return {access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refreshToken,scope:code.scope};
    }

    if (b.grant_type === 'refresh_token') {
      const refreshToken = b.refresh_token ? authStore.getRefreshToken(b.refresh_token) : undefined;
      if (!refreshToken || b.client_id !== refreshToken.clientId) return reply.code(400).send({error:'invalid_grant'});
      const access = await issueAccessToken(secret,issuer,resource,refreshToken.subject,refreshToken.clientId,refreshToken.scope);
      return {access_token:access,token_type:'Bearer',expires_in:3600,scope:refreshToken.scope};
    }

    return reply.code(400).send({error:'unsupported_grant_type'});
  });
}
