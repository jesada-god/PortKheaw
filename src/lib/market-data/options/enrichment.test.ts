import { describe, expect, it } from 'vitest';
import type { OptionContract } from './contracts';
import type { OptionMarketSnapshot } from '../providers/alpaca/options-snapshots';
import { deriveValuation, enrichOptionContracts, markPrice } from './enrichment';
import { black76Price, optionExpiryInstantMs } from './pricing';

const EXPIRATION = '2026-08-21';
const NOW_MS = Date.UTC(2026, 6, 27, 15, 0, 0);

function catalogueContract(overrides: Partial<OptionContract> = {}): OptionContract {
  const type = overrides.type ?? 'call';
  const strike = overrides.strike ?? 200;
  return {
    contractSymbol: `AAPL${type === 'call' ? 'C' : 'P'}${strike}`,
    underlyingSymbol: 'AAPL',
    type,
    expiration: EXPIRATION,
    strike,
    // The catalogue's real shape: identity + OI + a settlement close, nothing else.
    bid: null, ask: null, last: 4.2, mark: null, volume: null, openInterest: 500,
    impliedVolatility: null, delta: null, gamma: null, theta: null, vega: null, rho: null,
    inTheMoney: null, multiplier: 100, currency: 'USD',
    provider: 'alpaca', marketDataProvider: null, marketDataFeed: null,
    asOf: '2026-07-27T15:00:00.000Z', oiAsOf: '2026-07-24',
    timestampKind: 'receipt', status: 'delayed', delayedMinutes: null, valuationSource: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<OptionMarketSnapshot> = {}): OptionMarketSnapshot {
  return {
    bid: null, ask: null, last: null, volume: null,
    impliedVolatility: null, delta: null, gamma: null, theta: null, vega: null, rho: null,
    observedAt: '2026-07-24T19:59:59.000Z',
    ...overrides,
  };
}

const context = {
  spot: 205,
  nowMs: NOW_MS,
  marketDataProvider: 'alpaca-options-data',
  marketDataFeed: 'indicative',
};

describe('markPrice', () => {
  it('is the midpoint of a real two-sided quote', () => {
    expect(markPrice(4, 5)).toBe(4.5);
  });

  it('is null unless both sides are genuinely quoted', () => {
    expect(markPrice(null, 5)).toBeNull();
    expect(markPrice(4, null)).toBeNull();
    expect(markPrice(0, 5)).toBeNull();
    expect(markPrice(4, 0)).toBeNull();
  });

  it('rejects a crossed book instead of averaging it', () => {
    expect(markPrice(6, 5)).toBeNull();
  });
});

describe('enrichOptionContracts merge', () => {
  it('joins market data by exact contract symbol, never by array position', () => {
    // The snapshot is deliberately ordered differently from the catalogue and
    // omits one contract, exactly as the live endpoint does.
    const contracts = [
      catalogueContract({ contractSymbol: 'A', strike: 195 }),
      catalogueContract({ contractSymbol: 'B', strike: 200 }),
      catalogueContract({ contractSymbol: 'C', strike: 205 }),
    ];
    const snapshots = new Map<string, OptionMarketSnapshot>([
      ['C', snapshot({ bid: 1, ask: 1.2 })],
      ['A', snapshot({ bid: 9, ask: 9.4 })],
    ]);

    const result = enrichOptionContracts(contracts, snapshots, context);
    const byId = new Map(result.contracts.map((contract) => [contract.contractSymbol, contract]));

    expect(byId.get('A')!.bid).toBe(9);
    expect(byId.get('A')!.ask).toBe(9.4);
    expect(byId.get('C')!.bid).toBe(1);
    expect(byId.get('C')!.ask).toBe(1.2);
    // B had no snapshot: it must stay unpriced rather than inherit a neighbour.
    expect(byId.get('B')!.bid).toBeNull();
    expect(byId.get('B')!.ask).toBeNull();
    expect(byId.get('B')!.marketDataProvider).toBeNull();
  });

  it('carries bid, ask, mark, last, volume, IV and Greeks onto the contract', () => {
    const contracts = [catalogueContract({ contractSymbol: 'X' })];
    const snapshots = new Map([['X', snapshot({
      bid: 5.4, ask: 5.8, last: 5.7, volume: 1_234,
      impliedVolatility: 0.275, delta: 0.6857, gamma: 0.0426, theta: -0.5146, vega: 0.1074, rho: 0.0184,
    })]]);

    const [contract] = enrichOptionContracts(contracts, snapshots, context).contracts;

    expect(contract.bid).toBe(5.4);
    expect(contract.ask).toBe(5.8);
    expect(contract.mark).toBeCloseTo(5.6, 10);
    expect(contract.last).toBe(5.7);
    expect(contract.volume).toBe(1_234);
    expect(contract.impliedVolatility).toBe(0.275);
    expect(contract.delta).toBe(0.6857);
    expect(contract.gamma).toBe(0.0426);
    expect(contract.theta).toBe(-0.5146);
    expect(contract.vega).toBe(0.1074);
    expect(contract.rho).toBe(0.0184);
    expect(contract.valuationSource).toBe('provider');
    expect(contract.marketDataProvider).toBe('alpaca-options-data');
    expect(contract.marketDataFeed).toBe('indicative');
    expect(contract.asOf).toBe('2026-07-24T19:59:59.000Z');
  });

  it('keeps catalogue-owned fields untouched by market data', () => {
    const contracts = [catalogueContract({ contractSymbol: 'X', strike: 200, openInterest: 4_321 })];
    const snapshots = new Map([['X', snapshot({ bid: 1, ask: 2 })]]);

    const [contract] = enrichOptionContracts(contracts, snapshots, context).contracts;

    expect(contract.strike).toBe(200);
    expect(contract.openInterest).toBe(4_321);
    expect(contract.expiration).toBe(EXPIRATION);
    expect(contract.oiAsOf).toBe('2026-07-24');
    expect(contract.provider).toBe('alpaca');
  });

  it('reports missing fields as null and never as zero', () => {
    const contracts = [catalogueContract({ contractSymbol: 'X' })];
    // A real illiquid contract: quote present but zero-bid, no trade, no Greeks.
    const snapshots = new Map([['X', snapshot({ bid: null, ask: 0.99 })]]);

    const [contract] = enrichOptionContracts(contracts, snapshots, context).contracts;

    expect(contract.bid).toBeNull();
    expect(contract.volume).toBeNull();
    expect(contract.mark).toBeNull();
    expect(contract.impliedVolatility).toBeNull();
    expect(contract.delta).toBeNull();
    expect(contract.gamma).toBeNull();
    expect(contract.theta).toBeNull();
    expect(contract.vega).toBeNull();
  });

  it('warns when no market data matched the chain at all', () => {
    const result = enrichOptionContracts([catalogueContract()], new Map(), context);
    expect(result.contracts[0].bid).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/No options market data matched/i);
  });

  it('warns about partial market-data coverage', () => {
    const contracts = [
      catalogueContract({ contractSymbol: 'A' }),
      catalogueContract({ contractSymbol: 'B' }),
    ];
    const snapshots = new Map([['A', snapshot({ bid: 1, ask: 2 })]]);
    const result = enrichOptionContracts(contracts, snapshots, context);
    expect(result.warnings.join(' ')).toMatch(/covered 1 of 2 contracts/i);
  });
});

