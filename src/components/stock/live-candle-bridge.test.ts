import { describe, expect, it } from 'vitest';
import { matchesLiveSelection, mergeLiveCandleIntoBars, shouldPollChart, type ChartDisplayBar } from './live-candle-bridge';
import type { LiveCandle } from '@/src/lib/stock-detail/market-source';

const T0 = Math.floor(Date.UTC(2026, 6, 21, 13, 30) / 1_000);
const STEP = 300;

function isoBar(time: number, close: number, volume: number | null = 100): ChartDisplayBar {
  return { date: new Date(time * 1_000).toISOString(), open: close, high: close, low: close, close, volume };
}

function candle(time: number, close: number, volume = 200): LiveCandle {
  return { time, open: close, high: close, low: close, close, volume };
}

const bars = [isoBar(T0, 10), isoBar(T0 + STEP, 11), isoBar(T0 + 2 * STEP, 12)];

describe('matchesLiveSelection', () => {
  it('matches every intraday selection the shared source now streams', () => {
    expect(matchesLiveSelection('5m', 'regular')).toBe(true);
    expect(matchesLiveSelection('1m', 'regular')).toBe(true);
    expect(matchesLiveSelection('5m', 'extended')).toBe(true);
    expect(matchesLiveSelection('4h', 'extended')).toBe(true);
  });

  it('never matches history-only or unsupported selections', () => {
    expect(matchesLiveSelection('1D', 'regular')).toBe(true);
    expect(matchesLiveSelection('Week', 'regular')).toBe(true);
    expect(matchesLiveSelection('1D', 'extended')).toBe(false);
  });
});

describe('shouldPollChart', () => {
  const base = { active: true, appActive: true, hasResult: true, dataStatus: 'real-time', coveredByLiveSource: false };

  it('never runs a second loop when the shared source covers the bucket', () => {
    expect(shouldPollChart({ ...base, coveredByLiveSource: true })).toBe(false);
  });

  it('polls only for live-eligible selections the shared source does not cover', () => {
    expect(shouldPollChart(base)).toBe(true);
    expect(shouldPollChart({ ...base, dataStatus: 'live' })).toBe(true);
    expect(shouldPollChart({ ...base, dataStatus: 'partial' })).toBe(true);
    expect(shouldPollChart({ ...base, dataStatus: 'delayed' })).toBe(false);
    expect(shouldPollChart({ ...base, hasResult: false })).toBe(false);
    expect(shouldPollChart({ ...base, active: false })).toBe(false);
    expect(shouldPollChart({ ...base, appActive: false })).toBe(false);
  });

  it('never rapid-polls a Daily/Week/Month (history-only) selection', () => {
    // History-only series load once (end-of-day / cached / stale) and are not
    // covered by the live source, so the chart never runs a recurring poll.
    expect(shouldPollChart({ ...base, coveredByLiveSource: false, dataStatus: 'end-of-day' })).toBe(false);
    expect(shouldPollChart({ ...base, coveredByLiveSource: false, dataStatus: 'cached' })).toBe(false);
    expect(shouldPollChart({ ...base, coveredByLiveSource: false, dataStatus: 'stale' })).toBe(false);
  });
});

