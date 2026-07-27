import type { CandleInterval, CandleRange, NormalizedCandle } from './contracts';
import {
  EARLY_CLOSE_MINUTE,
  isUsMarketEarlyClose,
  isUsTradingDay,
  US_MARKET_TIMEZONE,
} from '../us-market-calendar';

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

function exchangeClock(date: Date, timeZone: string): { date: string; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minute: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

function periodStart(date: string, interval: 'Week' | 'Month'): string {
  if (interval === 'Month') return `${date.slice(0, 7)}-01`;
  const value = new Date(`${date}T12:00:00.000Z`);
  const weekday = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() - weekday + 1);
  return value.toISOString().slice(0, 10);
}

function finalUsTradingDate(period: string, interval: 'Week' | 'Month'): string | null {
  const start = new Date(`${period}T12:00:00.000Z`);
  const end = interval === 'Week'
    ? new Date(start.valueOf() + 4 * 86_400_000)
    : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0, 12));
  const maximumSteps = interval === 'Week' ? 5 : 10;
  for (let step = 0; step < maximumSteps; step += 1) {
    const candidate = new Date(end.valueOf() - step * 86_400_000).toISOString().slice(0, 10);
    if (isUsTradingDay(candidate)) return candidate;
  }
  return null;
}

/**
 * Remove provider rows whose weekly/monthly regular-session bucket has not
 * closed yet. Some native HTF feeds omit `partial: true`, so that flag alone is
 * not a finalization contract.
 */
export function finalizedHigherTimeframeCandles(
  candles: readonly NormalizedCandle[],
  interval: 'Week' | 'Month',
  exchangeTimezone: string,
  now = new Date(),
): NormalizedCandle[] {
  const current = exchangeClock(now, exchangeTimezone);
  const currentPeriod = periodStart(current.date, interval);

  return candles.filter((candle) => {
    if (candle.partial === true) return false;
    const candleDate = exchangeClock(new Date(candle.timestamp * 1_000), exchangeTimezone).date;
    const candlePeriod = periodStart(candleDate, interval);
    if (candlePeriod < currentPeriod) return true;
    if (candlePeriod > currentPeriod) return false;

    // US equities finalize at the last regular close in the bucket. For any
    // other exchange, wait until the next calendar bucket rather than guessing
    // its holiday or early-close rules.
    if (exchangeTimezone !== US_MARKET_TIMEZONE) return false;
    const finalDate = finalUsTradingDate(candlePeriod, interval);
    if (!finalDate || current.date < finalDate) return false;
    if (current.date > finalDate) return true;
    const closeMinute = isUsMarketEarlyClose(finalDate) ? EARLY_CLOSE_MINUTE : 16 * 60;
    return current.minute >= closeMinute;
  });
}
