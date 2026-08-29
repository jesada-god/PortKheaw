import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEV_ENV_FILE,
  PRODUCTION_PROJECT_REFS,
  ProductionTargetError,
  assertNotProduction,
  assertNotProductionDatabaseUrl,
  knownProductionRefs,
  projectRefOf,
  projectRefOfConnectionString,
  readEnvFile,
  resolveDevSupabaseTarget,
} from './db-target';

/**
 * THE TEST THAT IS SUPPOSED TO GO RED IF SOMEBODY REMOVES THE GUARD.
 *
 * Everything here is written against that one property. Weakening
 * `db-target.ts` in any of the ways it would plausibly be weakened —
 * returning a boolean instead of throwing, emptying the ref list, letting an
 * unrecognised url through, adding an override flag, or dropping the call from
 * a script — fails at least one assertion below.
 *
 * The call-site block at the bottom is the half people forget: a guard that is
 * perfect and uncalled protects nothing, so the scripts that write to a
 * database are read as source and checked for the call.
 */

const PRODUCTION_URL = 'https://jjmenqktnabmajpqxzhr.supabase.co';
const DEV_URL = 'https://vhhjdzcjczqmvjrgrrom.supabase.co';

describe('production guard — it refuses, it does not warn', () => {
  it('THROWS on the production project rather than returning anything', () => {
    expect(() => assertNotProduction(PRODUCTION_URL, 'probe')).toThrow(ProductionTargetError);
  });

  /*
   * The distinction the whole module exists for. A guard that answered with a
   * value would let a caller drop the `if` and keep running, so this asserts
   * that the safe path yields NOTHING usable as permission.
   */
  it('returns undefined on the safe path, so there is no boolean to ignore', () => {
    expect(assertNotProduction(DEV_URL, 'probe')).toBeUndefined();
  });

  it('names the project and the script in the refusal', () => {
    try {
      assertNotProduction(PRODUCTION_URL, 'npm run probe:watchlist-rls');
      throw new Error('guard did not throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('PRODUCTION');
      expect(message).toContain('jjmenqktnabmajpqxzhr');
      expect(message).toContain('probe:watchlist-rls');
    }
  });

  it('keeps the production ref listed', () => {
    // Emptying the list is the cheapest way to disable the guard. This notices.
    expect(PRODUCTION_PROJECT_REFS).toContain('jjmenqktnabmajpqxzhr');
    expect(knownProductionRefs().has('jjmenqktnabmajpqxzhr')).toBe(true);
  });

  it('lets the development project through', () => {
    expect(() => assertNotProduction(DEV_URL, 'probe')).not.toThrow();
  });
});

describe('production guard — fails closed', () => {
  it.each([
    ['no url', undefined],
    ['empty string', ''],
    ['not a url', 'production'],
    ['not supabase', 'https://example.com'],
    ['a bare hostname', 'jjmenqktnabmajpqxzhr'],
  ])('refuses %s rather than treating it as safe', (_label, value) => {
    expect(() => assertNotProduction(value as string | undefined, 'probe')).toThrow(ProductionTargetError);
  });

  /*
   * One database, several spellings. Comparing whole url strings would call two
   * of these safe, which is the failure mode that makes ref comparison the rule.
   */
  it.each([
    'https://jjmenqktnabmajpqxzhr.supabase.co',
    'https://jjmenqktnabmajpqxzhr.supabase.co/',
    'https://JJMENQKTNABMAJPQXZHR.supabase.co',
    '  https://jjmenqktnabmajpqxzhr.supabase.co  ',
    'https://jjmenqktnabmajpqxzhr.supabase.co/rest/v1',
  ])('recognises %s as the same production database', (url) => {
    expect(() => assertNotProduction(url, 'probe')).toThrow(ProductionTargetError);
  });

  it('reads a project ref out of a url, and nothing out of a non-url', () => {
    expect(projectRefOf(DEV_URL)).toBe('vhhjdzcjczqmvjrgrrom');
    expect(projectRefOf('https://example.com')).toBeNull();
    expect(projectRefOf(null)).toBeNull();
  });

  it('treats a missing env file as empty rather than throwing', () => {
    expect(readEnvFile('.env.does-not-exist')).toEqual({});
  });
});

describe('production guard — postgres connection strings', () => {
  it('reads the ref out of a direct database host', () => {
    expect(projectRefOfConnectionString('postgresql://postgres:pw@db.vhhjdzcjczqmvjrgrrom.supabase.co:5432/postgres'))
      .toBe('vhhjdzcjczqmvjrgrrom');
  });

  /*
   * The pooler hides the project in the USERNAME — the host is shared
   * infrastructure. This is the exact shape of `supabase/.temp/pooler-url`, the
   * production connection string that exists on any machine that has linked the
   * CLI, so it is the one a guard most needs to catch.
   */
  it('catches the production POOLER string, where the ref is in the username', () => {
    const pooler = 'postgresql://postgres.jjmenqktnabmajpqxzhr:pw@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres';
    expect(projectRefOfConnectionString(pooler)).toBe('jjmenqktnabmajpqxzhr');
    expect(() => assertNotProductionDatabaseUrl(pooler, 'db:apply')).toThrow(ProductionTargetError);
  });

  it('catches the production direct database host', () => {
    expect(() => assertNotProductionDatabaseUrl(
      'postgresql://postgres:pw@db.jjmenqktnabmajpqxzhr.supabase.co:5432/postgres', 'db:apply',
    )).toThrow(ProductionTargetError);
  });

  it('lets the development database through', () => {
    expect(() => assertNotProductionDatabaseUrl(
      'postgresql://postgres:pw@db.vhhjdzcjczqmvjrgrrom.supabase.co:5432/postgres', 'db:apply',
    )).not.toThrow();
  });

  it.each([
    ['no url', undefined],
    ['not a connection string', 'https://db.vhhjdzcjczqmvjrgrrom.supabase.co'],
    ['a non-supabase postgres', 'postgresql://postgres:pw@localhost:5432/postgres'],
    ['a pooler with no project in the user', 'postgresql://postgres:pw@aws-1.pooler.supabase.com:5432/postgres'],
  ])('refuses %s rather than treating it as safe', (_label, value) => {
    expect(() => assertNotProductionDatabaseUrl(value as string | undefined, 'db:apply'))
      .toThrow(ProductionTargetError);
  });

  it('resolves the API host and the database host of one project to the same ref', () => {
    expect(projectRefOf('https://vhhjdzcjczqmvjrgrrom.supabase.co'))
      .toBe(projectRefOf('https://db.vhhjdzcjczqmvjrgrrom.supabase.co'));
  });
});

describe('production guard — no way around it', () => {
  /*
   * An override flag is the same hole with a friendlier name: the moment
   * somebody reaches for it is the moment they are wrong about which database
   * they are pointed at. This asserts the source offers none.
   */
  it('exposes no override, force or skip switch', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/dev/db-target.ts'), 'utf8');
    for (const escape of ['FORCE', 'ALLOW_PRODUCTION', 'SKIP_GUARD', 'DANGEROUSLY', 'process.env.FORCE']) {
      expect(source, escape).not.toContain(escape);
    }
  });

  it('does not let the process environment override the dev file', () => {
    /*
     * A shell with production still exported is the realistic accident. The
     * file wins, so the run is a dev run — and if the file were ever absent the
     * guard would then see the production value from the environment and refuse.
     */
    const target = resolveDevSupabaseTarget('probe', {
      NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_URL,
      SUPABASE_SERVICE_ROLE_KEY: 'leftover',
    } as unknown as NodeJS.ProcessEnv);
    expect(target.projectRef).not.toBe('jjmenqktnabmajpqxzhr');
  });

  it('refuses when only the environment names a target and it is production', () => {
    /*
     * Proven by pointing the resolver at a machine with no `.env.test`: this is
     * the CI shape, and the answer must be a refusal rather than a run.
     */
    const source = readFileSync(resolve(process.cwd(), 'src/lib/dev/db-target.ts'), 'utf8');
    // The guard runs over the RESOLVED url, after the file/env merge, not before.
    const resolver = source.slice(source.indexOf('export function resolveDevSupabaseTarget'));
    expect(resolver.indexOf('assertNotProduction')).toBeGreaterThan(resolver.indexOf('const url ='));
    expect(resolver.indexOf('assertNotProduction')).toBeLessThan(resolver.indexOf('return {'));
  });
});

