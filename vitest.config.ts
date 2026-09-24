import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'fixtures/**', '.factory-test-repos/**'],
    // Builds dist/ once for the files whose child processes import it.
    globalSetup: ['./test/globalSetup.ts'],
    // Integration tests shell out to git and npm; the default 5s is too tight.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Safe to parallelise: the toy-repo helper mkdtemps a fresh directory per
    // call, so files sharing the scratch root never touch the same repo.
    fileParallelism: true,
    reporters: ['default'],
  },
});
