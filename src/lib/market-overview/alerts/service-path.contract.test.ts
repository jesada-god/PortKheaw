import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OV_ALERT_KINDS } from './types';

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

  /*
   * This asserted `toContain('NOT YET APPLIED')` and went red the day the
   * migration was applied and the header said so — the same shape as the
   * vacuity check in `supabase/migration-order.test.ts`: an assertion that fails
   * when the repository becomes correct, and therefore pushes back towards the
   * stale claim.
   *
   * What is worth pinning is not WHICH status the file carries but that it
   * carries one at all, in the machine-readable form. The grammar, the date and
   * the cross-file consistency are enforced in `migration-order.test.ts`; this
   * only refuses a header that has gone back to prose.
   */
  it('carries a machine-readable status header', () => {
    expect(migration(SERVICE)).toMatch(/^-- STATUS: (APPLIED|NOT YET APPLIED)$/m);
    expect(migration(SERVICE)).toMatch(/^-- VERIFIED: \d{4}-\d{2}-\d{2}, by .+\.$/m);
  });
});

/**
 * THE FIVE KINDS, READ OUT OF THE SQL AND COMPARED.
 *
 * `202608310001` widened `overview_alert_rules_kind_check` and
 * `overview_alert_hits.kind` to admit `earnings` and left
 * `create_overview_alert_rule` refusing it. The result was a kind that could be
 * stored, evaluated, cooled down and recorded — and created by nobody.
 *
 * Every layer above the database was already exhaustive over `OvAlertKind`:
 * `OV_ALERT_COOLDOWN_HOURS`, `OV_ALERT_UNIT` and `OV_ALERT_WORD` are all
 * `Record<OvAlertKind, …>` and would not compile if a kind were missing. That is
 * why nothing caught this — TypeScript cannot see a `plpgsql` list, and the
 * three SQL lists are only equal by somebody remembering.
 *
 * So they are compared here, out of the migration text, against the domain
 * union that the compiler does enforce.
 */
describe('the kinds a rule may have', () => {
  const RULES = '202608300001_overview_alerts.sql';
  const PARITY = '202608310003_overview_alert_rule_kind_parity.sql';

  /**
   * Every quoted value inside the first parenthesised list of a fragment.
   *
   * Each caller slices the file at the phrase that introduces its own list —
   * `kind text not null`, `add constraint …`, `input_kind not in` — so this only
   * has to read the group that follows. Written that way because the three
   * spellings differ (`kind in (…)` against `input_kind not in (…)`) and a
   * single regex over all of them was the first thing to get this wrong.
   */
  function kindsIn(fragment: string, label: string): string[] {
    const match = /\(([^)]*)\)/.exec(fragment);
    expect(match, `${label} must list its kinds`).not.toBeNull();
    const found = [...match![1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]);
    expect(found.length, `${label} must list at least one kind`).toBeGreaterThan(0);
    return found.sort();
  }

  const EXPECTED = [...OV_ALERT_KINDS].sort();

  /*
   * EACH SET IS READ FROM THE FILE THAT LAST DEFINED IT, NOT FROM THE FILE THAT
   * INTRODUCED IT.
   *
   * `202608300001` created the rules column with four kinds and `202608310001`
   * replaced that constraint with five; `202608300001` defined the writer with
   * four and `202608310003` replaces it with five. Reading either from the
   * earlier file asserts against a definition the database no longer has — true
   * of the text, false of the schema, which is the same mistake in miniature
   * that produced the drift this whole block is about.
   */
  const rulesColumn = () => kindsIn(
    code(migration(READER)).split('add constraint overview_alert_rules_kind_check')[1] ?? '',
    'overview_alert_rules.kind (as widened by 202608310001)',
  );
  const hitsColumn = () => kindsIn(
    code(migration(READER)).split('kind text not null')[1] ?? '',
    'overview_alert_hits.kind',
  );
  const writer = () => kindsIn(
    code(bodyOf(migration(PARITY), 'create_overview_alert_rule')).split('input_kind not in')[1] ?? '',
    'create_overview_alert_rule',
  );

  it('is the same set in the rules column, the hits column and the writer', () => {
    expect(rulesColumn()).toEqual(EXPECTED);
    expect(hitsColumn()).toEqual(EXPECTED);
    expect(writer()).toEqual(EXPECTED);
  });

  it('was four in the two places 202608300001 wrote it, which is the drift', () => {
    /*
     * The history, asserted so the two later migrations cannot be read as
     * gratuitous. `202608300001` is consistent WITH ITSELF at four; what broke
     * was that `202608310001` widened one of its two copies and not the other.
     */
    const original = code(migration(RULES));
    expect(kindsIn(original.split('kind text not null')[1] ?? '', 'the original column'))
      .toEqual(['percent_down', 'percent_up', 'price_above', 'price_below']);
    expect(kindsIn(
      code(bodyOf(original, 'create_overview_alert_rule')).split('input_kind not in')[1] ?? '',
      'the original writer',
    )).toEqual(['percent_down', 'percent_up', 'price_above', 'price_below']);
  });

  it('is widened on the rules column by the migration that widened the hits one', () => {
    // `202608310001` alters `overview_alert_rules_kind_check` as well as
    // creating the hits table. Dropping that alter would leave the column on
    // four while the writer accepts five — the same defect, mirrored.
    expect(code(migration(READER))).toContain('overview_alert_rules_kind_check');
    expect(rulesColumn()).toEqual(EXPECTED);
  });

  it('leaves the writer able to create every kind the feature defines', () => {
    /*
     * The claim in product terms, stated separately from the set comparison
     * above so a failure says which kind was lost rather than printing two
     * sorted arrays.
     */
    const kinds = writer();
    for (const kind of OV_ALERT_KINDS) {
      expect(kinds, `${kind} must be creatable`).toContain(kind);
    }
  });

  it('keeps the cap and the lock that only live inside the writer', () => {
    // `create or replace` is a whole-body replacement, so a step dropped in
    // `202608310003` is a step dropped in production. RLS permits a direct
    // insert, so neither of these is enforced anywhere else.
    const writer = code(bodyOf(migration(PARITY), 'create_overview_alert_rule'));
    expect(writer).toContain('pg_advisory_xact_lock');
    expect(writer).toContain('existing_count >= 50');
    expect(writer).toContain("errcode = '54000'");
    expect(writer).toContain('auth.uid()');
    // The owner comes from the session, never from an argument.
    expect(writer).toContain('values (requesting_user');
    expect(writer).not.toContain('on conflict');
  });
});
