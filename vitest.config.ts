import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Components ship without a React import (Next compiles JSX with the automatic
  // runtime); tests must transform them the same way or every JSX file throws
  // "React is not defined" under Vitest.
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, '.agents/**'],
  },
});
