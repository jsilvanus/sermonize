import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve @sermonize/api to its TypeScript sources (the "@sermonize/source" export condition), so the
  // tests run the real API without a prior build of packages/api.
  resolve: { conditions: ['@sermonize/source'] },
  ssr: { resolve: { conditions: ['@sermonize/source'], externalConditions: ['@sermonize/source'] } },
  test: {
    include: ['test/**/*.test.ts'],
    // Applies pending API migrations to the shared test database; never drops anything.
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
