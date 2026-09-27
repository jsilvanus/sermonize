import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, parsePublicBasePath } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createTestPool, setupTestApp, type TestContext } from './helpers.js';

// PUBLIC_BASE_PATH: the API behind a reverse proxy that publishes it under a prefix (nginx
// `location /api/ { proxy_pass http://api:3000/; }`). Routes stay at the root; only the OpenAPI
// `servers` entry and the Swagger UI asset URLs carry the prefix.

describe('PUBLIC_BASE_PATH parsing', () => {
  it('defaults to the root and normalises a trailing slash', () => {
    expect(parsePublicBasePath(undefined)).toBe('');
    expect(parsePublicBasePath('')).toBe('');
    expect(parsePublicBasePath('/')).toBe('');
    expect(parsePublicBasePath('/api')).toBe('/api');
    expect(parsePublicBasePath('/api/')).toBe('/api');
    expect(parsePublicBasePath('/sermonize/api')).toBe('/sermonize/api');
    expect(loadConfig({ DATABASE_URL: 'postgres://x' }).publicBasePath).toBe('');
    expect(loadConfig({ DATABASE_URL: 'postgres://x', PUBLIC_BASE_PATH: '/api/' }).publicBasePath).toBe('/api');
  });

  it('refuses anything but a plain absolute path', () => {
    for (const bad of ['api', 'https://example.org/api', '/api?x=1', '/api#x', '/a b', '//api', '/api/../x', '/./api', '/api"']) {
      expect(() => parsePublicBasePath(bad), bad).toThrow(/PUBLIC_BASE_PATH/);
    }
  });
});

describe('OpenAPI behind a path prefix', () => {
  let root: TestContext;
  let prefixed: TestContext;

  beforeAll(async () => {
    root = await setupTestApp();
    prefixed = await setupTestApp({ publicBasePath: '/api/' });
  });
  afterAll(async () => {
    await root.close();
    await prefixed.close();
  });

  it('without a base path: no servers entry, root-relative asset URLs (unchanged behaviour)', async () => {
    const doc = (await root.app.inject({ method: 'GET', url: '/docs/json' })).json();
    expect(doc.servers).toBeUndefined();
    const html = (await root.app.inject({ method: 'GET', url: '/docs' })).body;
    expect(html).toContain('href="/docs/static/swagger-ui.css"');
    expect(html).toContain('src="/docs/static/swagger-ui-bundle.js"');
  });

  it('with /api: servers is /api, assets under /api/docs/static, routes still at the root', async () => {
    const { app } = prefixed;
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.servers).toEqual([{ url: '/api', description: expect.any(String) }]);
    expect(doc.paths['/health']).toBeDefined(); // paths are relative to the server URL
    expect(Object.keys(doc.paths).some((p) => p.startsWith('/api'))).toBe(false);

    const ui = await app.inject({ method: 'GET', url: '/docs' });
    expect(ui.statusCode).toBe(200);
    expect(ui.body).toContain('href="/api/docs/static/swagger-ui.css"');
    expect(ui.body).toContain('src="/api/docs/static/swagger-ui-bundle.js"');
    expect(ui.body).toContain('src="/api/docs/static/swagger-initializer.js"');
    expect(ui.body).not.toMatch(/(href|src)="\/docs\//);
    // With a trailing slash the page uses relative URLs, which work with or without a prefix.
    expect((await app.inject({ method: 'GET', url: '/docs/' })).body).toContain('href="./static/swagger-ui.css"');

    // The assets themselves are served at the (proxy-stripped) root paths.
    expect((await app.inject({ method: 'GET', url: '/docs/static/swagger-ui.css' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/docs/static/swagger-initializer.js' })).body).toContain("resolveUrl('./json')");
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).not.toBe(200); // no /api routes
  });

  it('refuses an invalid base path at startup', async () => {
    const pool = createTestPool();
    try {
      await expect(buildApp({ pool, publicBasePath: 'api' })).rejects.toThrow(/PUBLIC_BASE_PATH/);
    } finally {
      await pool.end();
    }
  });
});
