/**
 * Configuration, and the single-domain deployment: MCP_PUBLIC_URL may be a site's root origin that
 * the MCP server shares with the web UI and the API behind a reverse proxy (only /mcp, /oauth/* and
 * /.well-known/oauth-* are routed to it). The discovery metadata must then point at that origin.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildMcpApp } from '../src/app.js';
import { loadConfig, parsePublicUrl, parseTrustProxy } from '../src/config.js';

const baseEnv = {
  JWT_SECRET: randomBytes(32).toString('base64'),
  SERMONIZE_API_URL: 'http://127.0.0.1:3000',
  SERMONIZE_TOKEN_KEY: randomBytes(32).toString('base64'),
};

describe('loadConfig', () => {
  it('needs no MCP user settings; TRUST_PROXY has the API semantics', () => {
    const config = loadConfig(baseEnv);
    expect(config.publicUrl).toBe('http://localhost:5999');
    expect(config.trustProxy).toBe(false);
    expect(config).not.toHaveProperty('defaultUser');
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('127.0.0.1,172.18.0.1')).toBe('127.0.0.1,172.18.0.1');
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: '127.0.0.1' }).trustProxy).toBe('127.0.0.1');
  });

  it('MCP_PUBLIC_URL is an origin', () => {
    expect(parsePublicUrl('https://example.org')).toBe('https://example.org');
    expect(parsePublicUrl('https://example.org/')).toBe('https://example.org');
    expect(parsePublicUrl('http://localhost:5999')).toBe('http://localhost:5999');
    for (const bad of ['https://example.org/mcp', 'https://example.org/?a=1', 'ftp://example.org', 'example.org', 'https://u:p@example.org']) {
      expect(() => parsePublicUrl(bad), bad).toThrow(/MCP_PUBLIC_URL/);
    }
  });
});

describe('same-origin deployment (MCP_PUBLIC_URL=https://example.org)', () => {
  it('serves discovery metadata for resource https://example.org/mcp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sermonize-mcp-config-'));
    const config = loadConfig({ ...baseEnv, MCP_PUBLIC_URL: 'https://example.org/', STORAGE_PATH: join(dir, 'app.sqlite') });
    const app = await buildMcpApp(config, { sweepIntervalMs: 0 });
    try {
      const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();
      const resource = {
        resource: 'https://example.org/mcp',
        authorization_servers: ['https://example.org'],
        scopes_supported: ['mcp'],
        bearer_methods_supported: ['header'],
      };
      expect(await get('/.well-known/oauth-protected-resource/mcp')).toEqual(resource);
      expect(await get('/.well-known/oauth-protected-resource')).toEqual(resource);
      const as = await get('/.well-known/oauth-authorization-server');
      expect(as).toMatchObject({
        issuer: 'https://example.org',
        authorization_endpoint: 'https://example.org/oauth/authorize',
        token_endpoint: 'https://example.org/oauth/token',
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: true,
      });
      expect(await get('/.well-known/openid-configuration')).toEqual(as);

      const challenge = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
      expect(challenge.statusCode).toBe(401);
      expect(challenge.headers['www-authenticate']).toBe(
        'Bearer resource_metadata="https://example.org/.well-known/oauth-protected-resource/mcp", scope="mcp"',
      );

      // Every route lives under /mcp, /oauth/, /.well-known/ or /health, so a proxy can route by prefix.
      const routes = app.printRoutes({ commonPrefix: false });
      const paths = [...routes.matchAll(/^[│├└─\s]*(\/\S*)/gm)].map((m) => m[1]!);
      expect(paths.length).toBeGreaterThan(5);
      for (const path of paths) expect(path, path).toMatch(/^\/(mcp|oauth\/|\.well-known\/|health)/);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
