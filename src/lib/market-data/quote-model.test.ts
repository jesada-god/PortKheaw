import { describe, expect, it } from 'vitest';
import type { OptionContract } from './options/contracts';
import { canonicalQuote, optionIntrinsicValue, optionMarketQuote, validMidpoint } from './quote-model';

const option = (overrides: Partial<OptionContract> = {}): OptionContract => ({
  contractSymbol: 'SPY260821C00500000', underlyingSymbol: 'SPY', type: 'call',
  expiration: '2026-08-21', strike: 500, bid: 10, ask: 12, last: 11.5, mark: 999,
  volume: 10, openInterest: 100, impliedVolatility: 0.2,
  delta: null, gamma: null, theta: null, vega: null, rho: null, inTheMoney: null,
  multiplier: 100, currency: 'USD', provider: 'test-options',
  marketDataProvider: null, marketDataFeed: null, oiAsOf: null, delayedMinutes: null, valuationSource: null,
  asOf: '2026-07-27T15:00:00.000Z', timestampKind: 'receipt', status: 'live', ...overrides,
});

describe('canonical market quote models', () => {
  it('calculates midpoint only from a valid two-sided quote', () => {
    expect(validMidpoint(10, 12)).toBe(11);
    expect(validMidpoint(null, 12)).toBeNull();
    expect(validMidpoint(13, 12)).toBeNull();
  });

  it('rejects crossed top-of-book values without replacing either side with last', () => {
    expect(canonicalQuote({
      symbol: 'SPY', last: 500, bid: 501, ask: 499, bidSize: 1, askSize: 2,
      timestamp: '2026-07-27T15:00:00.000Z', source: 'test', freshness: 'LIVE',
    })).toMatchObject({ last: 500, bid: null, ask: null, midpoint: null, bidSize: null, askSize: null });
  });

  it('keeps option Last, provider OI and IV independent from the derived midpoint', () => {
    const quote = optionMarketQuote(option());
    expect(quote).toMatchObject({
      bid: 10, ask: 12, midpoint: 11, last: 11.5,
      openInterest: 100, impliedVolatility: 0.2, freshness: 'LIVE', timestampKind: 'receipt',
    });
  });

  it('calculates intrinsic value from canonical spot without mutating provider fields', () => {
    expect(optionIntrinsicValue(option(), 510)).toBe(10);
    expect(optionIntrinsicValue(option({ type: 'put' }), 490)).toBe(10);
  });
});
