import { describe, expect, it } from 'vitest';
import { optionsChainSchema, type OptionContract, type OptionsChain } from './contracts';
import { chainCarriesGreekFields, optionsChainProjectionFor, shapeOptionsChain } from './entitlement-shaping';

const contract = (overrides: Partial<OptionContract> = {}): OptionContract => ({
  contractSymbol: 'RKLB260821C00050000', underlyingSymbol: 'RKLB', type: 'call', expiration: '2026-08-21',
  strike: 50, bid: 2, ask: 2.2, last: 2.1, mark: 2.1, volume: 100, openInterest: 500,
  impliedVolatility: 0.4, delta: 0.5, gamma: 0.02, theta: -0.03, vega: 0.1, rho: 0.01,
  inTheMoney: false, multiplier: 100, currency: 'USD', provider: 'test-provider', marketDataProvider: null,
  marketDataFeed: null, oiAsOf: null, delayedMinutes: null, valuationSource: 'provider',
  asOf: '2026-07-20T14:00:00.000Z', timestampKind: 'provider', status: 'live',
  ...overrides,
});

const chain = (): OptionsChain => optionsChainSchema.parse({
  underlyingSymbol: 'RKLB', spot: 50, expiration: '2026-08-21', expirations: ['2026-08-21'],
  calls: [contract()], puts: [contract({ contractSymbol: 'RKLB260821P00050000', type: 'put', delta: -0.5 })],
  provider: 'test-provider', asOf: '2026-07-20T14:00:00.000Z', timestampKind: 'provider', status: 'live',
  delayedMinutes: 0, completeness: 1, warnings: [],
});

describe('options chain entitlement shaping', () => {
  it('removes IV, every Greek and valuation provenance for Pro', () => {
    const source = chain();
    const shaped = shapeOptionsChain(source, optionsChainProjectionFor('pro'));

    expect(chainCarriesGreekFields(shaped)).toBe(false);
    expect(shaped.calls[0]).toMatchObject({ strike: 50, openInterest: 500 });
    for (const field of ['impliedVolatility', 'delta', 'gamma', 'theta', 'vega', 'rho', 'valuationSource']) {
      expect(Object.hasOwn(shaped.calls[0], field)).toBe(false);
    }
    expect(source.calls[0].impliedVolatility).toBe(0.4);
  });

  it('returns the complete chain unchanged for Elite', () => {
    const source = chain();
    expect(shapeOptionsChain(source, optionsChainProjectionFor('elite'))).toBe(source);
    expect(chainCarriesGreekFields(source)).toBe(true);
  });
});
