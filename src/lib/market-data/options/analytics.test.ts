import { describe, expect, it } from 'vitest';
import { optionsChainSchema, type OptionContract, type OptionsChain } from './contracts';
import { calculateAtmIv, calculateExpectedMove, calculateOiConcentration } from './analytics';

const contract = (overrides: Partial<OptionContract>): OptionContract => ({
  contractSymbol: 'RKLB260821C00050000', underlyingSymbol: 'RKLB', type: 'call',
  expiration: '2026-08-21', strike: 50, bid: 2, ask: 2.2, last: 2.1, mark: 2.1,
  volume: 100, openInterest: 500, impliedVolatility: 0.4,
  delta: null, gamma: null, theta: null, vega: null, rho: null,
  inTheMoney: false, multiplier: 100, currency: 'USD', provider: 'test-provider',
  asOf: '2026-07-20T14:00:00.000Z', status: 'live', ...overrides,
});

const chain = (overrides: Partial<OptionsChain> = {}): OptionsChain => optionsChainSchema.parse({
  underlyingSymbol: 'RKLB', spot: 50, expiration: '2026-08-21', expirations: ['2026-08-21'],
  calls: [contract({}), contract({ contractSymbol: 'RKLB260821C00055000', strike: 55, impliedVolatility: 0.5, openInterest: 1_000 })],
  puts: [contract({ contractSymbol: 'RKLB260821P00050000', type: 'put', impliedVolatility: 0.3, openInterest: 800 })],
  provider: 'test-provider', asOf: '2026-07-20T14:00:00.000Z', status: 'live',
  delayedMinutes: 0, completeness: 0.8, warnings: [], ...overrides,
});

describe('options analytics', () => {
  it('uses a robust median of valid near-ATM call and put IV', () => {
    const result = calculateAtmIv(chain(), '2026-07-20');
    expect(result.status).toBe('available');
    expect(result.iv).toBe(0.4);
    expect(result.sampledContracts).toHaveLength(3);
  });

  it('returns unavailable when the provider supplied no real IV', () => {
    const input = chain({
      calls: [contract({ impliedVolatility: null })],
      puts: [contract({ contractSymbol: 'p', type: 'put', impliedVolatility: null })],
    });
    expect(calculateAtmIv(input)).toMatchObject({ status: 'unavailable', iv: null });
  });

  it('calculates expected move with the specified formula', () => {
    const result = calculateExpectedMove(chain(), '2026-07-20');
    const expected = 50 * 0.4 * Math.sqrt(32 / 365);
    expect(result.status).toBe('available');
    expect(result.move).toBeCloseTo(expected, 12);
    expect(result.upper).toBeCloseTo(50 + expected, 12);
    expect(result.lower).toBeCloseTo(50 - expected, 12);
  });

  it('handles same-day expiration deterministically', () => {
    const input = chain({ expiration: '2026-07-20', expirations: ['2026-07-20'], calls: [contract({ expiration: '2026-07-20' })], puts: [] });
    expect(calculateExpectedMove(input, '2026-07-20')).toMatchObject({ dte: 0, move: 0, lower: 50, upper: 50 });
  });

  it('ranks call and put OI separately and renormalizes missing components', () => {
    const result = calculateOiConcentration(chain({
      calls: [
        contract({ contractSymbol: 'c1', strike: 50, openInterest: 100, volume: null, bid: null, ask: null }),
        contract({ contractSymbol: 'c2', strike: 55, openInterest: 1_000, volume: null, bid: null, ask: null }),
      ],
    }));
    expect(result.calls[0].contractSymbol).toBe('c2');
    expect(result.calls[0].components.volume).toBeNull();
    expect(Number.isFinite(result.calls[0].score)).toBe(true);
    expect(result.puts[0].type).toBe('put');
  });

  it('reselects ATM provider IV and recalculates expected move when canonical spot moves', () => {
    const contracts = [45, 50, 55, 60].map((strike, index) => contract({
      contractSymbol: `c${strike}`, strike, impliedVolatility: 0.2 + index * 0.1,
    }));
    const puts = [45, 50, 55, 60].map((strike, index) => contract({
      contractSymbol: `p${strike}`, type: 'put', strike, impliedVolatility: 0.25 + index * 0.1,
    }));
    const at50 = chain({ spot: 50, calls: contracts, puts });
    const at60 = chain({ spot: 60, calls: contracts, puts });
    const iv50 = calculateAtmIv(at50, '2026-07-20');
    const iv60 = calculateAtmIv(at60, '2026-07-20');
    expect(iv50.sampledContracts.map((item) => item.contractSymbol))
      .not.toEqual(iv60.sampledContracts.map((item) => item.contractSymbol));
    expect(calculateExpectedMove(at50, '2026-07-20').move)
      .not.toBe(calculateExpectedMove(at60, '2026-07-20').move);
  });

  it('never derives or mutates provider open interest when spot changes', () => {
    const first = calculateOiConcentration(chain({ spot: 45 }));
    const second = calculateOiConcentration(chain({ spot: 60 }));
    const providerOi = (result: ReturnType<typeof calculateOiConcentration>) => new Map(
      [...result.calls, ...result.puts].map((item) => [item.contractSymbol, item.openInterest]),
    );
    expect(providerOi(first)).toEqual(providerOi(second));
  });
});
