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
      /*
       * `server-only` throws unless resolved with Node's `react-server`
       * condition, which Vitest does not set — so without this every module that
       * imports it could only be tested by reading its source as text. The
       * guarantee it encodes is enforced by the Next build, which is a separate
       * gate, not by the test runner.
       */
      'server-only': fileURLToPath(new URL('./src/test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    /*
     * `.qa/` is the QA scratch area, and a run there sometimes leaves a whole
     * copy of the tree behind (`.qa/score-verify/`). Those copies carry their own
     * `*.test.ts` files, which the runner would otherwise collect — and because
     * the source-reading contract tests resolve their reads against `cwd`, a
     * stale copy asserts yesterday's expectations against today's source and
     * fails a gate that has nothing wrong with it. Scratch directories are not
     * test input; `.agents/**` is excluded for the same reason.
     */
    exclude: [...configDefaults.exclude, '.agents/**', '.qa/**'],
  },
});
