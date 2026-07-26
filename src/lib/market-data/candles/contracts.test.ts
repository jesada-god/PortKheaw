import { describe, expect, it } from 'vitest';
import { CANDLE_INTERVALS, CANDLE_RANGES, YAHOO_CANDLE_CAPABILITIES, sourceIntervalFor, supportedRangesFor } from './capabilities';
import { normalizeCandles, providerNumber, validatedCandle } from './normalize';

describe('candle contracts and compatibility', () => {
  it('covers every required timeframe/range and restricts 5Y to daily or higher', () => {
    expect(CANDLE_INTERVALS).toEqual([
      '1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m',
      '1h', '2h', '3h', '4h',
      '1D', 'Week', 'Month',
    ]);
    expect(CANDLE_RANGES).toEqual(['1d', '5d', '1m', '3m', '6m', 'ytd', '1y', '3y', '5y']);
    expect(supportedRangesFor('1m')).not.toContain('5y');
    expect(supportedRangesFor('1D')).toContain('5y');
    expect(supportedRangesFor('Week')).toContain('5y');
    expect(supportedRangesFor('Month')).toContain('5y');
  });

  it('uses deterministic real aggregation sources', () => {
    expect(sourceIntervalFor(YAHOO_CANDLE_CAPABILITIES, '10m')).toBe('5m');
    expect(sourceIntervalFor(YAHOO_CANDLE_CAPABILITIES, '2h')).toBe('1h');
    expect(sourceIntervalFor(YAHOO_CANDLE_CAPABILITIES, '4h')).toBe('1h');
    expect(sourceIntervalFor(YAHOO_CANDLE_CAPABILITIES, 'Week')).toBe('Week');
    // The intervals Yahoo has no native resolution for aggregate from a real
    // lower one — never from a fabricated candle.
    expect(sourceIntervalFor(YAHOO_CANDLE_CAPABILITIES, '2m')).toBe('1m');
    expect(sourceIntervalFor(YAHOO_CANDLE_CAPABILITIES, '3m')).toBe('1m');
    expect(sourceIntervalFor(YAHOO_CANDLE_CAPABILITIES, '45m')).toBe('15m');
    expect(sourceIntervalFor(YAHOO_CANDLE_CAPABILITIES, '3h')).toBe('1h');
  });

  it('parses provider numbers but drops malformed OHLCV without repairing it', () => {
    expect(providerNumber('(1,234.5)')).toBe(-1234.5);
    expect(providerNumber('None')).toBeNull();
    const valid = validatedCandle({ timestamp: 1_700_000_000, open: '10', high: '12', low: '9', close: '11', volume: '100' });
    const invalid = validatedCandle({ timestamp: 1_700_000_001, open: 10, high: 8, low: 9, close: 11, volume: -1 });
    expect(valid).not.toBeNull();
    expect(invalid).toBeNull();
  });

  it('sorts and deduplicates timestamps without inserting missing candles', () => {
    const first = validatedCandle({ timestamp: 1_700_000_000, open: 10, high: 12, low: 9, close: 11, volume: 100 })!;
    const replacement = { ...first, close: 10.5 };
    const second = { ...first, timestamp: first.timestamp + 120, open: 11 };
    const result = normalizeCandles([second, first, replacement, null]);
    expect(result.invalidCount).toBe(1);
    expect(result.candles).toEqual([replacement, second]);
  });
});

