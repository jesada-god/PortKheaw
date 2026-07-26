import type { NormalizedBar, NormalizedTrade } from './events';

/**
 * Streaming OHLCV aggregation for a single symbol.
 *
 * This is deliberately separate from the batch historical aggregator in
 * `../candles/aggregate` (which folds a finished canonical range using
 * session-relative buckets). Live data is incremental and stateful: trade ticks
 * grow the current minute, official/updated bars reconcile it, and higher
 * timeframes are derived on demand. Buckets are aligned to the **UTC epoch**
 * (`floor(t / window) * window`), matching how Alpaca emits intraday bars, so a
 * 1m bucket always nests cleanly inside its 5m/10m/15m/1h/4h parent.
 */

/** Bucket start in unix **seconds** (lightweight-charts UTCTimestamp). */
export interface RealtimeCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Target intervals the chart can display, in seconds. 1m is the canonical base. */
export const INTERVAL_SECONDS = {
  '1m': 60,
  '5m': 5 * 60,
  '10m': 10 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
} as const;

export type RealtimeInterval = keyof typeof INTERVAL_SECONDS;

export function isRealtimeInterval(value: string): value is RealtimeInterval {
  return value in INTERVAL_SECONDS;
}

/** Epoch-aligned bucket start (seconds) for a timestamp and window. */
export function alignBucketStart(timeSeconds: number, windowSeconds: number): number {
  return Math.floor(timeSeconds / windowSeconds) * windowSeconds;
}

export interface BucketApplyResult {
  /** Whether the event mutated a bucket (false for ignored late/duplicate ticks). */
  applied: boolean;
  /** The 1m bucket start (seconds) the event landed in, or null when ignored. */
  bucketStartSec: number | null;
  /** True when this event opened a new newest bucket, finalizing the previous one. */
  finalizedPrevious: boolean;
}

interface MinuteBucket extends RealtimeCandle {
  /** Set once an official/updated bar has reconciled this bucket. */
  official: boolean;
  /** Newest trade timestamp (ms) folded into this bucket, for the order guard. */
  lastTradeMs: number;
}

const IGNORED: BucketApplyResult = { applied: false, bucketStartSec: null, finalizedPrevious: false };

/**
 * Holds the canonical 1-minute buckets for one symbol and derives higher
 * timeframes on demand. Retains a bounded window of recent minutes so a long
 * session cannot grow memory without bound while still covering the largest
 * (4h = 240 minute) aggregation window several times over.
 */
export class LiveBucketStore {
  private readonly buckets = new Map<number, MinuteBucket>();
  private newestStartSec: number | null = null;
  private readonly maxBuckets: number;

  constructor(options: { maxBuckets?: number } = {}) {
    this.maxBuckets = options.maxBuckets ?? 1_500;
  }

  /**
   * Fold a trade into its 1-minute bucket (open on first trade; high/low/close
   * and volume updated). A trade older than the newest bucket, or one landing in
   * a bucket already reconciled by an official bar, is a late/out-of-order tick
   * and is ignored so it can never reopen or corrupt a finalized minute.
   */
  applyTrade(trade: NormalizedTrade): BucketApplyResult {
    const startSec = alignBucketStart(Math.floor(trade.timestampMs / 1_000), 60);
    if (this.newestStartSec !== null && startSec < this.newestStartSec) return IGNORED;

    const existing = this.buckets.get(startSec);
    if (existing) {
      if (existing.official) return IGNORED; // official bar is authoritative for this minute
      existing.high = Math.max(existing.high, trade.price);
      existing.low = Math.min(existing.low, trade.price);
      // A late trade inside the still-active minute contributes to H/L/volume,
      // but only a provider-newer trade may become the canonical close.
      if (trade.timestampMs >= existing.lastTradeMs) existing.close = trade.price;
      existing.volume += trade.size;
      existing.lastTradeMs = Math.max(existing.lastTradeMs, trade.timestampMs);
      return { applied: true, bucketStartSec: startSec, finalizedPrevious: false };
    }

    const finalizedPrevious = this.newestStartSec !== null && startSec > this.newestStartSec;
    this.buckets.set(startSec, {
      time: startSec,
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      volume: trade.size,
      official: false,
      lastTradeMs: trade.timestampMs,
    });
    this.newestStartSec = Math.max(this.newestStartSec ?? startSec, startSec);
    this.prune();
    return { applied: true, bucketStartSec: startSec, finalizedPrevious };
  }