/**
 * The half a guard module cannot check about itself.
 *
 * These read the scripts that write to a database and assert the call is
 * present. Deleting the guard from a script is otherwise invisible: the script
 * keeps working, against whatever it was pointed at.
 */
describe('production guard — every writing script calls it', () => {
  const writingScripts = ['scripts/probe-watchlist-rls.ts', 'scripts/apply-migrations.ts'];

  it.each(writingScripts)('%s imports and calls the guard before connecting', (file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    expect(source, `${file} must import the guard`).toContain('db-target');
    expect(source, `${file} must resolve its target through the guard`)
      .toMatch(/resolveDevSupabaseTarget|assertNotProduction/);
    /*
     * And it must not build a client from a raw environment variable, which is
     * how a guarded script quietly grows a second, unguarded connection.
     */
    expect(source, `${file} must not read the url straight from the environment`)
      .not.toMatch(/createClient\(\s*process\.env/);
  });

  /*
   * The npm script matters as much as the source. `--env-file-if-exists=.env.local`
   * loads PRODUCTION credentials into the process before the script starts —
   * the guard still refuses, because the file target wins over the environment,
   * but it means a production service-role key is sitting in the environment of
   * a process that is about to write to a database. There is no reason for it
   * to be there.
   */
  it('loads the dev env file, never the production one, in every writing npm script', () => {
    expect(DEV_ENV_FILE).toBe('.env.test');
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const [name, command] of Object.entries(pkg.scripts)) {
      const touchesDb = writingScripts.some((file) => command.includes(file.replace('scripts/', '')));
      if (!touchesDb) continue;
      expect(command, `${name} must not load .env.local`).not.toContain('.env.local');
      expect(command, `${name} must load ${DEV_ENV_FILE}`).toContain(DEV_ENV_FILE);
    }
  });

  it('points every npm script it declares at a file that exists', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const file of writingScripts) {
      expect(() => readFileSync(resolve(process.cwd(), file), 'utf8'), file).not.toThrow();
    }
    for (const [name, command] of Object.entries(pkg.scripts)) {
      const referenced = command.match(/scripts\/[\w.-]+\.m?ts/)?.[0];
      if (!referenced) continue;
      expect(() => readFileSync(resolve(process.cwd(), referenced), 'utf8'), `${name} -> ${referenced}`)
        .not.toThrow();
    }
  });
});
