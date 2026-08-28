import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Guards the one property that makes a Supabase Custom Domain a configuration
 * change rather than a code change.
 *
 * Google's account chooser names the app by the host of the OAuth redirect URI
 * it was registered with. While that host is `<project-ref>.supabase.co`, the
 * consent screen reads "continue to <project-ref>.supabase.co" — an internal
 * identifier shown to every visitor at the most trust-sensitive moment of the
 * product. The fix is to point Supabase Auth at an owned domain and re-register
 * `https://auth.<owned-domain>/auth/v1/callback` with Google, which is entirely
 * an operator action (see `docs/auth/google-oauth-branding.md`).
 *
 * What the code has to guarantee is that the operator action is *enough*: that
 * swapping `NEXT_PUBLIC_SUPABASE_URL` moves every client, the CSP and the
 * scripts together, with no second place holding the old host. These tests fail
 * if anyone reintroduces a hard-coded project ref or builds a Supabase client
 * from a URL this env var does not control.
 */

// `git ls-files` rather than a directory walk: it is the set actually shipped,
// so `node_modules`, `.next` and untracked scratch files cannot fail the run.
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const sourceFiles = tracked.filter((path) => (
  /\.(ts|tsx|mjs|js)$/.test(path)
  && !path.includes('.test.')
  // This file documents the very literal it forbids elsewhere.
  && path !== 'src/config/env/supabase-host.test.ts'
));

const read = (path: string) => readFileSync(resolve(path), 'utf8');

/*
 * READ ONCE. The sweep below opens every shipped source file, and doing that
 * inside the case billed a whole-repository read to a single assertion about a
 * hostname — which is what "Test timed out in 5000ms" meant here, on a case that
 * passes in four seconds alone. The files cannot change while the suite runs, so
 * the read happens once, in the hook, and the case matches strings in memory.
 */
let shipped: Array<{ path: string; text: string }> | null = null;

const shippedSources = () => {
  shipped ??= sourceFiles.map((path) => ({ path, text: read(path) }));
  return shipped;
};

beforeAll(() => {
  shippedSources();
}, 120_000);

describe('Supabase auth host stays env-driven', () => {
  it('hard-codes no Supabase project host anywhere in shipped source', () => {
    const offenders = shippedSources()
      .filter(({ text }) => /[a-z0-9]{8,}\.supabase\.(co|in)/i.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('builds every Supabase client from NEXT_PUBLIC_SUPABASE_URL and nothing else', () => {
    // Every module that constructs a real client, browser and server alike.
    const constructionSites = [
      'src/lib/supabase/client.ts',
      'src/lib/supabase/server.ts',
      'src/lib/supabase/admin.ts',
      'src/lib/analytics/fundamentals/repository.ts',
      'src/lib/instruments/master.ts',
      'src/lib/instruments/search.ts',
      'src/lib/market-data/fx/repository.ts',
      'src/lib/market-data/gateway/symbol-resolver.ts',
      'middleware.ts',
    ];

    for (const path of constructionSites) {
      const source = read(path);
      expect(`${path}: ${source.includes('NEXT_PUBLIC_SUPABASE_URL')}`).toBe(`${path}: true`);
    }

    // Nothing outside that list may construct one, or a custom domain would
    // reach some requests and not others.
    const undeclared = sourceFiles.filter((path) => (
      !constructionSites.includes(path)
      && !path.startsWith('scripts/')
      && /create(Browser|Server)?Client(<[^>]*>)?\(\s*\n?\s*(clientEnv|process\.env|url|supabaseUrl)/.test(read(path))
    ));
    expect(undeclared).toEqual([]);
  });

  it('keeps the CSP connect-src pointed at whatever host the env names', () => {
    // A custom domain changes the origin the browser opens; a policy naming the
    // project host would block the swap with a CSP violation instead of a bug
    // anyone could read.
    const middleware = read('middleware.ts');
    expect(middleware).toContain('new URL(clientEnv.NEXT_PUBLIC_SUPABASE_URL)');
    expect(middleware).toContain('supabaseConnectSources()');
  });

  it('drives the operator scripts from the same variable name', () => {
    for (const path of tracked.filter((entry) => entry.startsWith('scripts/') && entry.endsWith('.ts'))) {
      const source = read(path);
      if (!source.includes('SUPABASE_URL')) continue;
      expect(`${path}: ${source.includes('NEXT_PUBLIC_SUPABASE_URL')}`).toBe(`${path}: true`);
    }
  });

  it('documents the custom-domain value in .env.example without committing a real ref', () => {
    const example = read('.env.example');
    expect(example).toContain('NEXT_PUBLIC_SUPABASE_URL=');
    expect(example).toMatch(/custom domain/i);
    expect(example).not.toMatch(/https:\/\/[a-z0-9]{8,}\.supabase\.co/i);
  });
});
