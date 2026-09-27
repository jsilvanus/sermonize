import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve @sermonize/api to its TypeScript sources (the "@sermonize/source" export condition), so the
  // integration test does not depend on a prior build of packages/api.
  resolve: { conditions: ['@sermonize/source'] },
  ssr: { resolve: { conditions: ['@sermonize/source'], externalConditions: ['@sermonize/source'] } },
  test: {
    include: ['test/**/*.test.ts'],
    // Applies pending API migrations to the test database. Unlike the API suite it never drops
    // anything: MCP tests only add their own rows (see test/global-setup.ts).
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
