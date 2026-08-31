import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import {
  createOvAlertStore,
  loadOvAlertCountsBySymbol,
  ovAlertCountsBySymbol,
} from './supabase-store';
import type { OvAlertRule } from './types';

/**
 * THE DISTINCTION THE WHOLE FILE TURNS ON.
 *
 * An UNREADABLE count is not a count of zero. `overview_alert_rules` is applied
 * now, so a missing relation is no longer the everyday case — but a revoked
 * grant and a dropped connection still are, and a row that drew "0 alerts"
 * because one of those happened would be telling a reader something false about
 * their own settings.
 */

function rule(over: Partial<OvAlertRule> = {}): OvAlertRule {
  return {
    id: 'rule-1',
    userId: null,
    symbol: 'NVDA',
    kind: 'price_above',
    threshold: 150,
    enabled: true,
    lastFiredAt: null,
    ...over,
  };
}

/** A client whose `from(...).select(...)` answers however the case needs it to. */
function clientReturning(
  answer: { data: unknown; error: unknown } | (() => never),
): SupabaseClient<Database> {
  return {
    from: () => ({
      select: async () => (typeof answer === 'function' ? answer() : answer),
    }),
  } as unknown as SupabaseClient<Database>;
}

describe('ovAlertCountsBySymbol', () => {
  it('counts one rule per symbol', () => {
    expect(ovAlertCountsBySymbol([
      rule({ id: 'a', symbol: 'NVDA' }),
      rule({ id: 'b', symbol: 'NVDA', kind: 'price_below' }),
      rule({ id: 'c', symbol: 'AAPL' }),
    ])).toEqual({ NVDA: 2, AAPL: 1 });
  });

  it('does not count a rule that is switched off', () => {
    // A switched-off alert will not fire. Counting it would tell a reader they
    // are being watched when they are not.
    expect(ovAlertCountsBySymbol([
      rule({ id: 'a', symbol: 'NVDA' }),
      rule({ id: 'b', symbol: 'NVDA', kind: 'price_below', enabled: false }),
    ])).toEqual({ NVDA: 1 });
  });

  it('normalizes the symbol it counts under', () => {
    expect(ovAlertCountsBySymbol([
      rule({ id: 'a', symbol: ' nvda ' }),
      rule({ id: 'b', symbol: 'NVDA', kind: 'price_below' }),
    ])).toEqual({ NVDA: 2 });
  });

  it('is an empty object for a reader with no rules, not null', () => {
    expect(ovAlertCountsBySymbol([])).toEqual({});
  });
});

describe('loadOvAlertCountsBySymbol', () => {
  it('reads counts when the table is there', async () => {
    const client = clientReturning({
      data: [
        { id: 'a', symbol: 'NVDA', kind: 'price_above', threshold: '150', enabled: true, last_fired_at: null },
        { id: 'b', symbol: 'NVDA', kind: 'earnings', threshold: '7', enabled: true, last_fired_at: null },
        { id: 'c', symbol: 'AAPL', kind: 'price_below', threshold: '90', enabled: false, last_fired_at: null },
      ],
      error: null,
    });
    expect(await loadOvAlertCountsBySymbol(client)).toEqual({ NVDA: 2 });
  });

  it('answers null when the table cannot be read', async () => {
    /*
      PostgREST answers an unreadable relation with an error rather than an empty
      result, and `null` is what carries "we do not know" all the way to the row,
      which then draws nothing. 42P01 stands in for the whole class here.
    */
    const client = clientReturning({
      data: null,
      error: { code: '42P01', message: 'relation "overview_alert_rules" does not exist' },
    });
    expect(await loadOvAlertCountsBySymbol(client)).toBeNull();
  });

  it('answers null when the query throws outright', async () => {
    const client = clientReturning(() => { throw new Error('network'); });
    expect(await loadOvAlertCountsBySymbol(client)).toBeNull();
  });

  it('answers an empty object when the reader simply has no rules', async () => {
    // NOT null. The table is there and the answer is "none", which is a fact
    // about the reader rather than about the schema.
    const client = clientReturning({ data: [], error: null });
    expect(await loadOvAlertCountsBySymbol(client)).toEqual({});
  });

  it('reads a numeric threshold that arrived as a string', async () => {
    const client = clientReturning({
      data: [{ id: 'a', symbol: 'NVDA', kind: 'price_above', threshold: '150.25', enabled: true, last_fired_at: null }],
      error: null,
    });
    expect(await loadOvAlertCountsBySymbol(client)).toEqual({ NVDA: 1 });
  });

  it('drops a row it cannot understand rather than failing the whole read', async () => {
    const client = clientReturning({
      data: [
        { id: 'a', symbol: 'NVDA', kind: 'moon_phase', threshold: '1', enabled: true },
        { id: 'b', symbol: 'AAPL', kind: 'price_above', threshold: '150', enabled: true },
      ],
      error: null,
    });
    expect(await loadOvAlertCountsBySymbol(client)).toEqual({ AAPL: 1 });
  });
});

