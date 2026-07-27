import type { CandleInterval, CandleRange, NormalizedCandle } from './contracts';

/**
 * Calendar days fetched for the `1d` range.
 *
 * `1d` means "the most recent trading session", not "the last 24 clock hours".
 * Evaluated on a Saturday, a holiday or before the open, a literal 24-hour window
 * contains no trades at all — the provider then correctly returns an empty series
 * and the chart has nothing to draw. Fetching a bounded multi-day window and
 * keeping only the newest exchange-local trading date (see
 * {@link latestTradingDayCandles}) always lands on a real session while still
 * using nothing but real provider bars.
 *
 * Five days covers a long weekend plus an adjacent market holiday and stays
 * inside the 8-day cap Yahoo enforces on 1-minute history.
 */
const LATEST_SESSION_LOOKBACK_DAYS = 5;
export const FIVE_YEAR_LOOKBACK_DAYS = 1_825;

/**
 * The shortest calendar lookback each range can guarantee. `ytd` is one day at
 * the start of a year, so it cannot satisfy a multi-year history contract.
 */
const RANGE_MIN_LOOKBACK_DAYS: Record<CandleRange, number> = {
  '1d': 1,
  '5d': 5,
  '1m': 28,
  '3m': 89,
  '6m': 181,
  ytd: 1,
  '1y': 365,
  '3y': 1_095,
  '5y': FIVE_YEAR_LOOKBACK_DAYS,
};

/** Weekly and wider candles always load at least five years of real history. */
export function minimumLookbackDays(interval: CandleInterval): number | null {
  return interval === 'Week' || interval === 'Month' ? FIVE_YEAR_LOOKBACK_DAYS : null;
}

export function rangeMeetsMinimumLookback(interval: CandleInterval, range: CandleRange): boolean {
  const minimum = minimumLookbackDays(interval);
  return minimum === null || RANGE_MIN_LOOKBACK_DAYS[range] >= minimum;
}

/** Canonical server lookback; never fabricates bars for a younger listing. */
export function canonicalCandleRange(interval: CandleInterval, range: CandleRange): CandleRange {
  return rangeMeetsMinimumLookback(interval, range) ? range : '5y';
}

/**
 * Widen explicit period bounds when a higher-timeframe caller supplied less than
 * five calendar years. The end instant is preserved and only the start moves.
 */
export function canonicalCandleBounds(
  interval: CandleInterval,
  bounds: { period1: number; period2: number },
): { period1: number; period2: number } {
  if (minimumLookbackDays(interval) === null) return bounds;
  const earliest = new Date(bounds.period2 * 1_000);
  earliest.setUTCFullYear(earliest.getUTCFullYear() - 5);
  return {
    period1: Math.min(bounds.period1, Math.floor(earliest.valueOf() / 1_000)),
    period2: bounds.period2,
  };
}

export function candleRangeBounds(
  range: CandleRange,
  now = new Date(),
): { period1: number; period2: number } {
  const end = new Date(now);
  const start = new Date(now);
  if (range === '1d') start.setUTCDate(start.getUTCDate() - LATEST_SESSION_LOOKBACK_DAYS);
  else if (range === '5d') start.setUTCDate(start.getUTCDate() - 5);
  else if (range === '1m') start.setUTCMonth(start.getUTCMonth() - 1);
  else if (range === '3m') start.setUTCMonth(start.getUTCMonth() - 3);
  else if (range === '6m') start.setUTCMonth(start.getUTCMonth() - 6);
  else if (range === 'ytd') start.setUTCMonth(0, 1), start.setUTCHours(0, 0, 0, 0);
  else if (range === '1y') start.setUTCFullYear(start.getUTCFullYear() - 1);
  else if (range === '3y') start.setUTCFullYear(start.getUTCFullYear() - 3);
  else start.setUTCFullYear(start.getUTCFullYear() - 5);
  return { period1: Math.floor(start.valueOf() / 1_000), period2: Math.floor(end.valueOf() / 1_000) };
}

export function isoDateFromEpoch(seconds: number): string {
  return new Date(seconds * 1_000).toISOString().slice(0, 10);
}

/**
 * Keeps only the candles belonging to the newest exchange-local trading date
 * present in the series — the `1d` range's "most recent trading session".
 *
 * Selection is by exchange-local calendar date, so a session is never split by a
 * UTC midnight that falls inside it. Nothing is added, resampled or moved: the
 * result is a contiguous tail of the input, and an empty input stays empty.
 */
export function latestTradingDayCandles(
  candles: readonly NormalizedCandle[],
  exchangeTimezone: string,
): NormalizedCandle[] {
  if (candles.length === 0) return [];
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: exchangeTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dateOf = (seconds: number) => format.format(new Date(seconds * 1_000));
  const newest = dateOf(candles.reduce((latest, candle) => Math.max(latest, candle.timestamp), 0));
  return candles.filter((candle) => dateOf(candle.timestamp) === newest);
}