describe('deriveValuation', () => {
  /**
   * A chain whose marks were generated by the model itself, so the solver has a
   * known answer to recover. `discountFactor`/`forward` are never passed in —
   * they must be re-solved from put-call parity across these marks alone.
   */
  function modelChain(volatility: number, strikes = [190, 195, 200, 205, 210]) {
    const timeToExpiryYears = (optionExpiryInstantMs(EXPIRATION)! - NOW_MS) / (365 * 24 * 60 * 60 * 1_000);
    const discountFactor = 0.995;
    const forward = 206;
    return strikes.flatMap((strike) => (['call', 'put'] as const).map((type) => {
      const mark = black76Price({ type, strike, timeToExpiryYears, discountFactor, forward, volatility })!;
      return catalogueContract({
        contractSymbol: `${type}-${strike}`, type, strike,
        bid: mark - 0.05, ask: mark + 0.05, mark,
        marketDataProvider: 'alpaca-options-data', marketDataFeed: 'indicative',
      });
    }));
  }

  it('solves IV and Greeks from observed marks and tags them as Nexora-derived', () => {
    const volatility = 0.32;
    const result = deriveValuation(modelChain(volatility), context);

    expect(result.derivedCount).toBe(10);
    for (const contract of result.contracts) {
      expect(contract.valuationSource).toBe('nexora-derived');
      expect(contract.impliedVolatility).toBeCloseTo(volatility, 4);
      expect(contract.delta).not.toBeNull();
      expect(contract.gamma).not.toBeNull();
      expect(contract.theta).not.toBeNull();
      expect(contract.vega).not.toBeNull();
    }
    // Directional sanity, not just presence.
    const call = result.contracts.find((contract) => contract.type === 'call' && contract.strike === 200)!;
    const put = result.contracts.find((contract) => contract.type === 'put' && contract.strike === 200)!;
    expect(call.delta!).toBeGreaterThan(0);
    expect(put.delta!).toBeLessThan(0);
    expect(call.theta!).toBeLessThan(0);
  });

  it('never overwrites values the provider already supplied', () => {
    const contracts = modelChain(0.32).map((contract, index) => index === 0
      ? { ...contract, impliedVolatility: 0.9, delta: 0.11, valuationSource: 'provider' as const }
      : contract);

    const result = deriveValuation(contracts, context);

    expect(result.contracts[0].impliedVolatility).toBe(0.9);
    expect(result.contracts[0].delta).toBe(0.11);
    expect(result.contracts[0].valuationSource).toBe('provider');
  });

  it('leaves contracts null when the forward curve cannot be solved', () => {
    // Only one strike has a two-sided pair, so parity has nothing to fit.
    const contracts = [
      catalogueContract({ contractSymbol: 'call-200', type: 'call', strike: 200, mark: 8 }),
      catalogueContract({ contractSymbol: 'put-200', type: 'put', strike: 200, mark: 6 }),
    ];

    const result = deriveValuation(contracts, context);

    expect(result.derivedCount).toBe(0);
    expect(result.contracts.every((contract) => contract.impliedVolatility === null)).toBe(true);
    expect(result.warning).toMatch(/could not be derived/i);
  });

  it('derives nothing without an accepted spot price', () => {
    const result = deriveValuation(modelChain(0.32), { ...context, spot: null });
    expect(result.derivedCount).toBe(0);
    expect(result.contracts.every((contract) => contract.delta === null)).toBe(true);
  });

  it('derives nothing for a contract without a real two-sided mark', () => {
    const chain = modelChain(0.32);
    const withoutMark = [
      ...chain,
      catalogueContract({ contractSymbol: 'call-300', type: 'call', strike: 300, bid: null, ask: 0.5, mark: null }),
    ];

    const result = deriveValuation(withoutMark, context);
    const unpriced = result.contracts.find((contract) => contract.contractSymbol === 'call-300')!;

    expect(unpriced.impliedVolatility).toBeNull();
    expect(unpriced.delta).toBeNull();
    expect(unpriced.valuationSource).toBeNull();
  });

  it('derives nothing once the expiration has passed', () => {
    const afterExpiry = optionExpiryInstantMs(EXPIRATION)! + 1_000;
    const result = deriveValuation(modelChain(0.32), { ...context, nowMs: afterExpiry });
    expect(result.derivedCount).toBe(0);
  });

  it('reports derived contracts in the enrichment warnings', () => {
    const chain = modelChain(0.32).map((contract) => ({
      ...contract,
      marketDataProvider: null, marketDataFeed: null, valuationSource: null,
      bid: null, ask: null,
    }));
    const snapshots = new Map(chain.map((contract) => [
      contract.contractSymbol,
      snapshot({ bid: contract.mark! - 0.05, ask: contract.mark! + 0.05 }),
    ]));

    const result = enrichOptionContracts(chain, snapshots, context);

    expect(result.derivedValuedCount).toBe(10);
    expect(result.providerValuedCount).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/calculated by Nexora/i);
  });
});