describe('the reader-scoped store', () => {
  it('refuses to record a hit, because that needs a service-role path', async () => {
    /*
      `record_overview_alert_hit` resolves `auth.uid()` itself, and a cron runs
      with an admin client where that is null. Throwing at the call site is what
      stops somebody wiring the sweep to this store and finding out in
      production. See `alerts/run.ts` and the report on the cron wiring.
    */
    const store = createOvAlertStore(clientReturning({ data: [], error: null }));
    await expect(store.recordHit({
      ruleId: 'rule-1',
      symbol: 'NVDA',
      kind: 'price_above',
      observedPrice: 160,
      observedChangePercent: 1,
      observedEarningsDays: null,
      observedAt: '2026-09-11T00:00:00.000Z',
      valueText: 'x',
    })).rejects.toThrow(/service-role/);
  });
});

/**
 * CREATION GOES THROUGH THE FUNCTION, AND THE ROW COMES BACK FROM THE DATABASE.
 *
 * The adapter used to `insert` directly. That could never have worked —
 * `user_id` is `not null` with no default and no trigger, so every call would
 * have raised 23502 — and nothing noticed, because there is no CRUD surface yet
 * and the only exercise was `sweep.test.ts` against a Map, which does not
 * enforce `not null`.
 *
 * Two properties are asserted here and neither is visible to the in-memory
 * double, because both are about which calls the adapter makes:
 *
 *   1. it calls `create_overview_alert_rule` rather than inserting, so the
 *      fifty-rule cap and the advisory lock inside that function apply; and
 *   2. it returns the row it READ BACK, not the draft it sent. The function
 *      normalizes the symbol, `numeric` rounds the threshold and `enabled` comes
 *      from the column default, so a row echoed from the draft would agree with
 *      the database only by luck.
 */
describe('creating a rule', () => {
  /** A client that records the RPC it was given and answers the read-back. */
  function creatingClient(options: {
    id?: unknown;
    rpcError?: unknown;
    row?: unknown;
    rowError?: unknown;
  }) {
    const calls: Array<{ name: string; args: unknown }> = [];
    const selected: unknown[] = [];
    const client = {
      rpc: async (name: string, args: unknown) => {
        calls.push({ name, args });
        return { data: options.id ?? null, error: options.rpcError ?? null };
      },
      from: () => ({
        select: () => ({
          eq: (_column: string, value: unknown) => {
            selected.push(value);
            return {
              single: async () => ({
                data: options.row ?? null,
                error: options.rowError ?? null,
              }),
            };
          },
        }),
      }),
    } as unknown as SupabaseClient<Database>;
    return { client, calls, selected };
  }

  const storedRow = {
    id: 'rule-9',
    symbol: 'NVDA',
    kind: 'earnings',
    threshold: '7',
    enabled: true,
    last_fired_at: null,
  };

  it('calls the function rather than inserting, and passes the three arguments', async () => {
    const { client, calls } = creatingClient({ id: 'rule-9', row: storedRow });
    await createOvAlertStore(client).createRule({
      symbol: 'NVDA', kind: 'earnings', threshold: 7,
    });
    expect(calls).toEqual([{
      name: 'create_overview_alert_rule',
      args: { input_symbol: 'NVDA', input_kind: 'earnings', input_threshold: 7 },
    }]);
  });

  it('reads the created row back by the id the function returned', async () => {
    const { client, selected } = creatingClient({ id: 'rule-9', row: storedRow });
    await createOvAlertStore(client).createRule({
      symbol: 'NVDA', kind: 'earnings', threshold: 7,
    });
    expect(selected).toEqual(['rule-9']);
  });

  it('returns the stored row, not the draft that was sent', async () => {
    /*
      The draft says 7.4 and the column stored 7. A caller shown 7.4 would be
      told a rule exists that does not.
    */
    const { client } = creatingClient({
      id: 'rule-9',
      row: { ...storedRow, threshold: '7', symbol: 'NVDA' },
    });
    const created = await createOvAlertStore(client).createRule({
      symbol: 'nvda', kind: 'earnings', threshold: 7.4,
    });
    expect(created).toMatchObject({ threshold: '7', symbol: 'NVDA' });
  });

  it('propagates the function’s error instead of reporting a creation', async () => {
    // 23505 and 54000 both arrive this way, and `repository.ts` maps them onto
    // `duplicate` and `limit`. Swallowing either here would lose both.
    const { client } = creatingClient({ rpcError: { code: '54000', message: 'Alert limit reached' } });
    await expect(createOvAlertStore(client).createRule({
      symbol: 'NVDA', kind: 'price_above', threshold: 150,
    })).rejects.toMatchObject({ code: '54000' });
  });

  it('refuses a null id rather than reporting a row it cannot point at', async () => {
    const { client } = creatingClient({ id: null });
    await expect(createOvAlertStore(client).createRule({
      symbol: 'NVDA', kind: 'price_above', threshold: 150,
    })).rejects.toThrow(/returned no id/);
  });

  it('propagates a failed read-back rather than inventing the row', async () => {
    const { client } = creatingClient({
      id: 'rule-9',
      rowError: { code: 'PGRST116', message: 'no rows' },
    });
    await expect(createOvAlertStore(client).createRule({
      symbol: 'NVDA', kind: 'price_above', threshold: 150,
    })).rejects.toMatchObject({ code: 'PGRST116' });
  });
});
