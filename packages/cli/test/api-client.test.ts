import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api-client.js';

/** Records the URLs the client fetches and answers `{}`. */
function recordingFetch(urls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('ApiClient URLs', () => {
  it('keeps the path of a base URL behind a reverse proxy (https://example.org/api)', async () => {
    const urls: string[] = [];
    const client = new ApiClient('https://example.org/api', 'sz_test', recordingFetch(urls));
    await client.request('GET', '/me');
    await client.request('GET', '/admin/users?limit=5');
    await client.request('POST', '/auth/login', { email: 'a@example.org' }, { auth: false });
    expect(urls).toEqual([
      'https://example.org/api/me',
      'https://example.org/api/admin/users?limit=5',
      'https://example.org/api/auth/login',
    ]);
  });

  it('works with a base URL at the root', async () => {
    const urls: string[] = [];
    await new ApiClient('http://127.0.0.1:3000', 'sz_test', recordingFetch(urls)).request('GET', '/stats');
    expect(urls).toEqual(['http://127.0.0.1:3000/stats']);
  });
});
