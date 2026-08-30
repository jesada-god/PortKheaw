import 'server-only';

import {
  MARKET_STATUS_AVAILABILITY,
  MARKET_STATUS_BANDS,
  MARKET_STATUS_INPUTS,
  type MarketStatusInputKey,
} from '@/src/config/market-status';
import { phase2MarketSnapshotEnabled } from '@/src/config/features';
import { intervalVerdict, scoreInterval } from '@/src/lib/analytics/bounded-score';
import { getYahooChartProvider } from '@/src/lib/market-data/candles';
import {
  lastCompletedSessionDate,
  marketSession,
} from '@/src/lib/market-data/market-session';
import { US_EQUITY_TIMEZONE, exchangeSessionDate } from '@/src/lib/market-data/session';
import { contributionOf } from '@/src/lib/market-status/rules';
import { LastGoodSnapshotCoordinator } from '@/src/lib/overview/industry-snapshot';
import { resolveDayChangeBasis } from '@/src/lib/portfolio/day-change';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import { ovRegime } from './regime';
import type {
  OvIndexKey,
  OvIndexReading,
  OvMarketSnapshot,
  OvMarketStatus,
} from './types';

/**
 * THE SIX INSTRUMENTS, LOADED ONCE AND CACHED TWICE.
 *
 * ===========================================================================
 * NO NEW PROVIDER INTEGRATION, AND FEWER CALLS THAN THE CARD IT SITS BESIDE
 * ===========================================================================
 * These are the same six symbols read through the same endpoint the Market
 * Status card already reads — `getYahooChartProvider().getQuote` — so nothing
 * new is being bought and no second provider is being wired in.
 *
 * What is added is caching, because that path has none. `readInput` in
 * `src/lib/market-status/service.ts` issues six live quotes on every render of
 * every reader's overview. Here the six sit behind `SharedRequestCache` with a
 * sixty-second fresh window and in-flight dedupe, and the assembled snapshot
 * sits behind `LastGoodSnapshotCoordinator` — the read-now, warm-later shape
 * `market-breadth.ts` uses — so a burst of readers costs one round of six
 * quotes rather than six per reader.
 *
 * ===========================================================================
 * OFF MEANS FREE
 * ===========================================================================
 * `PHASE2_MARKET_SNAPSHOT` is read before any promise is constructed, in all
 * three entry points. `await x ? a() : b()` and `x ? await a() : b()` look
 * alike and are not — the first builds and then discards a request that has
 * already been billed. See `src/config/phase2-flags.test.ts` for the same
 * property asserted over the original six flags.
 */

/*
 * The union in `types.ts` and the shared input table must name the same six.
 *
 * Assigning each to the other is the whole check: if a seventh input is added
 * to the config, or one is renamed, `OvIndexKey` no longer covers it and this
 * line stops compiling. Cheaper than a test and impossible to skip.
 */
type MutuallyAssignable<A extends B, B extends C, C = A> = true;
type _IndexKeysArePinned = MutuallyAssignable<MarketStatusInputKey, OvIndexKey, MarketStatusInputKey>;

const quoteCache = new SharedRequestCache();

/**
 * The same policy `quote-service.ts` gives the same Yahoo quote.
 *
 * A minute of freshness with a day of stale fallback: these six move
 * continuously while the market is open, and outside it they do not move at
 * all, so a long stale window costs nothing and keeps the card alive through a
 * provider outage. `errorMs` stops a failing symbol being retried on every
 * render.
 */
const QUOTE_POLICY = { freshMs: 60_000, staleMs: 24 * 60 * 60_000, errorMs: 30_000 } as const;

const snapshots = new LastGoodSnapshotCoordinator<OvMarketSnapshot>({
  freshMs: 60_000,
  staleMs: 15 * 60_000,
});

interface RawQuote {
  price: number | null;
  previousClose: number | null;
  asOf: string | null;
}

/**
 * One provider read, degraded to an unreadable input rather than a thrown page.
 *
 * A failed instrument becomes a missing reading, which the arithmetic below
 * already knows how to handle — by widening the interval and withholding, never
 * by guessing. Throwing here would take down the whole snapshot over one flaky
 * symbol.
 */
async function readQuote(symbol: string, cacheKey: string): Promise<RawQuote> {
  try {
    const resolved = await quoteCache.resolve(
      cacheKey,
      () => getYahooChartProvider().getQuote(symbol),
      QUOTE_POLICY,
    );
    return {
      price: resolved.value.data.price,
      previousClose: resolved.value.data.previousClose ?? null,
      asOf: resolved.value.freshness.asOf ?? null,
    };
  } catch {
    return { price: null, previousClose: null, asOf: null };
  }
}

/**
 * The headline, over all six inputs.
 *
 * Pure, and separate from the load so the arithmetic can be read without the
 * plumbing. Two gates, in this order:
 *
 *   1. EVERY equity input must be readable. With one absent the snapshot cannot
 *      say what the market did, and no combination of the risk inputs
 *      substitutes for it — "หุ้นเทคขึ้น" is not an answer to "what did the
 *      market do". One missing equity reading returns `null`.
 *   2. A definite word only when the whole interval supports it. `unclear` is
 *      what absorbs every loss of evidence, so a missing risk input can move
 *      the answer toward `unclear` and never away from it.
 */
