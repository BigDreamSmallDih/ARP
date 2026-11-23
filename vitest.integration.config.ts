import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{backend,packages}/**/src/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
