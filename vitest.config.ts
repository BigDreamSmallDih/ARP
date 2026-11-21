import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{backend,packages,apps}/**/src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
