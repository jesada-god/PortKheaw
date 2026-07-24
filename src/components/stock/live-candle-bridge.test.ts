import { describe, expect, it } from 'vitest';
import { matchesLiveSelection, mergeLiveCandleIntoBars, shouldPollChart } from './live-candle-bridge';
import type { LiveCandle } from '@/src/lib/stock-detail/market-source';

const T0 = Math.floor(Date.UTC(2026, 6, 21, 13, 30) / 1_000);
const STEP = 300;

function isoBar(time: number, close: number, volume = 100) {
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
    expect(matchesLiveSelection('1D', 'regular')).toBe(false);
    expect(matchesLiveSelection('Week', 'regular')).toBe(false);
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
    expect(mergeLiveCandleIntoBars(bars, candle(T0 + 2 * STEP, 12, 100))).toBe(bars);
    expect(mergeLiveCandleIntoBars(bars, null)).toBe(bars);
    expect(mergeLiveCandleIntoBars([], candle(T0, 10))).toEqual([]);
  });
});
