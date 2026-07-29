import { describe, expect, it } from 'vitest';
import { adaptChartBars, canUpdateLatest, volumeData } from './chart-data-adapter';

const prices = [
  { date: '2026-07-20T13:30:00.000Z', open: 10, high: 12, low: 9, close: 11, volume: 100 },
  { date: '2026-07-20T13:35:00.000Z', open: 11, high: 13, low: 10, close: 10.5, volume: 200 },
];

describe('Lightweight Charts data adapter', () => {
  it('keeps volume timestamps aligned with raw candles', () => {
    const bars = adaptChartBars(prices, 'candlestick');
    expect(volumeData(bars).map((point) => point.time)).toEqual(bars.map((bar) => bar.time));
    expect(volumeData(bars).map((point) => ('color' in point ? point.color : undefined))).toEqual(['#00c57f99', '#ff3b3099']);
  });

  it('does not mutate raw OHLCV when deriving Heikin Ashi', () => {
    const snapshot = structuredClone(prices);
    const bars = adaptChartBars(prices, 'heikin-ashi');
    expect(prices).toEqual(snapshot);
    expect(bars[0]).toMatchObject({ rawOpen: 10, rawClose: 11, volume: 100 });
    expect(bars[0].transformed).toBe(true);
    expect(bars.map((bar) => bar.time)).toEqual(adaptChartBars(prices, 'candlestick').map((bar) => bar.time));
    expect(bars.map((bar) => bar.volume)).toEqual(prices.map((bar) => bar.volume));
  });

  it('normalizes seconds and milliseconds once, sorts/deduplicates, and joins metadata by exact timestamp', () => {
    const first = Date.parse('2026-07-20T13:30:00.000Z') / 1_000;
    const rows = [
      { time: (first + 300) * 1_000, open: 11, high: 13, low: 10, close: 12, volume: 200, transactions: 22 },
      { time: first, open: 10, high: 12, low: 9, close: 11, volume: 100, transactions: 11 },
      { time: first, open: 10, high: 12.5, low: 9, close: 11.5, volume: 150, transactions: 15 },
    ];
    const bars = adaptChartBars(rows, 'candlestick');
    expect(bars.map((bar) => Number(bar.time))).toEqual([first, first + 300]);
    expect(bars[0]).toMatchObject({ close: 11.5, volume: 150, transactions: 15 });
    expect(bars[1]).toMatchObject({ close: 12, volume: 200, transactions: 22 });
  });

  it('keeps a missing-volume timestamp as whitespace instead of shifting the series', () => {
    const rows = [
      prices[0],
      { ...prices[1], volume: undefined },
    ];
    const bars = adaptChartBars(rows, 'candlestick');
    const volume = volumeData(bars);
    expect(volume).toHaveLength(bars.length);
    expect(volume[1].time).toBe(bars[1].time);
    expect(volume[1]).not.toHaveProperty('value');
  });

  it('uses update only for a changed latest bar or one append', () => {
    const previous = adaptChartBars(prices, 'candlestick');
    const refreshed = adaptChartBars([{ ...prices[0] }, { ...prices[1], close: 11 }], 'candlestick');
    const replaced = adaptChartBars([{ ...prices[0], date: '2026-07-20T13:31:00.000Z' }, prices[1]], 'candlestick');
    expect(canUpdateLatest(previous, refreshed)).toBe(true);
    expect(canUpdateLatest(previous, replaced)).toBe(false);
  });
});