  /**
   * Reconcile an official (`b`) or updated (`u`) 1-minute bar into its bucket.
   * Keyed by bucket start, so re-delivery of the same bar is idempotent and can
   * never create a duplicate candle. The official bar is authoritative: its
   * OHLCV replaces whatever ticks built, and the bucket is marked final.
   */
  applyBar(bar: NormalizedBar): BucketApplyResult {
    const startSec = alignBucketStart(Math.floor(bar.timestampMs / 1_000), 60);
    const existing = this.buckets.get(startSec);
    const finalizedPrevious = !existing && this.newestStartSec !== null && startSec > this.newestStartSec;
    this.buckets.set(startSec, {
      time: startSec,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      official: bar.finalized !== false,
      lastTradeMs: existing?.lastTradeMs ?? bar.timestampMs,
    });
    this.newestStartSec = Math.max(this.newestStartSec ?? startSec, startSec);
    this.prune();
    return { applied: true, bucketStartSec: startSec, finalizedPrevious };
  }

  /** Canonical 1-minute buckets, ascending by time. */
  minuteBuckets(): RealtimeCandle[] {
    return [...this.buckets.values()]
      .sort((left, right) => left.time - right.time)
      .map(stripInternal);
  }

  /** Aggregated candles for a target interval, ascending. The last may be partial. */
  candles(interval: RealtimeInterval): RealtimeCandle[] {
    return aggregateMinuteBuckets(this.minuteBuckets(), interval);
  }

  /** The current (newest) candle for a target interval, or null when empty. */
  activeCandle(interval: RealtimeInterval): RealtimeCandle | null {
    const all = this.candles(interval);
    return all.length > 0 ? all[all.length - 1] : null;
  }

  private prune(): void {
    if (this.buckets.size <= this.maxBuckets) return;
    const keys = [...this.buckets.keys()].sort((left, right) => left - right);
    const excess = this.buckets.size - this.maxBuckets;
    for (let index = 0; index < excess; index += 1) this.buckets.delete(keys[index]);
  }
}

function stripInternal(bucket: MinuteBucket): RealtimeCandle {
  return {
    time: bucket.time,
    open: bucket.open,
    high: bucket.high,
    low: bucket.low,
    close: bucket.close,
    volume: bucket.volume,
  };
}

/**
 * Aggregate canonical 1-minute candles into a larger epoch-aligned timeframe.
 * Pure and deterministic: buckets are grouped by `floor(time / window) * window`,
 * open is the first minute's open, close the last minute's close, high/low the
 * extremes, and volume the sum. Duplicate or out-of-order input minutes are
 * tolerated because grouping is keyed by aligned start, not arrival order.
 */
export function aggregateMinuteBuckets(
  minutes: readonly RealtimeCandle[],
  interval: RealtimeInterval,
): RealtimeCandle[] {
  const windowSec = INTERVAL_SECONDS[interval];
  // Canonical 1m buckets are unique by start; de-duplicate defensively (last
  // wins) so a re-delivered minute can never be double-counted into a parent.
  const byStart = new Map<number, RealtimeCandle>();
  for (const minute of minutes) byStart.set(minute.time, minute);
  const unique = [...byStart.values()];
  if (windowSec === 60) {
    return unique.sort((left, right) => left.time - right.time);
  }

  const groups = new Map<number, RealtimeCandle[]>();
  for (const minute of unique) {
    const start = alignBucketStart(minute.time, windowSec);
    const group = groups.get(start);
    if (group) group.push(minute);
    else groups.set(start, [minute]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([start, group]) => {
      const ordered = [...group].sort((left, right) => left.time - right.time);
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      return {
        time: start,
        open: first.open,
        high: Math.max(...ordered.map((bar) => bar.high)),
        low: Math.min(...ordered.map((bar) => bar.low)),
        close: last.close,
        volume: ordered.reduce((sum, bar) => sum + bar.volume, 0),
      };
    });
}
