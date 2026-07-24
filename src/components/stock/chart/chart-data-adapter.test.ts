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
    expect(volumeData(bars).map((point) => point.color)).toEqual(['#00c57f99', '#ff3b3099']);
  });

  it('does not mutate raw OHLCV when deriving Heikin Ashi', () => {
    const snapshot = structuredClone(prices);
    const bars = adaptChartBars(prices, 'heikin-ashi');
    expect(prices).toEqual(snapshot);
    expect(bars[0]).toMatchObject({ rawOpen: 10, rawClose: 11, volume: 100 });
  });

  it('uses update only for a changed latest bar or one append', () => {
    const previous = adaptChartBars(prices, 'candlestick');
    const refreshed = adaptChartBars([{ ...prices[0] }, { ...prices[1], close: 11 }], 'candlestick');
    const replaced = adaptChartBars([{ ...prices[0], date: '2026-07-20T13:31:00.000Z' }, prices[1]], 'candlestick');
    expect(canUpdateLatest(previous, refreshed)).toBe(true);
    expect(canUpdateLatest(previous, replaced)).toBe(false);
  });
});
