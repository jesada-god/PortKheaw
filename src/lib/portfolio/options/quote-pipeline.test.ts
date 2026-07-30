import { describe, expect, it, vi } from 'vitest';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';

vi.mock('server-only', () => ({}));

const { loadPortfolioOptionQuotes } = await import('./quote-pipeline');

const legacySymbol = 'LEGACY-C307F481-B34C-4FE3-97';
const canonicalSymbol = 'NVTS260821P00012000';
const position = {
  key: legacySymbol,
  underlyingSymbol: 'NVTS',
  contractSymbol: legacySymbol,
  optionKind: 'put' as const,
  strikePrice: 12,
  expirationDate: '2026-08-21',
};

function contract(overrides: Partial<OptionContract> = {}): OptionContract {
  return {
    contractSymbol: canonicalSymbol,
    underlyingSymbol: 'NVTS',
    type: 'put',
    expiration: '2026-08-21',
    strike: 12,
    bid: 1.9,
    ask: 1.96,
    last: 1.93,
    mark: 1.93,
    volume: 10,
    openInterest: 100,
    impliedVolatility: 0.5,
    delta: -0.4,
    gamma: 0.02,
    theta: -0.03,
    vega: 0.1,
    rho: -0.01,
    inTheMoney: false,
    multiplier: 100,
    currency: 'USD',
    provider: 'alpaca',
    marketDataProvider: 'alpaca',
    marketDataFeed: 'indicative',
    asOf: '2026-07-31T00:00:00.000Z',
    oiAsOf: '2026-07-30',
    timestampKind: 'provider',
    status: 'delayed',
    delayedMinutes: 15,
    valuationSource: 'provider',
    ...overrides,
  };
}

function chain(contracts: OptionContract[]): OptionsChain {
  return {
    underlyingSymbol: 'NVTS',
    spot: 14.25,
    expiration: '2026-08-21',
    expirations: ['2026-08-21'],
    calls: contracts.filter((item) => item.type === 'call'),
    puts: contracts.filter((item) => item.type === 'put'),
    provider: 'alpaca',
    asOf: '2026-07-31T00:00:00.000Z',
    timestampKind: 'provider',
    status: 'delayed',
    delayedMinutes: 15,
    completeness: 1,
    warnings: [],
  };
}

describe('portfolio option quote pipeline', () => {
  it('resolves a legacy position and looks up the quote by the canonical symbol', async () => {
    const loader = vi.fn(async () => chain([contract()]));
    const quotes = await loadPortfolioOptionQuotes([position], loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith('NVTS', '2026-08-21');
    expect(loader.mock.calls.flat().join('|')).not.toContain('LEGACY-');
    expect(quotes[legacySymbol]).toMatchObject({
      contractSymbol: canonicalSymbol,
      bid: 1.9,
      ask: 1.96,
      mark: 1.93,
      underlyingPrice: 14.25,
      source: 'alpaca',
    });
  });

  it('rejects close-but-wrong contracts instead of attaching the wrong quote', async () => {
    const quotes = await loadPortfolioOptionQuotes([position], async () => chain([
      contract({ strike: 13 }),
      contract({ expiration: '2026-09-18' }),
      contract({ type: 'call' }),
      contract({ underlyingSymbol: 'AAPL' }),
    ]));

    expect(quotes[legacySymbol]).toBeNull();
  });

  it('does not fabricate a quote when the contract cannot be resolved', async () => {
    const unresolved = { ...position, key: 'UNRESOLVED-ABC', contractSymbol: 'UNRESOLVED-ABC' };
    const quotes = await loadPortfolioOptionQuotes([unresolved], async () => {
      throw new Error('provider unavailable');
    });

    expect(quotes[unresolved.key]).toBeNull();
  });

  it('keeps an existing canonical row canonical', async () => {
    const canonical = { ...position, key: canonicalSymbol, contractSymbol: canonicalSymbol };
    const quotes = await loadPortfolioOptionQuotes([canonical], async () => chain([contract()]));

    expect(quotes[canonicalSymbol]?.contractSymbol).toBe(canonicalSymbol);
    expect(quotes[canonicalSymbol]?.mark).toBe(1.93);
  });
});
