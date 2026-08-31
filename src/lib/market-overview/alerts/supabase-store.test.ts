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
 * THE TWO STATES THIS HAS TO SURVIVE.
 *
 * `overview_alert_rules` is created by a migration that has not been applied, so
 * every deployment today is in the "table does not exist" state and the Overview
 * has to render identically in both. The distinction the whole file turns on is
 * that an UNREADABLE count is not a count of zero: a row that drew "0 alerts"
 * because the table is missing would be telling a reader something false about
 * their own settings.
 */

function rule(over: Partial<OvAlertRule> = {}): OvAlertRule {
  return {
    id: 'rule-1',
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

  it('answers null when the table does not exist', async () => {
    /*
      The state every deployment is in today. PostgREST answers an unknown
      relation with an error rather than an empty result, and `null` is what
      carries "we do not know" all the way to the row, which then draws nothing.
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
