import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AN INSTRUMENT IS A SYMBOL, AND THE SQL HAS TO KEEP AGREEING.
 *
 * ===========================================================================
 * THE DEFECT THIS GUARDS
 * ===========================================================================
 * `market_instruments` was keyed on `(provider, provider_symbol)` and every
 * join and deactivation in `finalize_market_instrument_sync` was scoped
 * `where i.provider = run_record.provider`. The table was partitioned by
 * vendor, and nothing said so — it was invisible for as long as the sync wrote
 * one constant provider string.
 *
 * It stopped being invisible the moment the sync recorded the provider that
 * actually answered: the first fallback run inserted a second full universe
 * beside the first rather than replacing it. Dev went to 25,272 rows with every
 * symbol twice.
 *
 * ===========================================================================
 * WHY THIS IS A SOURCE TEST
 * ===========================================================================
 * The rule lives in PL/pgSQL, which needs a database to execute. What can be
 * checked offline is that the SQL still SAYS the thing — that no provider-scoped
 * join has crept back into the finalize body, and that the unique constraint is
 * on the symbol alone. That is exactly the shape the regression would take: a
 * later migration re-adding `i.provider = run_record.provider` to a rewritten
 * finalize, which reads as harmless and re-forks the table.
 *
 * It reads the LAST migration that defines each thing, because migrations
 * replay in filename order and the last definition is the one in force.
 */

const DIR = path.resolve('supabase/migrations');
const FILES = readdirSync(DIR).filter((name) => name.endsWith('.sql')).sort();
const sql = (name: string) => readFileSync(path.join(DIR, name), 'utf8');

/** The last migration whose body matches, or null. */
function lastDefining(pattern: RegExp): { file: string; body: string } | null {
  for (let index = FILES.length - 1; index >= 0; index -= 1) {
    const body = sql(FILES[index]);
    if (pattern.test(body)) return { file: FILES[index], body };
  }
  return null;
}

describe('the instrument identity in force', () => {
  it('has migrations to read, so a pass is never vacuous', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  /*
   * The vendor is an attribute of the reading, like `last_synced_at`. Putting it
   * back in the key gives every vendor a private copy of the universe.
   */
  it('keys an instrument on its symbol, not on symbol-and-vendor', () => {
    const found = lastDefining(/add constraint market_instruments_provider_symbol_key|constraint market_instruments_provider_symbol_key/);
    expect(found, 'no migration defines the instrument uniqueness').not.toBeNull();

    const constraint = /constraint market_instruments_provider_symbol_key\s+unique\s*\(([^)]*)\)/
      .exec(found!.body);
    expect(constraint, `${found!.file} defines the constraint in an unreadable shape`).not.toBeNull();

    const columns = constraint![1].split(',').map((value) => value.trim()).filter(Boolean);
    expect(columns, `${found!.file} keys instruments on ${columns.join(' + ')}`)
      .toEqual(['provider_symbol']);
  });

  /*
   * THE LINE THAT HID THE FORK. Scoped to one provider, a symbol the answering
   * vendor has dropped stays 'active' forever under the vendor that used to
   * serve it, and a symbol both serve exists twice.
   */
  it('lets a sync run own the whole universe, not one vendor\'s slice', () => {
    const found = lastDefining(/create or replace function public\.finalize_market_instrument_sync/);
    expect(found, 'no migration defines finalize_market_instrument_sync').not.toBeNull();

    const start = found!.body.indexOf('create or replace function public.finalize_market_instrument_sync');
    const body = found!.body.slice(start);

    expect(body, `${found!.file} scopes finalize by provider again`)
      .not.toMatch(/i\.provider\s*=\s*run_record\.provider/);
  });

  /*
   * The upsert must WRITE the provider, or a row re-read from the fallback keeps
   * claiming whoever served it first — the original lie, arriving by a new
   * route.
   */
  it('records the answering vendor on every row it touches', () => {
    const found = lastDefining(/create or replace function public\.finalize_market_instrument_sync/);
    const start = found!.body.indexOf('create or replace function public.finalize_market_instrument_sync');
    const body = found!.body.slice(start);

    expect(body, `${found!.file} does not refresh provider on conflict`)
      .toMatch(/on conflict \(provider_symbol\) do update set[\s\S]*?provider = excluded\.provider/);
  });
});
