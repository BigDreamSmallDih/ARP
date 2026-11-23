import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{backend,packages,apps}/**/src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    environment: 'node',
  },
});
