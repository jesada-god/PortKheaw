import { describe, expect, it } from 'vitest';
import { sortWatchlistRows, watchlistContextLine, WATCHLIST_SORT_LABELS } from './context';

const rows = [
  { symbol: 'NVDA', createdAt: '2026-08-01T00:00:00.000Z', price: 120, changePercent: -3.1 },
  { symbol: 'AAPL', createdAt: '2026-08-03T00:00:00.000Z', price: 200, changePercent: 2.4 },
  { symbol: 'TSLA', createdAt: '2026-08-02T00:00:00.000Z', price: null, changePercent: null },
];

describe('watchlist sorting', () => {
  it('offers change, alphabetical and recently-added orders', () => {
    expect(WATCHLIST_SORT_LABELS.change).toBe('การเปลี่ยนแปลง');
    expect(WATCHLIST_SORT_LABELS.symbol).toBe('ตัวอักษร');
    expect(WATCHLIST_SORT_LABELS.newest).toBe('เพิ่มล่าสุด');
  });

  it('sorts by change, symbol and recency without mutating the caller', () => {
    const original = [...rows];
    expect(sortWatchlistRows(rows, 'change').map((row) => row.symbol)).toEqual(['AAPL', 'NVDA', 'TSLA']);
    expect(sortWatchlistRows(rows, 'symbol').map((row) => row.symbol)).toEqual(['AAPL', 'NVDA', 'TSLA']);
    expect(sortWatchlistRows(rows, 'newest').map((row) => row.symbol)).toEqual(['AAPL', 'TSLA', 'NVDA']);
    expect(rows).toEqual(original);
  });

  it('puts an unpriced row last rather than treating it as zero', () => {
    expect(sortWatchlistRows(rows, 'price').map((row) => row.symbol)).toEqual(['AAPL', 'NVDA', 'TSLA']);
  });
});

describe('watchlist context line', () => {
  it('states today’s change and, for a large move, says so plainly', () => {
    expect(watchlistContextLine({ changePercent: 2.4, earningsDays: null })).toBe('+2.40% วันนี้');
    expect(watchlistContextLine({ changePercent: -6.2, earningsDays: null }))
      .toBe('-6.20% วันนี้ · เคลื่อนไหวแรงวันนี้');
  });

  it('adds a report only when one is genuinely close', () => {
    expect(watchlistContextLine({ changePercent: 1, earningsDays: 3 }))
      .toBe('+1.00% วันนี้ · ประกาศผลประกอบการในอีก 3 วัน');
    expect(watchlistContextLine({ changePercent: 1, earningsDays: 90 })).toBe('+1.00% วันนี้');
  });

  it('shows no line at all when nothing is known', () => {
    expect(watchlistContextLine({ changePercent: null, earningsDays: null })).toBeNull();
  });
});
