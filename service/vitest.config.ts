import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is src/client.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    root: '.',
    include: ['test/**/*.test.ts', 'src/client/**/*.test.tsx'],
    testTimeout: 20_000,
  },
});
