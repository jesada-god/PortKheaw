import { describe, expect, it, vi } from 'vitest';
import { MarketDataError } from '../errors';
import { OptionsMarketDataService } from './service';
import { OptionsCapabilityCache } from './capability';
import type { NormalizedOptionContracts } from './contracts';

vi.mock('server-only', () => ({}));

function snapshot(provider: string): NormalizedOptionContracts {
  return {
    underlyingSymbol: 'AAPL',
    contracts: [{
      contractSymbol: 'AAPL260821C00345000', underlyingSymbol: 'AAPL', type: 'call',
      expiration: '2026-08-21', strike: 345, bid: null, ask: null, last: 1.06, mark: null,
      volume: null, openInterest: 46635, impliedVolatility: null, delta: null, gamma: null,
      theta: null, vega: null, rho: null, inTheMoney: null, multiplier: 100, currency: 'USD',
      provider, marketDataProvider: null, marketDataFeed: null, oiAsOf: null, delayedMinutes: null, valuationSource: null,
      asOf: '2026-07-27T15:00:00.000Z', timestampKind: 'receipt', status: 'delayed',
    }],
    expirations: ['2026-08-21'],
    provider,
    asOf: '2026-07-27T15:00:00.000Z',
    timestampKind: 'receipt',
    status: 'delayed',
    delayedMinutes: null,
    completeness: 0.2,
    warnings: [],
  };
}

function fakeProvider(id: string, behaviour: () => Promise<NormalizedOptionContracts>) {
  return { id, getOptionsContracts: vi.fn(behaviour) };
}

const quote = { getQuote: vi.fn(async () => ({
  data: { price: 250 },
  provider: 'test-quote',
  freshness: { status: 'delayed' as const, asOf: '2026-07-27T15:00:00.000Z', maxAgeSeconds: 60 },
})) } as never;

function clock(start = 1_000_000) {
  const state = { now: start };
  return { read: () => state.now, advance: (ms: number) => { state.now += ms; } };
}

describe('capability-aware options provider selection', () => {
  it('falls back to the next provider when the preferred one is not entitled', async () => {
    const refused = fakeProvider('alpha-vantage', async () => {
      throw new MarketDataError('forbidden', 'plan does not authorize this operation');
    });
    const working = fakeProvider('alpaca', async () => snapshot('alpaca'));
    const service = new OptionsMarketDataService([refused, working], quote);

    const result = await service.getExpirations('AAPL');
    expect(result.data.provider).toBe('alpaca');
    expect(result.data.expirations).toEqual(['2026-08-21']);
  });

  it('stops contacting a provider once its entitlement refusal is cached', async () => {
    const refused = fakeProvider('alpha-vantage', async () => {
      throw new MarketDataError('forbidden', 'plan does not authorize this operation');
    });
    const working = fakeProvider('alpaca', async () => snapshot('alpaca'));
    const time = clock();
    const service = new OptionsMarketDataService(
      [refused, working], quote, undefined, time.read, new OptionsCapabilityCache(time.read),
    );

    await service.getExpirations('AAPL');
    expect(refused.getOptionsContracts).toHaveBeenCalledTimes(1);

    // Later symbols, later page loads: the refused provider is never called again.
    time.advance(60_000);
    await service.getExpirations('NVDA');
    time.advance(60_000);
    await service.getExpirations('TSLA');
    expect(refused.getOptionsContracts).toHaveBeenCalledTimes(1);

    expect(service.capabilityReport()).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'alpha-vantage', status: 'entitlement-unavailable' }),
      expect.objectContaining({ provider: 'alpaca', status: 'entitled' }),
    ]));
  });

  it('reports a truthful entitlement failure when no provider is entitled', async () => {
    const a = fakeProvider('alpaca', async () => { throw new MarketDataError('forbidden', 'not entitled'); });
    const b = fakeProvider('alpha-vantage', async () => { throw new MarketDataError('forbidden', 'premium endpoint'); });
    const service = new OptionsMarketDataService([a, b], quote);

    // A forbidden surfaces as HTTP 403, which the browser planner maps to
    // entitlement-required + stopsPolling — never to a retryable 429.
    const failure = await service.getExpirations('AAPL').catch((cause: MarketDataError) => cause);
    expect(failure).toMatchObject({ code: 'forbidden', retryable: false, status: 403 });
  });

  it('never lets a refused fallback mask a merely throttled primary', async () => {
    const throttled = fakeProvider('alpaca', async () => {
      throw new MarketDataError('rate-limited', 'throttled', 30);
    });
    const refused = fakeProvider('alpha-vantage', async () => {
      throw new MarketDataError('forbidden', 'premium endpoint');
    });
    const service = new OptionsMarketDataService([throttled, refused], quote);

    // Surfacing "forbidden" here would permanently stop polling for a fault that
    // clears itself in 30 seconds.
    const failure = await service.getExpirations('AAPL').catch((cause: MarketDataError) => cause);
    expect(failure).toMatchObject({ code: 'rate-limited', retryable: true, retryAfterSeconds: 30 });
  });

  it('suppresses upstream calls entirely while a throttle cooldown is live, then resumes', async () => {
    let attempts = 0;
    const flaky = fakeProvider('alpaca', async () => {
      attempts += 1;
      if (attempts === 1) throw new MarketDataError('rate-limited', 'throttled', 30);
      return snapshot('alpaca');
    });
    const time = clock();
    const service = new OptionsMarketDataService(
      [flaky], quote, undefined, time.read, new OptionsCapabilityCache(time.read),
    );

    await expect(service.getExpirations('AAPL')).rejects.toMatchObject({ code: 'rate-limited' });
    expect(attempts).toBe(1);

    time.advance(10_000);
    await expect(service.getExpirations('NVDA')).rejects.toMatchObject({ code: 'rate-limited' });
    expect(attempts).toBe(1); // no request storm during the cooldown

    time.advance(21_000);
    await expect(service.getExpirations('NVDA')).resolves.toMatchObject({ provider: 'alpaca' });
    expect(attempts).toBe(2);
  });

  it('reports no configured provider truthfully instead of inventing a chain', async () => {
    const service = new OptionsMarketDataService([], quote);
    await expect(service.getExpirations('AAPL')).rejects.toMatchObject({ code: 'provider-not-configured' });
  });

  it('never serves a partial expiration-discovery snapshot as a chain', async () => {
    // Reproduces a real defect: Alpaca's expiration discovery queries calls only,
    // and reusing that snapshot for the chain returned 90 calls and 0 puts.
    const callsOnly: NormalizedOptionContracts = { ...snapshot('alpaca'), partial: true };
    const bothSides: NormalizedOptionContracts = {
      ...snapshot('alpaca'),
      contracts: [
        snapshot('alpaca').contracts[0],
        { ...snapshot('alpaca').contracts[0], contractSymbol: 'AAPL260821P00345000', type: 'put' as const, openInterest: 35011 },
      ],
    };
    const provider = {
      id: 'alpaca',
      getOptionsContracts: vi.fn(async (_symbol: string, expiration?: string) => (expiration ? bothSides : callsOnly)),
    };
    const service = new OptionsMarketDataService([provider], quote);

    await service.getExpirations('AAPL');
    const chain = await service.getChain('AAPL', '2026-08-21');

    expect(chain.data.calls).toHaveLength(1);
    expect(chain.data.puts).toHaveLength(1);
    // The chain must have gone back to the provider with an expiration filter.
    expect(provider.getOptionsContracts).toHaveBeenLastCalledWith('AAPL', '2026-08-21');
  });

  it('still reuses a complete full-chain snapshot without a second upstream call', async () => {
    const provider = fakeProvider('alpha-vantage', async () => ({
      ...snapshot('alpha-vantage'),
      contracts: [
        snapshot('alpha-vantage').contracts[0],
        { ...snapshot('alpha-vantage').contracts[0], contractSymbol: 'AAPL260821P00345000', type: 'put' as const },
      ],
    }));
    const service = new OptionsMarketDataService([provider], quote);

    await service.getExpirations('AAPL');
    const chain = await service.getChain('AAPL', '2026-08-21');

    expect(chain.data.calls).toHaveLength(1);
    expect(chain.data.puts).toHaveLength(1);
    expect(provider.getOptionsContracts).toHaveBeenCalledTimes(1);
  });
});

