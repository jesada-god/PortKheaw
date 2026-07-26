import { describe, expect, it } from 'vitest';
import {
  aggregateCanonicalBars,
  assertAlignedSeries,
  deriveCanonicalSeries,
  epochBuckets,
  finalizedBars,
  normalizeCanonicalBars,
  sessionBuckets,
  toEpochSeconds,
  weekBuckets,
  type CanonicalBar,
} from './bars';
import { toDisplayBars } from './display';
import { heikinAshi } from '../chart-types/calculations';

const MINUTE = 60;
/** 2026-01-05T14:30:00Z — a Monday, 09:30 New York. */
const OPEN = Date.UTC(2026, 0, 5, 14, 30) / 1_000;

function minuteBars(count: number, start = OPEN): CanonicalBar[] {
  return Array.from({ length: count }, (_, index) => ({
    time: start + index * MINUTE,
    open: 100 + index,
    high: 100 + index + 2,
    low: 100 + index - 1,
    close: 100 + index + 1,
    volume: 1_000 + index,
    partial: false,
  }));
}

describe('canonical bar normalization', () => {
  it('gives candles and volume the exact same timestamps, one per slot', () => {
    const bars = normalizeCanonicalBars(minuteBars(5));
    const { price, volume } = deriveCanonicalSeries(bars);
    expect(price).toHaveLength(volume.length);
    price.forEach((point, index) => expect(point.time).toBe(volume[index].time));
    expect(() => assertAlignedSeries(price, volume)).not.toThrow();
  });

  it('sorts provider rows ascending regardless of arrival order', () => {
    const rows = [...minuteBars(4)].reverse();
    const bars = normalizeCanonicalBars(rows);
    expect(bars.map((bar) => bar.time)).toEqual([OPEN, OPEN + 60, OPEN + 120, OPEN + 180]);
  });

  it('collapses duplicate timestamps with the last provider row winning', () => {
    const bars = normalizeCanonicalBars([
      { time: OPEN, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { time: OPEN, open: 1, high: 3, low: 0.5, close: 2.5, volume: 20 },
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBe(2.5);
    expect(bars[0].volume).toBe(20);
  });

  it('keeps a price bar whose volume is missing and marks the volume unavailable', () => {
    const bars = normalizeCanonicalBars([
      { time: OPEN, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { time: OPEN + 60, open: 1.5, high: 2.5, low: 1, close: 2, volume: null },
      { time: OPEN + 120, open: 2, high: 3, low: 1.5, close: 2.5, volume: 30 },
    ]);
    expect(bars).toHaveLength(3);
    expect(bars[1].volume).toBeNull();
    const { price, volume } = deriveCanonicalSeries(bars);
    // The x-axis must not shift: the slot is still present, just not available.
    expect(price[1].time).toBe(volume[1].time);
    expect(volume[1].available).toBe(false);
    expect(volume[1].value).toBeNull();
  });

  it('never coerces an unavailable volume into a fabricated zero', () => {
    const bars = normalizeCanonicalBars([{ time: OPEN, open: 1, high: 2, low: 0.5, close: 1.5 }]);
    expect(bars[0].volume).toBeNull();
    expect(bars[0].volume).not.toBe(0);
  });

  it('rejects rows whose OHLC cannot be true and keeps the rest aligned', () => {
    const bars = normalizeCanonicalBars([
      { time: OPEN, open: 1, high: 0.5, low: 0.4, close: 0.9 }, // high below close
      { time: OPEN + 60, open: 1, high: 2, low: 0.5, close: 1.5, volume: 5 },
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0].time).toBe(OPEN + 60);
  });

  it('accepts seconds, milliseconds, ISO strings and plain dates on one canonical scale', () => {
    expect(toEpochSeconds(OPEN)).toBe(OPEN);
    expect(toEpochSeconds(OPEN * 1_000)).toBe(OPEN);
    expect(toEpochSeconds('2026-01-05T14:30:00.000Z')).toBe(OPEN);
    expect(toEpochSeconds('2026-01-05')).toBe(Date.UTC(2026, 0, 5) / 1_000);
    expect(toEpochSeconds('not-a-date')).toBeNull();
  });

  it('reports a candle/volume drift instead of silently rendering it', () => {
    expect(() => assertAlignedSeries([{ time: 1 }, { time: 2 }], [{ time: 1 }])).toThrow(/length mismatch/);
    expect(() => assertAlignedSeries([{ time: 1 }, { time: 2 }], [{ time: 1 }, { time: 3 }])).toThrow(/timestamp mismatch/);
  });
});

describe('canonical aggregation', () => {
  const cases: Array<[string, number]> = [
    ['2m', 2], ['3m', 3], ['10m', 10], ['30m', 30], ['45m', 45],
  ];

  it.each(cases)('aggregates 1m into %s with first-open/max-high/min-low/last-close/sum-volume', (_label, minutes) => {
    const source = normalizeCanonicalBars(minuteBars(minutes * 2));
    const aggregated = aggregateCanonicalBars(source, epochBuckets(minutes * MINUTE));
    expect(aggregated.length).toBeGreaterThanOrEqual(2);
    const firstGroup = source.filter((bar) => bar.time < aggregated[1].time);
    expect(aggregated[0].open).toBe(firstGroup[0].open);
    expect(aggregated[0].high).toBe(Math.max(...firstGroup.map((bar) => bar.high)));
    expect(aggregated[0].low).toBe(Math.min(...firstGroup.map((bar) => bar.low)));
    expect(aggregated[0].close).toBe(firstGroup[firstGroup.length - 1].close);
    expect(aggregated[0].volume).toBe(firstGroup.reduce((sum, bar) => sum + (bar.volume ?? 0), 0));
  });

  it.each([['2h', 120], ['3h', 180], ['4h', 240]])('aggregates 1m into %s', (_label, minutes) => {
    const source = normalizeCanonicalBars(minuteBars(minutes + 5));
    const aggregated = aggregateCanonicalBars(source, epochBuckets(minutes * MINUTE));
    expect(aggregated.length).toBeGreaterThan(1);
    const total = aggregated.reduce((sum, bar) => sum + (bar.volume ?? 0), 0);
    expect(total).toBe(source.reduce((sum, bar) => sum + (bar.volume ?? 0), 0));
  });

  it('aggregates daily bars into calendar weeks anchored on the exchange Monday', () => {
    // Daily bars carry an exchange-session timestamp (09:30 New York), so the
    // local calendar week is unambiguous.
    const daily = normalizeCanonicalBars(Array.from({ length: 10 }, (_, index) => ({
      time: Date.UTC(2026, 0, 5 + index, 14, 30) / 1_000,
      open: 10 + index, high: 12 + index, low: 9 + index, close: 11 + index, volume: 100,
    })));
    const weekly = aggregateCanonicalBars(daily, weekBuckets('America/New_York'));
    // Mon 5 Jan – Sun 11 Jan, then Mon 12 Jan onwards.
    expect(weekly.length).toBe(2);
    expect(weekly[0].volume).toBe(700);
    expect(weekly[0].open).toBe(daily[0].open);
    expect(weekly[0].close).toBe(daily[6].close);
  });

  it('sums volume without inventing one when every member is unavailable', () => {
    const source = normalizeCanonicalBars([
      { time: OPEN, open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: OPEN + 60, open: 1.5, high: 2.5, low: 1, close: 2 },
    ]);
    const aggregated = aggregateCanonicalBars(source, epochBuckets(300));
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].volume).toBeNull();
  });

  it('never lets the candle series run ahead of the volume series after aggregation', () => {
    const source = normalizeCanonicalBars(minuteBars(97));
    const aggregated = aggregateCanonicalBars(source, epochBuckets(45 * MINUTE));
    const { price, volume } = deriveCanonicalSeries(aggregated);
    expect(price.at(-1)?.time).toBe(volume.at(-1)?.time);
    expect(price).toHaveLength(volume.length);
  });

  it('anchors session buckets on each trading day rather than an arbitrary epoch offset', () => {
    const day1 = minuteBars(90, OPEN);
    const day2 = minuteBars(90, OPEN + 24 * 60 * 60);
    const source = normalizeCanonicalBars([...day1, ...day2]);
    const aggregated = aggregateCanonicalBars(source, sessionBuckets(45 * MINUTE, 'America/New_York', source));
    expect(aggregated[0].time).toBe(OPEN);
    expect(aggregated.some((bar) => bar.time === OPEN + 24 * 60 * 60)).toBe(true);
  });

  it('marks an aggregate partial when any member bucket is still forming', () => {
    const source = normalizeCanonicalBars([
      ...minuteBars(4),
      { time: OPEN + 4 * MINUTE, open: 1, high: 2, low: 0.5, close: 1.5, volume: 5, partial: true },
    ]);
    const aggregated = aggregateCanonicalBars(source, epochBuckets(300));
    expect(aggregated.at(-1)?.partial).toBe(true);
    expect(finalizedBars(aggregated)).toHaveLength(aggregated.length - 1);
  });
});

describe('display transforms', () => {
  const source = normalizeCanonicalBars(minuteBars(6));

  it('leaves candlestick mode as the traded OHLC', () => {
    const display = toDisplayBars(source, 'candlestick');
    display.forEach((bar, index) => {
      expect(bar.open).toBe(source[index].open);
      expect(bar.close).toBe(source[index].close);
      expect(bar.transformed).toBe(false);
    });
  });

  it('computes Heikin-Ashi to the documented formula with a deterministic first bar', () => {
    const display = toDisplayBars(source, 'heikin-ashi');
    const first = source[0];
    expect(display[0].close).toBeCloseTo((first.open + first.high + first.low + first.close) / 4, 10);
    expect(display[0].open).toBeCloseTo((first.open + first.close) / 2, 10);
    for (let index = 1; index < display.length; index += 1) {
      const raw = source[index];
      expect(display[index].close).toBeCloseTo((raw.open + raw.high + raw.low + raw.close) / 4, 10);
      expect(display[index].open).toBeCloseTo((display[index - 1].open + display[index - 1].close) / 2, 10);
      expect(display[index].high).toBe(Math.max(raw.high, display[index].open, display[index].close));
      expect(display[index].low).toBe(Math.min(raw.low, display[index].open, display[index].close));
    }
  });

  it('agrees with the shared Heikin-Ashi implementation used elsewhere in the app', () => {
    const shared = heikinAshi(source.map((bar) => ({
      date: new Date(bar.time * 1_000).toISOString(),
      open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume ?? 0,
    })));
    const display = toDisplayBars(source, 'heikin-ashi');
    display.forEach((bar, index) => {
      expect(bar.open).toBeCloseTo(shared[index].open, 10);
      expect(bar.high).toBeCloseTo(shared[index].high, 10);
      expect(bar.low).toBeCloseTo(shared[index].low, 10);
      expect(bar.close).toBeCloseTo(shared[index].close, 10);
    });
  });

  it('preserves the bucket timestamp and the raw traded volume through Heikin-Ashi', () => {
    const display = toDisplayBars(source, 'heikin-ashi');
    display.forEach((bar, index) => {
      expect(bar.time).toBe(source[index].time);
      expect(bar.volume).toBe(source[index].volume);
      expect(bar.rawOpen).toBe(source[index].open);
      expect(bar.rawClose).toBe(source[index].close);
    });
  });
});
