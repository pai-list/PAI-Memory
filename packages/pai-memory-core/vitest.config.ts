import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 10000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: {
      '@pai/memory-core': resolve(__dirname, 'src'),
    },
  },
});