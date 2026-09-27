import { randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { ApiUnavailableError, SermonizeApi, type Me } from './api-client.js';
import type { WebConfig } from './config.js';
import type { Html } from './html.js';
import { STYLESHEET } from './style.js';
import {
  accountPage,
  errorPage,
  landingPage,
  loginPage,
  registerPage,
  type PageContext,
  type RegisterForm,
} from './views.js';

export type WebAppConfig = Pick<WebConfig, 'sermonizeApiUrl' | 'cookieSecret' | 'cookieSecure' | 'requestTimeoutMs'>;

export const SESSION_COOKIE = 'sz_session';
export const CSRF_COOKIE = 'sz_csrf';

/** default-src 'self' covers /style.css; no script is allowed or needed. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

type FormBody = Record<string, string | string[] | undefined>;

/** First value of a form field, trimmed of nothing (passwords keep their spaces), capped in length. */
function field(body: unknown, name: string, max = 1024): string {
  const raw = (body as FormBody | undefined)?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function codePoints(s: string): number {
  let count = 0;
  for (const _ of s) count++;
  return count;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Server-rendered Sermonize web UI. It talks only to the Sermonize REST API over HTTP
 * (`sermonizeApiUrl`); the session is the user's API token in a signed, httpOnly cookie.
 */
export async function buildWebApp(config: WebAppConfig, logger: FastifyServerOptions['logger'] = false) {
  const api = new SermonizeApi(config.sermonizeApiUrl, config.requestTimeoutMs);
  const app = Fastify({ logger, bodyLimit: 16 * 1024 });

  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(formbody);

  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
    signed: true,
  };

  app.addHook('onSend', async (_request, reply) => {
    reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  // --- cookies -----------------------------------------------------------------------------

  function readSigned(request: FastifyRequest, name: string): string | null {
    const raw = request.cookies[name];
    if (!raw) return null;
    const result = request.unsignCookie(raw);
    return result.valid && result.value ? result.value : null;
  }

  /** The CSRF token of this browser (double-submit: a signed cookie echoed in each form). */
  function csrfToken(request: FastifyRequest, reply: FastifyReply, rotate = false): string {
    const existing = rotate ? null : readSigned(request, CSRF_COOKIE);
    if (existing) return existing;
    const token = randomBytes(32).toString('base64url');
    reply.setCookie(CSRF_COOKIE, token, cookieOptions);
    return token;
  }

  function csrfValid(request: FastifyRequest): boolean {
    const expected = readSigned(request, CSRF_COOKIE);
    const sent = field(request.body, '_csrf', 200);
    return expected !== null && sent !== '' && safeEqual(expected, sent);
  }

  function clearSession(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure });
  }

  /** Resolves the session cookie via GET /me; an invalid/expired token clears the cookie. */
  async function currentUser(request: FastifyRequest, reply: FastifyReply): Promise<{ me: Me; token: string } | null> {
    const token = readSigned(request, SESSION_COOKIE);
    if (!token) {
      if (request.cookies[SESSION_COOKIE]) clearSession(reply);
      return null;
    }
    const res = await api.me(token);
    if (res.ok) return { me: res.data, token };
    clearSession(reply);
    return null;
  }

  async function pageContext(request: FastifyRequest, reply: FastifyReply): Promise<PageContext> {
    const user = await currentUser(request, reply);
    return { me: user?.me ?? null, csrf: csrfToken(request, reply) };
  }

  function send(reply: FastifyReply, page: Html, status = 200) {
    return reply.status(status).type('text/html; charset=utf-8').send(page.value);
  }

  /** Rejects a POST whose CSRF token is missing or wrong (403 page). Returns true if rejected. */
  function rejectCsrf(request: FastifyRequest, reply: FastifyReply): boolean {
    if (csrfValid(request)) return false;
    void send(
      reply,
      errorPage(
        { me: null, csrf: csrfToken(request, reply) },
        'Form expired',
        'This form could not be verified. Please go back, reload the page and try again.',
      ),
      403,
    );
    return true;
  }

  // --- errors --------------------------------------------------------------------------------

  app.setErrorHandler((err, request, reply) => {
    const ctx: PageContext = { me: null, csrf: '' };
    if (err instanceof ApiUnavailableError) {
      request.log.warn({ err }, 'Sermonize API unavailable');
      return send(
        reply,
        errorPage(ctx, 'Temporarily unavailable', 'The Sermonize service cannot be reached right now. Please try again in a few minutes.'),
        503,
      );
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return send(reply, errorPage(ctx, 'Bad request', 'The request could not be processed.'), status);
    }
    request.log.error({ err }, 'unhandled error');
    return send(reply, errorPage(ctx, 'Something went wrong', 'An unexpected error occurred. Please try again later.'), 500);
  });

  app.setNotFoundHandler((_request, reply) =>
    send(reply, errorPage({ me: null, csrf: '' }, 'Page not found', 'There is no page at this address.'), 404),
  );

  // --- routes --------------------------------------------------------------------------------

  app.get('/style.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').header('cache-control', 'public, max-age=3600').send(STYLESHEET),
  );

  app.get('/', async (request, reply) => {
    const ctx = await pageContext(request, reply);
    const stats = await api.stats();
    if (!stats.ok) throw new ApiUnavailableError(`GET /stats answered ${stats.status}`);
    return send(reply, landingPage(ctx, stats.data));
  });

  async function authConfig() {
    const res = await api.authConfig();
    if (!res.ok) throw new ApiUnavailableError(`GET /auth/config answered ${res.status}`);
    return res.data;
  }

  app.get('/register', async (request, reply) => {
    const ctx = await pageContext(request, reply);
    return send(reply, registerPage(ctx, await authConfig()));
  });

  app.post('/register', async (request, reply) => {
    if (rejectCsrf(request, reply)) return reply;
    const ctx = await pageContext(request, reply);
    const config = await authConfig();
    if (!config.registration_open) return send(reply, registerPage(ctx, config), 403);

    const values: RegisterForm = {
      email: field(request.body, 'email', 320).trim(),
      display_name: field(request.body, 'display_name', 200).trim(),
    };
    const password = field(request.body, 'password');
    const confirm = field(request.body, 'password_confirm');
    const fail = (error: string, status = 400) => send(reply, registerPage(ctx, config, { error, values }), status);

    if (!values.email || !values.email.includes('@')) return fail('Please enter a valid email address.');
    const length = codePoints(password);
    if (length < config.password_min_length || length > config.password_max_length) {
      return fail(`The password must be ${config.password_min_length} to ${config.password_max_length} characters long.`);
    }
    if (password !== confirm) return fail('The two passwords do not match.');

    const res = await api.register(
      { email: values.email, password, ...(values.display_name && { display_name: values.display_name }) },
      request.ip,
    );
    if (res.ok) return reply.redirect('/login?registered=1', 303);
    switch (res.status) {
      case 409:
        return fail('An account cannot be created with this email address. If you already have one, please sign in.', 409);
      case 403:
        return send(reply, registerPage(ctx, { ...config, registration_open: false }), 403);
      case 429:
        return fail('Too many attempts. Please wait a minute and try again.', 429);
      default:
        return fail('Please check the email address and password and try again.', 400);
    }
  });

  app.get('/login', async (request, reply) => {
    const ctx = await pageContext(request, reply);
    const registered = (request.query as Record<string, unknown>).registered === '1';
    return send(reply, loginPage(ctx, { notice: registered ? 'Your account has been created. Please sign in.' : undefined }));
  });

  app.post('/login', async (request, reply) => {
    if (rejectCsrf(request, reply)) return reply;
    const email = field(request.body, 'email', 320).trim();
    const password = field(request.body, 'password');
    const res = email && password ? await api.login({ email, password }, request.ip) : null;
    if (res?.ok) {
      reply.setCookie(SESSION_COOKIE, res.data.token, { ...cookieOptions, expires: new Date(res.data.expires_at) });
      csrfToken(request, reply, true); // new CSRF token for the new session
      return reply.redirect('/account', 303);
    }
    const ctx: PageContext = { me: null, csrf: csrfToken(request, reply) };
    if (res?.status === 429) {
      return send(reply, loginPage(ctx, { error: 'Too many attempts. Please wait a minute and try again.', email }), 429);
    }
    return send(reply, loginPage(ctx, { error: 'Invalid email or password.', email }), 401);
  });

  app.post('/logout', async (request, reply) => {
    if (rejectCsrf(request, reply)) return reply;
    const token = readSigned(request, SESSION_COOKIE);
    if (token) {
      try {
        await api.logout(token); // revokes the API token; a 401 means it was already invalid
      } catch (err) {
        request.log.warn({ err }, 'could not revoke the API token at logout');
      }
    }
    clearSession(reply);
    csrfToken(request, reply, true);
    return reply.redirect('/', 303);
  });

  app.get('/account', async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return reply.redirect('/login', 303);
    return send(reply, accountPage({ me: user.me, csrf: csrfToken(request, reply) }));
  });

  await app.ready();
  return app;
}

export type WebApp = Awaited<ReturnType<typeof buildWebApp>>;
