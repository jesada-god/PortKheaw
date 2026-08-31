import 'server-only';

import { getCandleMarketDataService } from '@/src/lib/market-data/candles';
import {
  lastCompletedSessionDate,
  type MarketSession,
} from '@/src/lib/market-data/market-session';
import { MARKET_SIGNAL_STATUS, type StatusLevel } from '@/src/lib/presentation/status';
import type { MarketSignalResult } from '@/src/lib/analytics/market-signal/types';
import { mapWithConcurrency } from '@/src/lib/overview/service';
import type { WatchlistRow } from './rows';
import {
  whatChanged,
  type DailyBar,
  type WhatChangedInput,
  type WhatChangedItem,
} from './what-changed';

/**
 * Feeding the detectors, and paying nothing extra to do it.
 *
 * ===========================================================================
 * THE BARS ARE A CACHE HIT, BY CONSTRUCTION
 * ===========================================================================
 * Three of the six detectors need daily history, which this product has exactly
 * one source for: `getCandleMarketDataService()`, a process-local singleton
 * with a six-hour fresh window, a seven-day stale window and in-flight dedupe.
 * The signal engine asks it for `1D / 5y / adjusted / regular` for every symbol
 * on the page, moments earlier, in the same render.
 *
 * So {@link CANDLE_REQUEST} is that request, byte for byte. A different range,
 * a different session, or `adjusted: false` would build a different cache key
 * and turn a free read into a second provider fetch per symbol — the request
 * shape IS the reuse, which is why it is a named constant with this note on it
 * rather than an object literal at the call site.
 *
 * The other half of the guarantee is {@link barsFor} being called ONLY for
 * symbols whose signal came back available. A reader who has not bought the
 * Technical Outlook never runs the engine (`loadEntitledMarketSignal` returns
 * null without touching candles), so for them there is no warm cache and a bar
 * load would be a brand-new fan-out of provider requests for a card they did
 * not ask for. Those symbols therefore get no bars, the three bar-reading
 * detectors stay silent on them, and the two that need no history still work.
 * That is the module's own "input ไม่ครบ ต้องเงียบ" rule, applied to itself.
 *
 * ===========================================================================
 * NOTHING IS RECOMPUTED HERE
 * ===========================================================================
 * The day figure is the row's, from the shared day-change rule. The trend is
 * `watchlistTrend`'s, already through the bounded interval. Support and
 * resistance are the signal engine's own metrics, already on the row. The
 * report date is the earnings service's. This file's whole job is to put four
 * existing answers into one shape and hand it to a pure function.
 */

/**
 * The candle request, identical to `loadMarketSignal`'s.
 *
 * Changing any field here silently doubles the page's provider cost. See above.
 */
const CANDLE_REQUEST = {
  interval: '1D',
  range: '5y',
  adjusted: true,
  session: 'regular',
} as const;

/** Matches the signal fan-out's own cap, and for the same reason. */
const BAR_CONCURRENCY = 4;

/**
 * The daily bars for one symbol, oldest first, or an empty array.
 *
 * Every failure is an empty array rather than a throw. A card that is allowed
 * to be absent must never be able to take the page with it, and empty bars are
 * already the input the detectors treat as "say nothing".
 */
async function barsFor(symbol: string): Promise<DailyBar[]> {
  try {
    const result = await getCandleMarketDataService().getCandles({ symbol, ...CANDLE_REQUEST });
    return result.data.candles.map((candle) => ({
      date: new Date(candle.timestamp * 1_000).toISOString().slice(0, 10),
      open: candle.open,
      close: candle.close,
      volume: candle.volume,
      /* The engine's own reading of "this session has finished". */
      finalized: candle.partial !== true,
    }));
  } catch {
    return [];
  }
}

/**
 * The level of the most recent reading BEFORE the newest one, or null.
 *
 * Read off `state` and not `rawState`, which is the opposite of what
 * `currentRawLabelDays` is for and is right for a different reason. That field
 * is forbidden to the card because it measures label AGE, and §6.8 of
 * `docs/signal-handover.md` will not have an older label presented as a better
 * one. This is not an age: it is "the word on this row is different from the
 * word that was on it", and the word the product actually published is `state`,
 * hold rule included. Comparing raw readings would announce changes the reader
 * never saw, and would announce them on days the hold rule had deliberately
 * kept quiet.
 *
 * Null whenever the comparison cannot be made — history off, a single recorded
 * day, or a symbol nobody has opened before. The detector is then silent, which
 * is the correct answer rather than a degraded one.
 */
