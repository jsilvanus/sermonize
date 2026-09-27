import type { AuthConfig, Me, Stats } from './api-client.js';
import { html, type Html } from './html.js';

export interface PageContext {
  /** The signed-in user, if any (from GET /me). */
  me: Me | null;
  /** CSRF token for the forms on this page. */
  csrf: string;
}

const numberFormat = new Intl.NumberFormat('en-US');
const n = (value: number) => numberFormat.format(value);

const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });
function languageName(tag: string): string {
  try {
    const name = LANGUAGE_NAMES.of(tag);
    return name && name !== tag ? name : tag;
  } catch {
    return tag;
  }
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
  reader: 'You can read public records and search public text passages.',
  contributor: 'You can also read restricted texts and add scholarly records and derived data.',
  curator: 'You can also edit and withdraw records and review cluster labels.',
  admin: 'You can also manage users and API tokens.',
};

export function csrfField(csrf: string): Html {
  return html`<input type="hidden" name="_csrf" value="${csrf}">`;
}

export function layout(title: string, ctx: PageContext, content: Html): Html {
  const nav = ctx.me
    ? html`<li><a href="/account">Account</a></li>
        <li><form method="post" action="/logout">${csrfField(ctx.csrf)}<button type="submit" class="link">Sign out</button></form></li>`
    : html`<li><a href="/login">Sign in</a></li><li><a href="/register">Register</a></li>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title === 'Sermonize' ? title : `${title} · Sermonize`}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site"><div class="inner">
<a class="brand" href="/">Sermonize</a>
<nav aria-label="Main"><ul>${nav}</ul></nav>
</div></header>
<main id="main">
${content}
</main>
<footer class="site"><p>Sermonize: a multilingual corpus of sermons and historical Christian texts for semantic research.</p></footer>
</body>
</html>
`;
}

function message(kind: 'error' | 'ok', text: string | null | undefined): Html {
  if (!text) return html``;
  return kind === 'error'
    ? html`<p class="msg error" role="alert">${text}</p>`
    : html`<p class="msg ok" role="status">${text}</p>`;
}

export function landingPage(ctx: PageContext, stats: Stats): Html {
  const languages = Object.entries(stats.texts_by_language).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const tile = (key: string, label: string, value: number) =>
    html`<div><dt>${label}</dt><dd data-stat="${key}">${n(value)}</dd></div>`;
  const account = ctx.me
    ? html`<p>You are signed in as a <strong>${ctx.me.role}</strong>. <a href="/account">View your account</a>.</p>`
    : html`<p><a href="/login">Sign in</a> or <a href="/register">create an account</a>.</p>`;
  return layout(
    'Sermonize',
    ctx,
    html`<h1>Sermonize</h1>
<p class="lead">A multilingual corpus of sermons and historical Christian texts, with passages, embeddings and clusters for semantic research.</p>
${account}
<h2>The corpus in numbers</h2>
<dl class="stats">
${tile('works', 'Works', stats.works)}
${tile('sermons', 'Sermons', stats.sermons)}
${tile('texts', 'Texts', stats.texts)}
${tile('persons', 'Persons', stats.persons)}
${tile('chunks', 'Text passages', stats.chunks)}
${tile('embedding_spaces', 'Embedding spaces', stats.embedding_spaces)}
${tile('complete_clustering_runs', 'Clustering runs', stats.complete_clustering_runs)}
</dl>
<h2>Texts by language</h2>
${
  languages.length === 0
    ? html`<p>No texts yet.</p>`
    : html`<table><thead><tr><th scope="col">Language</th><th scope="col">Code</th><th scope="col" class="num">Texts</th></tr></thead>
<tbody>${languages.map(
        ([tag, count]) =>
          html`<tr data-language="${tag}"><td>${languageName(tag)}</td><td><code>${tag}</code></td><td class="num">${n(count)}</td></tr>`,
      )}</tbody></table>`
}`,
  );
}

export interface RegisterForm {
  email?: string;
  display_name?: string;
}

export function registerPage(
  ctx: PageContext,
  config: AuthConfig,
  opts: { error?: string | undefined; values?: RegisterForm } = {},
): Html {
  if (!config.registration_open) {
    return layout(
      'Register',
      ctx,
      html`<h1>Register</h1>
<p>Registration is closed. Please ask the Sermonize administrators for an account.</p>
<p>Already have an account? <a href="/login">Sign in</a>.</p>`,
    );
  }
  const v = opts.values ?? {};
  return layout(
    'Register',
    ctx,
    html`<h1>Create an account</h1>
${message('error', opts.error)}
<form class="stack" method="post" action="/register" novalidate>
${csrfField(ctx.csrf)}
<div><label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required maxlength="320" value="${v.email ?? ''}"></div>
<div><label for="display_name">Name <span class="hint">Optional. Never shown publicly.</span></label>
<input id="display_name" name="display_name" type="text" autocomplete="name" maxlength="200" value="${v.display_name ?? ''}"></div>
<div><label for="password">Password <span class="hint" id="password-hint">${config.password_min_length} to ${config.password_max_length} characters.</span></label>
<input id="password" name="password" type="password" autocomplete="new-password" required minlength="${config.password_min_length}" maxlength="${config.password_max_length}" aria-describedby="password-hint"></div>
<div><label for="password_confirm">Repeat password</label>
<input id="password_confirm" name="password_confirm" type="password" autocomplete="new-password" required></div>
<div><button type="submit">Create account</button></div>
</form>
<p>Already have an account? <a href="/login">Sign in</a>.</p>`,
  );
}

export function loginPage(
  ctx: PageContext,
  opts: { error?: string | undefined; notice?: string | undefined; email?: string | undefined } = {},
): Html {
  return layout(
    'Sign in',
    ctx,
    html`<h1>Sign in</h1>
${message('ok', opts.notice)}
${message('error', opts.error)}
<form class="stack" method="post" action="/login">
${csrfField(ctx.csrf)}
<div><label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required maxlength="320" value="${opts.email ?? ''}"></div>
<div><label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required></div>
<div><button type="submit">Sign in</button></div>
</form>
<p>No account yet? <a href="/register">Register</a>.</p>`,
  );
}

export function accountPage(ctx: PageContext & { me: Me }): Html {
  const { me } = ctx;
  return layout(
    'Account',
    ctx,
    html`<h1>Your account</h1>
<div class="card"><dl class="facts">
<dt>User id</dt><dd><code data-field="user_id">${me.user_id}</code></dd>
<dt>Role</dt><dd data-field="role">${me.role}</dd>
<dt>Kind</dt><dd>${me.kind}</dd>
</dl></div>
<p>${ROLE_DESCRIPTIONS[me.role] ?? ''}</p>
<p>Sermonize stores your email and name separately from all research data; records you create are attributed to your user id only.</p>
<form method="post" action="/logout">${csrfField(ctx.csrf)}<button type="submit">Sign out</button></form>`,
  );
}

export function errorPage(ctx: PageContext, title: string, text: string): Html {
  return layout(title, ctx, html`<h1>${title}</h1><p>${text}</p><p><a href="/">Back to the start page</a></p>`);
}
