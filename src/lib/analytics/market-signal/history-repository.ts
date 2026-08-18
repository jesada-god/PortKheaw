import 'server-only';

import { createAdminClient } from '@/src/lib/supabase/admin';
import type { MarketSignalHistoryEntry, MarketSignalState, MarketSignalZoneName } from './types';
import type { MarketSignalSnapshot } from './history';

/**
 * P6 storage. Service-role only, and quiet about every failure.
 *
 * `public.market_signal_history` has RLS on with no policy, so nothing reaches
 * a browser from here: the entitlement that decides who may see any of this
 * lives in `loadEntitledMarketSignal`, one layer up, where it is tested.
 *
 * EVERY function here fails soft. The history is decoration on a card that has
 * to render without it — a missing service key, a network blip, a table that has
 * not been migrated yet, all of them return "no history" and none of them throws.
 * A card that goes blank because a nice-to-have strip could not load would be a
 * worse product than one with no strip at all, and this is the layer that makes
 * that choice rather than leaving it to a `try` in a page.
 */

const TABLE = 'market_signal_history';

const VALID_STATES = new Set<string>([
  'STRONG_BULLISH', 'BULLISH', 'SIDEWAYS', 'SQUEEZE', 'OVEREXTENDED', 'BEARISH', 'STRONG_BEARISH',
]);
const VALID_ZONES = new Set<string>(['uptrend', 'downtrend', 'sideways']);

/**
 * Rows come back as `text`, which the type system cannot narrow on its own.
 *
 * A row whose state is not one this build knows about is DROPPED rather than
 * coerced: it means the table outlived a rename, and a strip that renders an
 * unknown label as a blank cell is telling a smaller lie than one that maps it
 * onto the nearest known label.
 */
function toEntry(row: {
  as_of: string;
  state: string;
  bias: string;
  zone: string | null;
  score: number | null;
  evidence_agreement: number | null;
  flags: string[] | null;
}): MarketSignalHistoryEntry | null {
  if (!VALID_STATES.has(row.state)) return null;
  if (row.bias !== 'bullish' && row.bias !== 'neutral' && row.bias !== 'bearish') return null;
  return {
    asOf: row.as_of,
    state: row.state as MarketSignalState,
    bias: row.bias,
    zone: row.zone !== null && VALID_ZONES.has(row.zone) ? row.zone as MarketSignalZoneName : null,
    score: row.score,
    evidenceAgreement: row.evidence_agreement,
    flags: row.flags ?? [],
  };
}

/** The most recent `windowDays` calendar days of published labels, oldest first. */
export async function readSignalHistory(
  symbol: string,
  windowDays: number,
): Promise<MarketSignalHistoryEntry[]> {
  const client = createAdminClient();
  if (!client) return [];
  /*
   * Bounded by DATE, not by row count. `limit(windowDays)` would return the
   * newest 30 recorded days however far back they reach, so a symbol nobody has
   * opened since March would draw a "last 30 days" strip out of March. Asking
   * for a date range makes an empty answer the correct answer.
   */
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
  try {
    const { data, error } = await client
      .from(TABLE)
      .select('as_of, state, bias, zone, score, evidence_agreement, flags')
      .eq('symbol', symbol)
      .gte('as_of', since)
      .order('as_of', { ascending: true });
    if (error || !data) return [];
    return data.map(toEntry).filter((entry): entry is MarketSignalHistoryEntry => entry !== null);
  } catch {
    return [];
  }
}

/**
 * Record today's reading, or leave the table exactly as it was.
 *
 * Upsert on the primary key, so opening the same symbol six times in an
 * afternoon writes one row and the last read of a day is the one kept. That
 * ordering is deliberate: a reading taken after the close is a more complete
 * statement about that day than one taken at lunchtime, and both are honest
 * records of what the card said.
 */
export async function writeSignalSnapshot(snapshot: MarketSignalSnapshot): Promise<void> {
  const client = createAdminClient();
  if (!client) return;
  try {
    await client.from(TABLE).upsert({
      symbol: snapshot.symbol,
      as_of: snapshot.asOf,
      state: snapshot.state,
      bias: snapshot.bias,
      zone: snapshot.zone,
      score: snapshot.score,
      evidence_agreement: snapshot.evidenceAgreement,
      flags: [...snapshot.flags],
      features: snapshot.features,
      recorded_at: new Date().toISOString(),
    }, { onConflict: 'symbol,as_of' });
  } catch {
    /* A history that failed to record is not a reason to fail a page. */
  }
}
