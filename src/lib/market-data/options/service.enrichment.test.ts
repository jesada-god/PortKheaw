import { describe, expect, it, vi } from 'vitest';
import type { Quote } from '../types';
import type { OptionsContractsProvider } from '../providers/alpha-vantage/options';
import type { NormalizedOptionContracts, OptionContract } from './contracts';
import { OptionsMarketDataService } from './service';

const EXPIRATION = '2026-08-21';
const AS_OF = '2026-07-27T15:00:00.000Z';

function contract(contractSymbol: string, type: 'call' | 'put', strike: number): OptionContract {
  return {
    contractSymbol,
    underlyingSymbol: 'AAPL',
    type,
    expiration: EXPIRATION,
    strike,
    bid: null, ask: null, last: 4, mark: null, volume: null, openInterest: 500,
    impliedVolatility: null, delta: null, gamma: null, theta: null, vega: null, rho: null,
    inTheMoney: null,
    multiplier: 100,
    currency: 'USD',
    provider: 'alpaca',
    marketDataProvider: null,
    marketDataFeed: null,
    asOf: AS_OF,
    oiAsOf: '2026-07-24',
    timestampKind: 'receipt',
    status: 'delayed',
    delayedMinutes: null,
    valuationSource: null,
  };
}

function catalogue(): NormalizedOptionContracts {
  return {
    underlyingSymbol: 'AAPL',
    contracts: [
      contract('AAPL260821C00210000', 'call', 210),
      contract('AAPL260821P00210000', 'put', 210),
    ],
    expirations: [EXPIRATION],
    provider: 'alpaca',
    asOf: AS_OF,
    timestampKind: 'receipt',
    status: 'delayed',
    delayedMinutes: null,
    completeness: 1,
    warnings: [],
    partial: false,
  };
}

const quote: Quote = {
  symbol: 'AAPL', currency: 'USD', price: 208.5,
  open: 207, high: 210, low: 206, previousClose: 207,
  regularClose: 208.5, previousRegularClose: 207,
  change: 1.5, changePercent: 0.7246, volume: 1_000,
  latestTradingDay: '2026-07-27', quoteTimestamp: AS_OF, session: 'regular',
};

describe('OptionsMarketDataService snapshot enrichment lifecycle', () => {
  it('single-flights and caches one expiration-scoped snapshot request, then merges by contract symbol', async () => {
    const getOptionsContracts = vi.fn(async () => catalogue());
    const getMarketSnapshots = vi.fn(async () => ({
      // Deliberately reverse the catalogue order: an index join would swap call/put prices.
      snapshots: new Map([
        ['AAPL260821P00210000', {
          bid: 5.1, ask: 5.5, last: 5.4, volume: 321, impliedVolatility: 0.31,
          delta: -0.42, gamma: 0.03, theta: -0.2, vega: 0.11, rho: -0.02,
          observedAt: '2026-07-27T14:59:58.000Z',
        }],
        ['AAPL260821C00210000', {
          bid: 4.2, ask: 4.6, last: 4.5, volume: 1_234, impliedVolatility: 0.275,
          delta: 0.6857, gamma: 0.0426, theta: -0.5146, vega: 0.1074, rho: 0.0184,
          observedAt: '2026-07-27T14:59:59.000Z',
        }],
      ]),
      provider: 'alpaca-options-data',
      feed: 'indicative',
      asOf: AS_OF,
      warnings: [],
    }));
    const provider: OptionsContractsProvider = {
      id: 'alpaca',
      getOptionsContracts,
      getMarketSnapshots,
    };
    const quoteProvider = {
      getQuote: vi.fn(async () => ({
        data: quote,
        provider: 'alpaca',
        freshness: { status: 'delayed' as const, asOf: AS_OF, maxAgeSeconds: 60 },
      })),
    };
    const service = new OptionsMarketDataService(provider, quoteProvider, undefined, () => Date.parse(AS_OF));

    const [first, joined] = await Promise.all([
      service.getChain('AAPL', EXPIRATION),
      service.getChain('AAPL', EXPIRATION),
    ]);
    const reopened = await service.getChain('AAPL', EXPIRATION);

    expect(getOptionsContracts).toHaveBeenCalledTimes(1);
    expect(getMarketSnapshots).toHaveBeenCalledTimes(1);
    expect(getMarketSnapshots).toHaveBeenCalledWith('AAPL', EXPIRATION);
    expect(joined.data.calls[0].contractSymbol).toBe('AAPL260821C00210000');
    expect(first.data.calls[0]).toMatchObject({
      bid: 4.2, ask: 4.6, mark: 4.4, last: 4.5, volume: 1_234,
      impliedVolatility: 0.275, delta: 0.6857,
      marketDataProvider: 'alpaca-options-data', marketDataFeed: 'indicative',
      asOf: '2026-07-27T14:59:59.000Z', valuationSource: 'provider',
    });
    expect(first.data.puts[0]).toMatchObject({ bid: 5.1, ask: 5.5, delta: -0.42 });
    expect(reopened.data.calls[0].bid).toBe(4.2);
  });
});
