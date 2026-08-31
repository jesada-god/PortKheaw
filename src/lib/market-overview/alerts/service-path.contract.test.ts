import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE SERVICE PATH, ASSERTED AGAINST THE SQL RATHER THAN AGAINST A DOUBLE.
 *
 * The defect this file exists to prevent cannot be reached from TypeScript. A
 * `security definer` function that resolves `auth.uid()` typechecks fine, passes
 * every mocked test, and then raises 42501 on every write the moment a cron
 * calls it with the service role — because there is no session there for
 * `auth.uid()` to return.
 *
 * That is exactly what `record_overview_alert_hit` does, correctly, for the
 * surface it was written for. So the sweep gets a second function, and the
 * properties that make it a SERVICE function are the ones scanned here.
 */

const migration = (name: string) => readFileSync(
  new URL(`../../../../supabase/migrations/${name}`, import.meta.url),
  'utf8',
);

const SERVICE = '202608310002_overview_alert_hit_service.sql';
const READER = '202608310001_overview_alert_hits.sql';

/** The body of one `create or replace function`, without the surrounding file. */
function bodyOf(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  const end = sql.indexOf('$$;', start);
  expect(end, `${name} must be terminated`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

/** Comments are prose about the rule; only executable SQL is scanned. */
function code(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('the service-role hit function', () => {
  const sql = migration(SERVICE);
  const body = code(bodyOf(sql, 'record_overview_alert_hit_service'));

  it('never reads auth.uid()', () => {
    /*
      The whole point. Under the service role there is no session, so this would
      be null and the function would raise on every write — silently turning a
      scheduled sweep into a scheduled no-op.
    */
    expect(body).not.toContain('auth.uid()');
  });

  it('derives the owner from the rule row, the way trigger_price_alert_service does', () => {
    expect(body).toContain('select * into owned_rule from public.overview_alert_rules');
    expect(body).toContain('for update');
    // The inserted user_id is the ROW's, never an argument.
    expect(body).toContain('owned_rule.user_id');
    expect(body).not.toMatch(/input_user_id/);
  });

  it('is granted to service_role and to nobody else', () => {
    const grants = code(sql);
    expect(grants).toMatch(
      /revoke all on function public\.record_overview_alert_hit_service\([^)]*\)\s*from public, anon, authenticated;/,
    );
    expect(grants).toMatch(
      /grant execute on function public\.record_overview_alert_hit_service\([^)]*\)\s*to service_role;/,
    );
    // Never to a reader. That grant is what would let a signed-in caller write
    // a hit into an account the request never proved it owned.
    expect(grants).not.toMatch(
      /grant execute on function public\.record_overview_alert_hit_service\([^)]*\)\s*to authenticated;/,
    );
  });

  it('keeps the write and the stamp in one body, under the same lock', () => {
    /*
      Inseparable in both directions: a hit without a stamp leaves the rule
      permanently out of cooldown and it fires again every fifteen minutes
      forever; a stamp without a hit silences an alert nobody was told about.
    */
    expect(body).toContain('pg_advisory_xact_lock');
    expect(body).toContain('insert into public.overview_alert_hits');
    expect(body).toContain('update public.overview_alert_rules');
    expect(body).toContain('last_fired_at');
    // The stamp runs only when a row was actually written.
    expect(body).toMatch(/if result_id is not null then[\s\S]*update public\.overview_alert_rules/);
  });

  it('refuses a rule that is disabled or gone, without raising', () => {
    // A scheduler is not a person to show an error to, and a rule switched off
    // mid-sweep is an ordinary outcome. Null, exactly as trigger_price_alert_service.
    expect(body).toContain('enabled = true');
    expect(body).toMatch(/if not found then return null; end if;/);
  });
});

describe('the reader function it sits beside', () => {
  it('is left exactly as it was, still on auth.uid()', () => {
    /*
      Two functions, two threat models. The reader's version must keep resolving
      the caller itself — an id it accepted would be an id a signed-in caller
      could substitute.
    */
    const body = code(bodyOf(migration(READER), 'record_overview_alert_hit'));
    expect(body).toContain('auth.uid()');
    expect(body).toContain("raise exception 'Authentication required'");
  });

  it('is not dropped, replaced or re-granted by the service migration', () => {
    const service = code(migration(SERVICE));
    expect(service).not.toMatch(/drop function[^;]*record_overview_alert_hit\s*\(/);
    // `create or replace` on the reader's name would silently redefine it.
    expect(service).not.toContain('create or replace function public.record_overview_alert_hit(');
  });

  it('cannot collide with it as an overload', () => {
    /*
      Postgres overloads on (name, argument types), so a distinct name cannot
      collide however similar the parameters are — which is what lets both
      callers pass the identical argument object. Asserted because the failure
      would be a runtime "function is not unique", not a compile error.
      */
    const service = code(migration(SERVICE));
    const created = [...service.matchAll(/create or replace function public\.(\w+)\(/g)]
      .map((match) => match[1]);
    expect(created).toEqual(['record_overview_alert_hit_service']);
    expect(created).not.toContain('record_overview_alert_hit');
  });
});

describe('the migration order', () => {
  it('follows the table it writes to', () => {
    // It depends on `overview_alert_hits` and on `last_fired_at`, both created
    // by 202608310001. Filename order is the only thing that guarantees it.
    expect(SERVICE > READER).toBe(true);
  });

  it('is still unapplied, and says so', () => {
    expect(migration(SERVICE)).toContain('NOT YET APPLIED');
  });
});
