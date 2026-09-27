import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Resets the test database schemas and applies migrations once per run.
    globalSetup: ['test/global-setup.ts'],
    // All test files share one database: run them one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
