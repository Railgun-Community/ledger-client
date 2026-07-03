import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['import', 'module', 'browser', 'default'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    globals: false,
    restoreMocks: true,
    typecheck: {
      enabled: true,
    },
  },
});
