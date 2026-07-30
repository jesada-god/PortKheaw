import { describe, expect, it, vi } from 'vitest';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import { portfolioContractSymbolSchema } from '../validation';

vi.mock('server-only', () => ({}));

const {
  deterministicUnresolvedOptionContractSymbol,
  occOptionContractCandidate,
  resolvePortfolioOptionContractSymbol,
} = await import('./contract-symbol');

const identity = {
  underlyingSymbol: 'NVDA',
  optionKind: 'put' as const,
  strikePrice: '100',
  expirationDate: '2026-08-21',
};

function contract(overrides: Partial<OptionContract> = {}): OptionContract {
  return {
    contractSymbol: 'NVDA260821P00100000',
    underlyingSymbol: 'NVDA',
    type: 'put',
    expiration: '2026-08-21',
    strike: 100,
    bid: 2,
    ask: 2.1,
    last: 2.05,
    mark: 2.05,
    volume: 10,
    openInterest: 100,
    impliedVolatility: 0.3,
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
    underlyingSymbol: 'NVDA',
    spot: 105,
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

describe('portfolio option contract symbol resolution', () => {
  it('uses the official provider symbol only when the option chain identity matches', async () => {
    const result = await resolvePortfolioOptionContractSymbol(
      identity,
      null,
      async () => chain([contract()]),
    );

    expect(result).toEqual({
      contractSymbol: 'NVDA260821P00100000',
      status: 'official',
    });
  });

  it('creates a deterministic validated unresolved identifier without fabricating an OCC symbol', async () => {
    const first = await resolvePortfolioOptionContractSymbol(identity, null, async () => {
      throw new Error('chain unavailable');
    });
    const second = deterministicUnresolvedOptionContractSymbol(identity);

    expect(first).toEqual({ contractSymbol: second, status: 'unresolved' });
    expect(first.contractSymbol).toMatch(/^UNRESOLVED-[A-F0-9]{32}$/);
    expect(portfolioContractSymbolSchema.safeParse(first.contractSymbol).success).toBe(true);
    expect(first.contractSymbol).not.toBe('NVDA260821P00100000');
    expect(deterministicUnresolvedOptionContractSymbol({ ...identity, strikePrice: '0100.000' }))
      .toBe(first.contractSymbol);
  });

  it('upgrades an unresolved identifier to the canonical symbol when a later chain matches', async () => {
    const unresolved = deterministicUnresolvedOptionContractSymbol(identity);
    const result = await resolvePortfolioOptionContractSymbol(
      identity,
      unresolved,
      async () => chain([contract()]),
    );

    expect(result).toEqual({
      contractSymbol: 'NVDA260821P00100000',
      status: 'official',
    });
  });

  it('exact-matches the legacy NVTS contract to the canonical provider symbol', async () => {
    const nvtsIdentity = {
      underlyingSymbol: 'NVTS',
      optionKind: 'put' as const,
      strikePrice: '12',
      expirationDate: '2026-08-21',
    };
    const loader = vi.fn(async () => chain([
      contract({
        contractSymbol: 'NVTS260821P00012000',
        underlyingSymbol: 'NVTS',
        strike: 12,
      }),
    ]));
    const result = await resolvePortfolioOptionContractSymbol(
      nvtsIdentity,
      'LEGACY-C307F481-B34C-4FE3-97',
      loader,
    );

    expect(occOptionContractCandidate(nvtsIdentity)).toBe('NVTS260821P00012000');
    expect(result).toEqual({
      contractSymbol: 'NVTS260821P00012000',
      status: 'official',
    });
    expect(loader).toHaveBeenCalledWith('NVTS', '2026-08-21');
  });

  it('requires exact underlying, expiration, option kind, and strike matches', async () => {
    const legacy = 'LEGACY-C307F481-B34C-4FE3-97';
    const result = await resolvePortfolioOptionContractSymbol(identity, legacy, async () => chain([
      contract({ underlyingSymbol: 'AAPL' }),
      contract({ expiration: '2026-09-18' }),
      contract({ type: 'call' }),
      contract({ strike: 101 }),
    ]));

    expect(result).toEqual({ contractSymbol: legacy, status: 'legacy' });
  });

  it('leaves an existing canonical symbol unchanged without provider resolution', async () => {
    const loader = vi.fn();
    const result = await resolvePortfolioOptionContractSymbol(
      identity,
      'NVDA260821P00100000',
      loader,
    );

    expect(result).toEqual({
      contractSymbol: 'NVDA260821P00100000',
      status: 'official',
    });
    expect(loader).not.toHaveBeenCalled();
  });
});