describe('mergeLiveCandleIntoBars', () => {
  it('updates the same bucket in place without changing length', () => {
    const merged = mergeLiveCandleIntoBars(bars, candle(T0 + 2 * STEP, 12.5, 250));
    expect(merged).toHaveLength(bars.length);
    expect(merged).not.toBe(bars);
    expect(merged.at(-1)).toMatchObject({ close: 12.5, volume: 250 });
    // Prior buckets are untouched.
    expect(merged[0]).toBe(bars[0]);
    expect(merged[1]).toBe(bars[1]);
  });

  it('appends exactly one bar for a strictly newer bucket', () => {
    const merged = mergeLiveCandleIntoBars(bars, candle(T0 + 3 * STEP, 13));
    expect(merged).toHaveLength(bars.length + 1);
    expect(merged.at(-1)).toMatchObject({ close: 13 });
    expect(merged.slice(0, bars.length)).toEqual(bars);
  });

  it('ignores a stale / out-of-order bucket', () => {
    const merged = mergeLiveCandleIntoBars(bars, candle(T0 + STEP, 99));
    expect(merged).toBe(bars);
  });

  it('returns the same reference when nothing changed (idle tick)', () => {
    // The first tick still has to mark the bucket as forming, so it copies once.
    const marked = mergeLiveCandleIntoBars(bars, candle(T0 + 2 * STEP, 12, 100));
    expect(marked).not.toBe(bars);
    expect(marked.at(-1)?.partial).toBe(true);
    // With the bucket already marked, an identical tick is a true no-op.
    expect(mergeLiveCandleIntoBars(marked, candle(T0 + 2 * STEP, 12, 100))).toBe(marked);
    expect(mergeLiveCandleIntoBars(bars, null)).toBe(bars);
    expect(mergeLiveCandleIntoBars([], candle(T0, 10))).toEqual([]);
  });

  it('marks the live bucket partial so analytics never read an unfinished bar', () => {
    // Same bucket, newer bucket and the daily branch must all agree: the bucket
    // the accepted live candle belongs to is still forming.
    expect(mergeLiveCandleIntoBars(bars, candle(T0 + 2 * STEP, 12.5)).at(-1)?.partial).toBe(true);
    expect(mergeLiveCandleIntoBars(bars, candle(T0 + 3 * STEP, 13)).at(-1)?.partial).toBe(true);
    const daily: ChartDisplayBar[] = [{ date: '2026-07-24T04:00:00.000Z', open: 100, high: 103, low: 99, close: 102, volume: 500 }];
    const live = candle(Math.floor(Date.UTC(2026, 6, 24, 18, 0) / 1_000), 104, 25);
    expect(mergeLiveCandleIntoBars(daily, live, '1D').at(-1)?.partial).toBe(true);
    // Completed history buckets keep their own flag.
    expect(mergeLiveCandleIntoBars(bars, candle(T0 + 2 * STEP, 12.5))[0].partial).toBeUndefined();
  });

  it('never fabricates a volume the provider did not report', () => {
    const withoutVolume: ChartDisplayBar[] = [
      { date: new Date(T0 * 1_000).toISOString(), open: 10, high: 10, low: 10, close: 10, volume: null },
      { date: new Date((T0 + STEP) * 1_000).toISOString(), open: 11, high: 11, low: 11, close: 11, volume: null },
    ];
    // A live candle with no size leaves the slot unavailable rather than 0.
    const noSize = { time: T0 + 2 * STEP, open: 11, high: 11, low: 11, close: 11, volume: null } as unknown as LiveCandle;
    expect(mergeLiveCandleIntoBars(withoutVolume, noSize).at(-1)?.volume).toBeNull();
    // A real live size fills a previously unavailable slot with the real value.
    const daily: ChartDisplayBar[] = [{ date: '2026-07-24T04:00:00.000Z', open: 100, high: 103, low: 99, close: 102, volume: null }];
    const live = candle(Math.floor(Date.UTC(2026, 6, 24, 18, 0) / 1_000), 104, 25);
    expect(mergeLiveCandleIntoBars(daily, live, '1D').at(-1)?.volume).toBe(25);
  });

  it('merges a live delta into todays daily bar without replacing history or adding provider volumes', () => {
    const daily: ChartDisplayBar[] = [
      { date: '2026-07-23T04:00:00.000Z', open: 95, high: 101, low: 94, close: 100, volume: 1_000 },
      { date: '2026-07-24T04:00:00.000Z', open: 100, high: 103, low: 99, close: 102, volume: 500 },
    ];
    const live = candle(Math.floor(Date.UTC(2026, 6, 24, 18, 0) / 1_000), 104, 25);
    const merged = mergeLiveCandleIntoBars(daily, live, '1D');
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(daily[0]);
    expect(merged[1]).toMatchObject({ open: 100, high: 104, low: 99, close: 104, volume: 500 });
  });
});