describe('underlying spot resolution for the options chain', () => {
  const quoteFailing = { getQuote: vi.fn(async () => {
    throw new MarketDataError('rate-limited', 'Market data provider rate limit exceeded');
  }) } as never;

  const dailyClose = async () => ({
    data: { price: 340.08 },
    provider: 'yahoo-finance-chart',
    freshness: { status: 'end-of-day' as const, asOf: '2026-07-28T13:30:00.000Z', maxAgeSeconds: null },
  }) as never;

  it('keeps an entitled chain when the quote provider is exhausted, disclosing the fallback', async () => {
    const provider = fakeProvider('alpaca', async () => snapshot('alpaca'));
    const service = new OptionsMarketDataService(
      [provider], quoteFailing, undefined, undefined, undefined, dailyClose,
    );

    const chain = await service.getChain('AAPL', '2026-08-21');

    // The complete chain survives a failure of the SECONDARY spot lookup...
    expect(chain.data.calls.length + chain.data.puts.length).toBeGreaterThan(0);
    expect(chain.data.spot).toBe(340.08);
    // ...and the substitution is disclosed, never silent.
    expect(chain.data.underlyingProvider).toBe('yahoo-finance-chart');
    expect(chain.data.underlyingStatus).not.toBe('live');
    expect(chain.data.warnings.some((w) => /confirmed daily close/i.test(w))).toBe(true);
  });

  it('prefers the quote provider and never calls the fallback when it succeeds', async () => {
    const provider = fakeProvider('alpaca', async () => snapshot('alpaca'));
    const fallback = vi.fn(dailyClose);
    const service = new OptionsMarketDataService(
      [provider], quote, undefined, undefined, undefined, fallback as never,
    );

    const chain = await service.getChain('AAPL', '2026-08-21');
    expect(chain.data.spot).toBe(250);
    expect(fallback).not.toHaveBeenCalled();
    expect(chain.data.warnings.some((w) => /confirmed daily close/i.test(w))).toBe(false);
  });

  it('fails rather than pricing a chain against an invented spot', async () => {
    const provider = fakeProvider('alpaca', async () => snapshot('alpaca'));
    const service = new OptionsMarketDataService(
      [provider], quoteFailing, undefined, undefined, undefined, async () => null,
    );
    await expect(service.getChain('AAPL', '2026-08-21')).rejects.toThrow(/rate limit/i);
  });
});
