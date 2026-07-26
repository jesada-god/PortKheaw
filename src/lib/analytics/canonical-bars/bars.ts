/**
 * Canonical OHLCV — the chart's single source of truth.
 *
 * Every drawn series (candles, volume, Heikin-Ashi), every indicator (EMA, RSI,
 * MACD), the visible-range volume profile and the S/R statistics derive from one
 * normalized `CanonicalBar[]`. Nothing downstream is allowed to re-filter with a
 * different predicate: that is exactly how a price series and its volume series
 * end up on different timestamps and the candles appear to run ahead of the
 * volume columns.
 *
 * Normalization rules (deterministic, provider-agnostic):
 *  - a row whose OHLC is not finite, or whose high/low contradict the bar, is
 *    rejected outright (it has no truthful position on the timeline),
 *  - an unavailable volume stays `null` on its own time slot; it is never
 *    coerced to `0` and the price bar is never dropped, so the x-axis cannot
 *    shift,
 *  - duplicate canonical times collapse with the last provider row winning,
 *  - the result is sorted ascending by time.
 */

/** A provider row as it arrives at the chart boundary. */
export interface CanonicalBarInput {
  /** ISO string, `YYYY-MM-DD`, epoch seconds or epoch milliseconds. */
  date?: unknown;
  /** Alternative spelling accepted from callers that name the field `time`. */
  time?: unknown;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume?: unknown;
  partial?: unknown;
}

export interface CanonicalBar {
  /** Bucket start as epoch **seconds** (UTC). The only x-position authority. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /**
   * Real provider volume for the bucket, or `null` when the provider reported
   * none. Never coerced to `0`: a fabricated zero draws an invisible histogram
   * column, which is indistinguishable from "this candle has no volume yet".
   */
  volume: number | null;
  /** True while the bucket is still forming. */
  partial: boolean;
}