export function previousTrendLevelOf(signal: MarketSignalResult | null): StatusLevel | null {
  if (signal === null || signal.status !== 'available') return null;
  const entries = signal.history?.entries;
  if (!entries || entries.length < 2) return null;
  /*
    Entries are documented oldest-first and GAPPY: a row exists for a day only
    if somebody computed the signal that day. So "the previous reading" is the
    newest row that is not the newest row, which may be a week old — and the
    sentence the detector writes makes no claim about when, precisely because
    this cannot support one.
  */
  const newest = entries.reduce((latest, entry) => (entry.asOf > latest ? entry.asOf : latest), '');
  const earlier = entries.filter((entry) => entry.asOf < newest);
  if (earlier.length === 0) return null;
  const previous = earlier.reduce((latest, entry) => (entry.asOf > latest.asOf ? entry : latest));
  return MARKET_SIGNAL_STATUS[previous.state] ?? null;
}

/**
 * The close of the session before the newest bar.
 *
 * Taken from the bars rather than reconstructed from the quote's `change`,
 * because those two are not the same number outside a running session: once the
 * market is shut the row's change describes the session that FINISHED, so
 * `price - change` is the close before that one, not the close the current
 * price should be compared against. The bar series already encodes which
 * session is which, in both states, without a branch on the session.
 */
function previousCloseOf(bars: readonly DailyBar[]): number | null {
  if (bars.length < 2) return null;
  return bars[bars.length - 2]!.close;
}

export interface WhatChangedSection {
  /** Already capped and ordered. Empty means the page renders no section. */
  items: WhatChangedItem[];
  session: MarketSession;
  /**
   * The completed trading date the items are about, or null while a session is
   * running.
   *
   * The same question `lastCompletedSessionDate` answers for the day figure and
   * the same answer, so the card and the %วันนี้ column cannot caption one
   * render with two different days.
   */
  sessionDate: string | null;
}

export interface WhatChangedInputBundle {
  rows: readonly WatchlistRow[];
  signals: ReadonlyMap<string, MarketSignalResult | null>;
  session: MarketSession;
  now: Date;
  /**
   * How many items survive the cap. Defaults to `WHAT_CHANGED_LIMIT`.
   *
   * A parameter rather than a second constant, because the cap is a statement
   * about ATTENTION on one surface and the two surfaces have different amounts
   * of it: the watchlist card sits above the rows it describes and shows five,
   * the overview section is one of six blocks and shows eight. What survives is
   * still decided by `capWhatChanged`'s total order, so the overview's extra
   * three are the next three by importance and never a different three.
   */
  limit?: number;
}

/** One row's inputs, with whatever the loaders managed to supply. */
function inputFor(
  row: WatchlistRow,
  signal: MarketSignalResult | null,
  bars: readonly DailyBar[],
): WhatChangedInput {
  return {
    symbol: row.symbol,
    dayChangePercent: row.day.changePercent,
    bars,
    price: row.price,
    previousClose: previousCloseOf(bars),
    support: row.expanded.support,
    resistance: row.expanded.resistance,
    trend: row.trend,
    previousTrendLevel: previousTrendLevelOf(signal),
    earningsDays: row.expanded.earningsDays,
  };
}

/**
 * What changed across one watchlist, ready to render or to leave out.
 *
 * The caller decides whether to ask at all — the flag is checked one level up,
 * in `loadWatchlistView`, so that a reader with the card switched off pays for
 * none of the bar loads below.
 */
export async function loadWhatChanged(bundle: WhatChangedInputBundle): Promise<WhatChangedSection> {
  const sessionDate = bundle.session === 'OPEN' ? null : lastCompletedSessionDate(bundle.now);

  /*
    Only symbols with a signal. That is the cache-hit guarantee, and it is also
    what stops an unentitled reader's page from opening a fan-out of provider
    requests for history nothing else on the page is going to use.
  */
  const withSignal = bundle.rows.filter((row) => {
    const signal = bundle.signals.get(row.symbol);
    return signal != null && signal.status === 'available';
  });

  const loaded = await mapWithConcurrency(
    withSignal,
    BAR_CONCURRENCY,
    async (row) => [row.symbol, await barsFor(row.symbol)] as const,
  );
  const barsBySymbol = new Map(loaded);

  return {
    items: whatChanged(bundle.rows.map((row) => inputFor(
      row,
      bundle.signals.get(row.symbol) ?? null,
      barsBySymbol.get(row.symbol) ?? [],
    )), bundle.limit),
    session: bundle.session,
    sessionDate,
  };
}