export function ovMarketStatus(readings: readonly OvIndexReading[]): OvMarketStatus | null {
  const byKey = new Map(readings.map((reading) => [reading.key, reading]));
  const usable = (value: number | null | undefined): value is number =>
    value !== null && value !== undefined && Number.isFinite(value);

  const required = MARKET_STATUS_AVAILABILITY.requiredForLabel as readonly OvIndexKey[];
  if (!required.every((key) => usable(byKey.get(key)?.changePercent))) return null;

  const bounds = scoreInterval(MARKET_STATUS_INPUTS.map((input) => {
    const changePercent = byKey.get(input.key)?.changePercent ?? null;
    return {
      weight: input.weight,
      contribution: contributionOf(input, usable(changePercent) ? changePercent : null),
    };
  }));
  if (bounds === null) return null;

  const verdict = intervalVerdict(bounds, {
    above: MARKET_STATUS_BANDS.uptrendAbove,
    below: MARKET_STATUS_BANDS.weakBelow,
  });
  return verdict === 'above' ? 'up' : verdict === 'below' ? 'down' : 'unclear';
}

/** The trading date the snapshot is filed under. Also the snapshot cache key. */
function snapshotKey(now: Date): string {
  const session = marketSession(now);
  const date = session === 'OPEN'
    ? exchangeSessionDate(now.toISOString(), US_EQUITY_TIMEZONE)
    : lastCompletedSessionDate(now);
  return `ov-snapshot:${date ?? 'unknown'}`;
}

async function buildSnapshot(now: Date): Promise<OvMarketSnapshot> {
  const session = marketSession(now);
  const sessionDate = session === 'OPEN' ? null : lastCompletedSessionDate(now);
  /*
    The quote key carries the trading date so a completed session's numbers are
    not served against the next one. `latest` while the market is open, where
    the sixty-second window is what bounds staleness instead.
  */
  const dateKey = sessionDate ?? 'latest';

  const loaded = await Promise.all(MARKET_STATUS_INPUTS.map(async (input) => ({
    input,
    quote: await readQuote(input.symbol, `ov-index:${input.symbol}:${dateKey}`),
  })));

  const entries = loaded.map(({ input, quote }) => {
    /*
      The shared resolver picks which pair of prices "today" is the difference
      of. Re-deriving it here would give the product a fifth answer to that
      question — see the header of `src/lib/portfolio/day-change.ts`.
    */
    const basis = resolveDayChangeBasis({
      session,
      price: quote.price,
      previousClose: quote.previousClose,
      snapshot: null,
    });
    const value = basis === null ? null : basis.close;
    const comparisonClose = basis === null ? null : basis.prevClose;
    const changePercent = value !== null && comparisonClose !== null && comparisonClose > 0
      ? ((value - comparisonClose) / comparisonClose) * 100
      : null;
    const reading: OvIndexReading = {
      key: input.key,
      symbol: input.symbol,
      labelTh: input.labelTh,
      proxyLabelTh: input.proxyLabelTh,
      value,
      comparisonClose,
      changePercent,
      asOf: quote.asOf,
    };
    return [input.key, reading] as const;
  });

  const readings = Object.fromEntries(entries) as Record<OvIndexKey, OvIndexReading>;
  const list = entries.map(([, reading]) => reading);
  const status = ovMarketStatus(list);
  const regime = ovRegime(list);

  return {
    readings,
    status,
    availability: status === null ? 'insufficient' : 'available',
    /*
      Withheld together with the headline. The regime is a subtitle under a
      status that is not being shown, and printing it alone would put a claim
      about the money around equities on a card that has just said it cannot
      read equities.
    */
    regime: status === null ? null : regime.regime,
    regimeReasons: status === null ? [] : regime.reasons,
    missing: list.filter((reading) => reading.changePercent === null).map((reading) => reading.key),
    session,
    sessionDate,
    evaluatedAt: now.toISOString(),
    stale: false,
  };
}

/**
 * The last good snapshot, without waiting for anything.
 *
 * Null while the flag is off, and null before the first warm completes — both
 * of which the caller renders as no section at all. `stale` is set when a
 * refresh is running behind the value being returned, so a card can say the
 * numbers are being updated instead of flickering.
 */
export function ovMarketSnapshotView(now: Date = new Date()): OvMarketSnapshot | null {
  if (!phase2MarketSnapshotEnabled()) return null;
  const current = snapshots.read(snapshotKey(now));
  if (!current.value) return null;
  return current.state === 'refreshing'
    ? { ...current.value, stale: true }
    : current.value;
}

/**
 * Refresh in the background. Intended for `after()`, exactly as
 * `warmMarketBreadth` is.
 *
 * A snapshot with no readable equity input is REJECTED rather than committed,
 * so a provider outage cannot overwrite yesterday's usable numbers with a card
 * that says ข้อมูลไม่ครบ. The coordinator keeps the older value and reports it
 * as refreshing.
 */
export function warmOvMarketSnapshot(now: Date = new Date()): Promise<OvMarketSnapshot | null> {
  if (!phase2MarketSnapshotEnabled()) return Promise.resolve(null);
  return snapshots.refresh(
    snapshotKey(now),
    () => buildSnapshot(now),
    (value) => value.availability === 'available',
  );
}

/** Read, and warm first when there is nothing to read. */
export async function loadOvMarketSnapshot(
  now: Date = new Date(),
  force = false,
): Promise<OvMarketSnapshot | null> {
  if (!phase2MarketSnapshotEnabled()) return null;
  const current = ovMarketSnapshotView(now);
  if (!force && current && !current.stale) return current;
  await warmOvMarketSnapshot(now);
  return ovMarketSnapshotView(now);
}