/** One price point, 1:1 with {@link CanonicalVolumePoint} by construction. */
export interface CanonicalPricePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** One volume point, 1:1 with {@link CanonicalPricePoint} by construction. */
export interface CanonicalVolumePoint {
  time: number;
  /** `null` when the provider reported no volume for this slot. */
  value: number | null;
  available: boolean;
  direction: 'up' | 'down';
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Epoch seconds past this magnitude are milliseconds (year ~2286 in seconds). */
const MILLISECOND_THRESHOLD = 1e11;

/**
 * Canonical bucket start in epoch **seconds**.
 *
 * A bare `YYYY-MM-DD` is a UTC midnight instant so daily bars from different
 * providers land on the same slot regardless of the reader's local timezone.
 */
export function toEpochSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const seconds = Math.abs(value) >= MILLISECOND_THRESHOLD ? value / 1_000 : value;
    return seconds > 0 ? Math.floor(seconds) : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const parsed = ISO_DATE.test(text) ? new Date(`${text}T00:00:00.000Z`) : new Date(text);
  const ms = parsed.valueOf();
  return Number.isNaN(ms) || ms <= 0 ? null : Math.floor(ms / 1_000);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The only OHLCV normalization step at the chart boundary. Callers must not
 * re-filter the result with a different predicate.
 */
export function normalizeCanonicalBars(rows: readonly CanonicalBarInput[]): CanonicalBar[] {
  const byTime = new Map<number, CanonicalBar>();
  for (const row of rows) {
    const time = toEpochSeconds(row.time ?? row.date);
    const open = finite(row.open);
    const high = finite(row.high);
    const low = finite(row.low);
    const close = finite(row.close);
    if (time == null || open == null || high == null || low == null || close == null) continue;
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) continue;
    const candidate = finite(row.volume);
    byTime.set(time, {
      time,
      open,
      high,
      low,
      close,
      volume: candidate != null && candidate >= 0 ? candidate : null,
      partial: row.partial === true,
    });
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

/**
 * Fails loudly when a price point and a volume point ever drift apart. Both
 * series are produced from the same array by {@link deriveCanonicalSeries}, so a
 * throw here means a caller reintroduced a second filtering path.
 */
export function assertAlignedSeries(
  price: readonly { time: number }[],
  volume: readonly { time: number }[],
): void {
  if (price.length !== volume.length) {
    throw new Error(`Canonical price/volume length mismatch: ${price.length} vs ${volume.length}`);
  }
  for (let index = 0; index < price.length; index += 1) {
    if (price[index].time !== volume[index].time) {
      throw new Error(`Canonical price/volume timestamp mismatch at index ${index}`);
    }
  }
}

/** Derives both drawable series from one bar array, guaranteeing 1:1 timestamps. */
export function deriveCanonicalSeries(bars: readonly CanonicalBar[]): {
  price: CanonicalPricePoint[];
  volume: CanonicalVolumePoint[];
} {
  const price = bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
  const volume = bars.map((bar) => ({
    time: bar.time,
    value: bar.volume,
    available: bar.volume != null,
    direction: bar.close >= bar.open ? ('up' as const) : ('down' as const),
  }));
  assertAlignedSeries(price, volume);
  return { price, volume };
}

/** Maps a bucket start (epoch seconds) for every bar; the aggregation grouping key. */
export type BucketResolver = (time: number) => number;

/** Fixed-width buckets anchored on the epoch — deterministic for every minute/hour multiple. */
export function epochBuckets(seconds: number): BucketResolver {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new RangeError('Bucket width must be a positive integer of seconds');
  return (time) => Math.floor(time / seconds) * seconds;
}

/**
 * Session-anchored buckets: each exchange-local trading day restarts the grid at
 * that day's first bar, so a 45m bucket begins at the session open instead of an
 * arbitrary epoch offset.
 */
export function sessionBuckets(seconds: number, timeZone: string, bars: readonly CanonicalBar[]): BucketResolver {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new RangeError('Bucket width must be a positive integer of seconds');
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayKey = (time: number) => format.format(new Date(time * 1_000));
  const anchors = new Map<string, number>();
  for (const bar of bars) {
    const key = dayKey(bar.time);
    if (!anchors.has(key)) anchors.set(key, bar.time);
  }
  return (time) => {
    const anchor = anchors.get(dayKey(time));
    if (anchor === undefined) return Math.floor(time / seconds) * seconds;
    return anchor + Math.floor((time - anchor) / seconds) * seconds;
  };
}

/** Calendar-week buckets keyed on the exchange-local Monday. */
export function weekBuckets(timeZone: string): BucketResolver {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (time) => {
    const local = new Date(`${format.format(new Date(time * 1_000))}T00:00:00.000Z`);
    const weekday = local.getUTCDay() || 7;
    local.setUTCDate(local.getUTCDate() - weekday + 1);
    return Math.floor(local.valueOf() / 1_000);
  };
}

/**
 * Aggregates canonical bars into wider buckets.
 *
 *   Open   = first bar's open
 *   High   = max(high)
 *   Low    = min(low)
 *   Close  = last bar's close
 *   Volume = sum(volume)
 *
 * Volume sums only the slots that actually reported one; a bucket whose members
 * all lack volume stays `null` rather than reporting a fabricated `0`. A bucket
 * containing any still-forming member is itself partial.
 */
export function aggregateCanonicalBars(
  bars: readonly CanonicalBar[],
  bucketOf: BucketResolver,
): CanonicalBar[] {
  const ordered = [...bars].sort((left, right) => left.time - right.time);
  const buckets = new Map<number, CanonicalBar[]>();
  for (const bar of ordered) {
    const key = bucketOf(bar.time);
    const group = buckets.get(key);
    if (group) group.push(bar);
    else buckets.set(key, [bar]);
  }
  return [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([time, group]) => {
      const withVolume = group.filter((bar) => bar.volume != null);
      return {
        time,
        open: group[0].open,
        high: Math.max(...group.map((bar) => bar.high)),
        low: Math.min(...group.map((bar) => bar.low)),
        close: group[group.length - 1].close,
        volume: withVolume.length ? withVolume.reduce((sum, bar) => sum + (bar.volume as number), 0) : null,
        partial: group.some((bar) => bar.partial),
      };
    });
}

/** Drops the still-forming bucket so analytics never read an unfinished bar. */
export function finalizedBars(bars: readonly CanonicalBar[]): CanonicalBar[] {
  return bars.filter((bar) => !bar.partial);
}
