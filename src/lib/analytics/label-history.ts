import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';

/**
 * Reading and writing `public.label_history` — the memory the shared hold rule
 * needs in order to actually hold anything.
 *
 * ===========================================================================
 * WHY THIS EXISTS AT ALL
 * ===========================================================================
 * `heldLabel` makes a new reading wait `minDurationBars` consecutive
 * evaluations before it is published, and it takes the previous readings as an
 * argument. The Market Signal engine supplies them by replaying itself over
 * earlier candles — it has the inputs, so the past is reconstructible.
 *
 * The Market Status card has no candles. It has six quotes taken at one instant,
 * and yesterday's six are gone. It was therefore passing `[]` on every render,
 * which made `minDurationBars: 2` configured, documented, unit-tested and
 * completely inert in production: every reading published immediately and the
 * status could flip day to day on noise the rule exists to absorb.
 *
 * ===========================================================================
 * ONE TABLE, BECAUSE IT IS ONE RULE
 * ===========================================================================
 * The `scope` column is what lets both callers of the shared hold rule share
 * one store. A second table would be a second place for the same invariant to
 * drift — and this module is where the invariant is written down:
 *
 *   THE HOLD RULE READS `raw_label`, NEVER `held_label`.
 *
 * The rule is defined over the raw sequence alone. Feeding it published labels
 * would make it read its own output: today's answer would depend on a hold
 * applied yesterday, which depended on one applied the day before, and the
 * window would have to be the whole history rather than `lookbackBars`. It
 * would also compound — a label held once would be more likely to be held
 * again, which is exactly the "an older label is a better label" effect
 * `docs/signal-handover.md` §6.8 forbids.
 *
 * `held_label` is stored anyway because it is the only thing here that cannot
 * be recomputed: it is what was on the screen.
 *
 * ===========================================================================
 * WHY THE SIGNAL ENGINE IS SUPPORTED BUT NOT SWITCHED OVER
 * ===========================================================================
 * The `market-signal` scope exists and is tested, so the store serves both
 * callers of the shared hold rule. The engine is deliberately NOT rewired to
 * read from it, and that is a decision rather than unfinished work:
 *
 *   * it does not need to. It reconstructs its own history by replaying itself
 *     over `candles.slice(0, -k)`, which answers "what would this engine have
 *     said on that bar" — the exact question the hold rule asks — with no
 *     database and no write path that can fail;
 *   * it already has a table. `market_signal_history` records published labels
 *     WITH `raw_state` beside them, under the same §6.8 discipline. Pointing the
 *     engine at a second store would put one fact in two places, which is the
 *     failure this module's own `scope` column exists to avoid.
 *
 * The scope is here so that a future engine using the shared rule — one without
 * candles, like the Market Status card — has somewhere to put its sequence
 * without inventing a third table.
 */

type Client = SupabaseClient<Database>;

/** Which engine published the label. Both callers of the shared hold rule. */
export type LabelScope = 'market-status' | 'market-signal';

/**
 * The `key` used by the Market Status card.
 *
 * A constant, because the card describes one market. Named rather than left as
 * an empty string so the column stays meaningful if a second market is added.
 */
export const MARKET_STATUS_KEY = 'US';

/** How far back the hold rule can ever look. Bounds the read. */
const MAX_LOOKBACK_DAYS = 30;

export interface LabelHistoryEntry {
  date: string;
  rawLabel: string;
  heldLabel: string;
}

/**
 * Previous RAW labels for one scope and key, NEWEST FIRST, excluding `onDate`.
 *
 * The shape `heldLabel` wants: it prepends today's own raw reading and walks
 * back. `onDate` is excluded rather than included because today's row may
 * already exist from an earlier render, and including it would let a reading
 * count itself twice toward its own duration — a page refreshed once would
 * publish a label that had stood for one evaluation.
 *
 * `limit` is small by design; the rule needs `lookbackBars`, which is two.
 *
 * Returns an empty array rather than throwing when the table is unreachable or
 * does not exist yet. That is not a silent failure: an empty history is exactly
 * the first-render case, and the rule's answer to it — publish immediately — is
 * the behaviour that shipped before this table. A card must not go blank
 * because its memory is briefly unavailable.
 */
export async function loadLabelHistory(
  client: Client,
  scope: LabelScope,
  key: string,
  onDate: string,
  limit = 8,
): Promise<string[]> {
  const floor = new Date(Date.parse(`${onDate}T00:00:00Z`) - MAX_LOOKBACK_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  const { data, error } = await client
    .from('label_history')
    .select('date, raw_label')
    .eq('scope', scope)
    .eq('key', key.toUpperCase())
    .lt('date', onDate)
    .gte('date', floor)
    .order('date', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  /*
    `raw_label`, never `held_label` — see the invariant at the top of this file.
    A caller that wanted the published series for a strip would need its own
    reader, and would still not be allowed to feed it to the rule.
  */
  return data.map((row) => row.raw_label);
}

/**
 * Record one evaluation.
 *
 * Upsert on the full primary key, the same shape `captureDailyCloses` uses for
 * the same reason: re-rendering a page must leave the day's history one entry
 * long. Appending instead would let a page rendered five times on Tuesday read
 * back as five consecutive identical labels, and the hold rule would adopt a new
 * reading the moment somebody refreshed — the precise failure it exists to
 * prevent, caused by the fix for it.
 *
 * Returns whether the row was written. A failure is not propagated: the label
 * has already been computed and is about to be shown, and losing the record of
 * it degrades tomorrow's hold, which is strictly better than failing the render
 * that is in front of a reader now.
 */
export async function recordLabel(
  client: Client,
  entry: {
    scope: LabelScope;
    key: string;
    date: string;
    rawLabel: string;
    heldLabel: string;
  },
): Promise<boolean> {
  const { error } = await client
    .from('label_history')
    .upsert({
      scope: entry.scope,
      key: entry.key.toUpperCase(),
      date: entry.date,
      raw_label: entry.rawLabel.toUpperCase(),
      held_label: entry.heldLabel.toUpperCase(),
    }, { onConflict: 'scope,key,date' });
  return !error;
}
