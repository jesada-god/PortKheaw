import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import { MARKET_STATUS_KEY, loadLabelHistory, recordLabel, type LabelScope } from './label-history';

/**
 * A `label_history` table small enough to reason about, behind the slice of the
 * Supabase builder these two functions actually use.
 *
 * Real rows in a real shape rather than a returned constant: the ordering, the
 * `< onDate` bound and the upsert-vs-append behaviour are the things under test,
 * and a stub that ignored the filters would pass regardless of what the callers
 * asked for.
 */
function fakeClient(rows: Array<{
  scope: string; key: string; date: string; raw_label: string; held_label: string;
}> = []) {
  const store = [...rows];
  const failures = { read: false, write: false };

  const client = {
    from: (table: string) => {
      if (table !== 'label_history') throw new Error(`unexpected table ${table}`);
      return {
        select: () => {
          const filters: Record<string, string> = {};
          let lt: string | null = null;
          let gte: string | null = null;
          let limit = Infinity;
          const builder = {
            eq(column: string, value: string) { filters[column] = value; return builder; },
            lt(_column: string, value: string) { lt = value; return builder; },
            gte(_column: string, value: string) { gte = value; return builder; },
            order(_column: string, options: { ascending: boolean }) {
              builder.descending = !options.ascending;
              return builder;
            },
            descending: true,
            limit(count: number) {
              limit = count;
              return Promise.resolve(builder.run());
            },
            run() {
              if (failures.read) return { data: null, error: { message: 'read failed' } };
              let data = store.filter((row) =>
                Object.entries(filters).every(([column, value]) =>
                  row[column as 'scope' | 'key'] === value));
              if (lt !== null) data = data.filter((row) => row.date < lt!);
              if (gte !== null) data = data.filter((row) => row.date >= gte!);
              data.sort((a, b) => builder.descending
                ? b.date.localeCompare(a.date)
                : a.date.localeCompare(b.date));
              return { data: data.slice(0, limit), error: null };
            },
          };
          return builder;
        },
        upsert(row: { scope: string; key: string; date: string; raw_label: string; held_label: string }) {
          if (failures.write) return Promise.resolve({ error: { message: 'write failed' } });
          const index = store.findIndex((existing) =>
            existing.scope === row.scope && existing.key === row.key && existing.date === row.date);
          if (index >= 0) store[index] = row;
          else store.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as SupabaseClient<Database>;

  return { client, store, failures };
}

const row = (scope: LabelScope, key: string, date: string, raw: string, held = raw) =>
  ({ scope, key, date, raw_label: raw, held_label: held });

describe('loadLabelHistory', () => {
  it('returns previous raw labels newest first', () => {
    const { client } = fakeClient([
      row('market-status', 'US', '2026-08-24', 'SIDEWAYS'),
      row('market-status', 'US', '2026-08-26', 'UPTREND'),
      row('market-status', 'US', '2026-08-25', 'WEAK'),
    ]);
    return expect(loadLabelHistory(client, 'market-status', 'US', '2026-08-27'))
      .resolves.toEqual(['UPTREND', 'WEAK', 'SIDEWAYS']);
  });

  it('EXCLUDES the date being evaluated', async () => {
    /*
      Today's row may already exist from an earlier render. Including it would
      let a reading count toward its own duration, so one refresh would publish
      a label that has stood for exactly one evaluation — the flip the hold rule
      exists to absorb, caused by the mechanism meant to prevent it.
    */
    const { client } = fakeClient([
      row('market-status', 'US', '2026-08-27', 'UPTREND'),
      row('market-status', 'US', '2026-08-26', 'SIDEWAYS'),
    ]);
    await expect(loadLabelHistory(client, 'market-status', 'US', '2026-08-27'))
      .resolves.toEqual(['SIDEWAYS']);
  });

  it('reads raw_label and never held_label', async () => {
    /*
      The invariant this store exists to hold. Feeding published labels back in
      would make the rule read its own output: a label held once would be more
      likely to be held again, compounding into "an older label is a better
      label", which `docs/signal-handover.md` §6.8 forbids outright.
    */
    const { client } = fakeClient([
      row('market-status', 'US', '2026-08-26', 'UPTREND', 'SIDEWAYS'),
    ]);
    await expect(loadLabelHistory(client, 'market-status', 'US', '2026-08-27'))
      .resolves.toEqual(['UPTREND']);
  });

  it('keeps scopes apart, so one engine cannot read the other’s labels', async () => {
    const { client } = fakeClient([
      row('market-status', 'US', '2026-08-26', 'UPTREND'),
      row('market-signal', 'US', '2026-08-26', 'STRONG_BULLISH'),
    ]);
    await expect(loadLabelHistory(client, 'market-status', 'US', '2026-08-27'))
      .resolves.toEqual(['UPTREND']);
    await expect(loadLabelHistory(client, 'market-signal', 'US', '2026-08-27'))
      .resolves.toEqual(['STRONG_BULLISH']);
  });

  it('keeps keys apart within a scope', async () => {
    const { client } = fakeClient([
      row('market-signal', 'NVDA', '2026-08-26', 'BULLISH'),
      row('market-signal', 'AAPL', '2026-08-26', 'BEARISH'),
    ]);
    await expect(loadLabelHistory(client, 'market-signal', 'NVDA', '2026-08-27'))
      .resolves.toEqual(['BULLISH']);
  });

  it('upper-cases the key, so a caller’s casing cannot miss its own history', async () => {
    const { client } = fakeClient([row('market-signal', 'NVDA', '2026-08-26', 'BULLISH')]);
    await expect(loadLabelHistory(client, 'market-signal', 'nvda', '2026-08-27'))
      .resolves.toEqual(['BULLISH']);
  });

  it('ignores anything older than the lookback floor', async () => {
    // A label from six weeks ago is not evidence about a two-day hold, and
    // returning it would let a long-dead reading resurface.
    const { client } = fakeClient([
      row('market-status', 'US', '2026-06-01', 'UPTREND'),
      row('market-status', 'US', '2026-08-26', 'WEAK'),
    ]);
    await expect(loadLabelHistory(client, 'market-status', 'US', '2026-08-27'))
      .resolves.toEqual(['WEAK']);
  });

  it('returns an empty history when the table cannot be read', async () => {
    /*
      Not a silent failure: an empty history is the first-render case, and the
      rule's answer to it — publish immediately — is exactly the behaviour that
      shipped before this table existed. A card must not go blank because its
      memory blipped.
    */
    const { client, failures } = fakeClient([row('market-status', 'US', '2026-08-26', 'WEAK')]);
    failures.read = true;
    await expect(loadLabelHistory(client, 'market-status', 'US', '2026-08-27')).resolves.toEqual([]);
  });
});

describe('recordLabel', () => {
  it('writes both labels, upper-cased, under the evaluated date', async () => {
    const { client, store } = fakeClient();
    await expect(recordLabel(client, {
      scope: 'market-status', key: MARKET_STATUS_KEY, date: '2026-08-27',
      rawLabel: 'UPTREND', heldLabel: 'SIDEWAYS',
    })).resolves.toBe(true);
    expect(store).toEqual([
      { scope: 'market-status', key: 'US', date: '2026-08-27', raw_label: 'UPTREND', held_label: 'SIDEWAYS' },
    ]);
  });

  it('OVERWRITES the same day rather than appending', async () => {
    /*
      The property that makes a re-render idempotent. Appending would let a page
      rendered five times on Tuesday read back as five consecutive identical
      labels, and the hold rule would adopt a new reading the moment somebody
      refreshed.
    */
    const { client, store } = fakeClient();
    for (let render = 0; render < 5; render += 1) {
      await recordLabel(client, {
        scope: 'market-status', key: 'US', date: '2026-08-27',
        rawLabel: 'UPTREND', heldLabel: 'SIDEWAYS',
      });
    }
    expect(store).toHaveLength(1);
  });

  it('serves both scopes from one table', async () => {
    // The whole reason `scope` exists: one hold rule, one store.
    const { client, store } = fakeClient();
    await recordLabel(client, {
      scope: 'market-status', key: 'US', date: '2026-08-27', rawLabel: 'WEAK', heldLabel: 'WEAK',
    });
    await recordLabel(client, {
      scope: 'market-signal', key: 'NVDA', date: '2026-08-27', rawLabel: 'BULLISH', heldLabel: 'BULLISH',
    });
    expect(store).toHaveLength(2);
    expect(new Set(store.map((entry) => entry.scope))).toEqual(new Set(['market-status', 'market-signal']));
  });

  it('reports a failed write instead of throwing', async () => {
    // The label is already computed and about to be shown. Losing the record
    // degrades tomorrow's hold; failing the render breaks today's page.
    const { client, failures } = fakeClient();
    failures.write = true;
    await expect(recordLabel(client, {
      scope: 'market-status', key: 'US', date: '2026-08-27', rawLabel: 'WEAK', heldLabel: 'WEAK',
    })).resolves.toBe(false);
  });

  it('round-trips: what is recorded is what the next day reads back', async () => {
    const { client } = fakeClient();
    await recordLabel(client, {
      scope: 'market-status', key: 'US', date: '2026-08-26', rawLabel: 'UPTREND', heldLabel: 'SIDEWAYS',
    });
    await expect(loadLabelHistory(client, 'market-status', 'US', '2026-08-27'))
      .resolves.toEqual(['UPTREND']);
  });
});
