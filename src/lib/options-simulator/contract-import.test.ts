import { describe, expect, it } from 'vitest';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import { findChainContract, importOptionContract, providerContractGaps, selectProviderPremium } from './contract-import';
import type { SimulationWorkspace } from './types';

const contract = (overrides: Partial<OptionContract> = {}): OptionContract => ({
  contractSymbol: 'RKLB270115C00025000', underlyingSymbol: 'RKLB', type: 'call',
  expiration: '2027-01-15', strike: 25, bid: 4.8, ask: 5.2, last: 5.1, mark: 5,
  volume: 42, openInterest: 900, impliedVolatility: 0.65,
  delta: 0.6, gamma: 0.03, theta: -0.04, vega: 0.08, rho: 0.01,
  inTheMoney: false, multiplier: 100, currency: 'USD', provider: 'alpha-vantage',
  marketDataProvider: null, marketDataFeed: null, oiAsOf: null, delayedMinutes: null, valuationSource: null,
  asOf: '2026-07-20T15:30:00.000Z', timestampKind: 'receipt', status: 'live',
  ...overrides,
});

const chain = (item = contract()): OptionsChain => ({
  underlyingSymbol: 'RKLB', spot: 23.5, expiration: '2027-01-15', expirations: ['2027-01-15'],
  calls: item.type === 'call' ? [item] : [], puts: item.type === 'put' ? [item] : [],
  provider: 'alpha-vantage', asOf: '2026-07-20T15:30:00.000Z', timestampKind: item.timestampKind, status: item.status,
  delayedMinutes: item.status === 'live' ? 0 : 15, completeness: 1, warnings: [],
});

const workspace = (): SimulationWorkspace => ({
  name: 'New', description: '', symbol: '', companyName: '', exchange: null, currency: 'USD',
  simulationType: 'monte-carlo', strategyType: 'Custom Multi-Leg', underlyingPrice: null,
  stockQuantity: 0, cashPosition: 0, entryDate: '2026-07-20', valuationDate: '2026-07-20',
  legs: [{ id: 'leg', kind: 'put', side: 'buy', quantity: 2, strike: 1, expiration: '2026-08-20', entryPremium: 1, impliedVolatility: 0.2, multiplier: 100, fees: 3, style: 'european' }],
  scenarios: [{ id: 'base', name: 'Base', targetPrice: 1, valuationDate: '2026-07-21', volatilityShift: 0, rate: 0.02, dividendYield: 0 }],
  monteCarlo: { paths: 1_000, seed: 42, horizonDays: 30, steps: 30, drift: 0, volatility: 0.2, rate: 0.02, dividendYield: 0 },
  dataSource: null, dataTimestamp: null, dataStatus: 'unavailable', resultSnapshot: null, methodologyVersion: 'options-simulator-v1',
});

describe('simulator provider contract import', () => {
  it('fills one real contract once with identity, source, quote, IV, spot and multiplier provenance', () => {
    const result = importOptionContract(workspace(), chain(), contract().contractSymbol);
    expect(result).not.toBeNull();
    expect(result?.underlyingPrice).toBe(23.5);
    expect(result?.dataSource).toBe('alpha-vantage');
    expect(result?.dataStatus).toBe('live');
    expect(result?.legs).toHaveLength(1);
    expect(result?.legs[0]).toEqual(expect.objectContaining({
      contractSymbol: 'RKLB270115C00025000', kind: 'call', strike: 25,
      expiration: '2027-01-15', entryPremium: 5.2, premiumSource: 'ask', midpoint: 5,
      impliedVolatility: 0.65, multiplier: 100, quantity: 2,
      inputMode: 'provider', contractProvider: 'alpha-vantage', contractStatus: 'live',
    }));
  });

  it('preserves real provider Greeks and labels their source', () => {
    const result = importOptionContract(workspace(), chain(), contract().contractSymbol);
    expect(result?.legs[0]).toEqual(expect.objectContaining({
      delta: 0.6, gamma: 0.03, theta: -0.04, vega: 0.08, rho: 0.01,
      deltaSource: 'provider', thetaSource: 'provider',
      deltaTimestamp: '2026-07-20T15:30:00.000Z', thetaTimestamp: '2026-07-20T15:30:00.000Z',
    }));
  });

  it('does not fabricate missing premiums, IV, or Greeks', () => {
    const missing = contract({ bid: null, ask: null, mark: null, last: null, impliedVolatility: null, delta: null, gamma: null, theta: null, vega: null, rho: null });
    const result = importOptionContract(workspace(), chain(missing), missing.contractSymbol);
    expect(result?.legs[0]).toEqual(expect.objectContaining({ entryPremium: 0, premiumSource: 'manual', impliedVolatility: 0, delta: null, theta: null }));
    expect(result?.legs[0].deltaSource).toBeUndefined();
    expect(result?.legs[0].thetaSource).toBeUndefined();
  });

  it('uses only the executable side and never falls back to Last or mark', () => {
    expect(selectProviderPremium(contract(), 'buy')).toEqual({ value: 5.2, source: 'ask' });
    expect(selectProviderPremium(contract(), 'sell')).toEqual({ value: 4.8, source: 'bid' });
    expect(selectProviderPremium(contract({ ask: null, last: 5.1, mark: 5 }), 'buy')).toBeNull();
    expect(selectProviderPremium(contract({ status: 'stale' }), 'buy')).toBeNull();
  });

  /*
    Alpaca is the only entitled options provider and it never publishes a `live`
    chain; the import also re-reads a chain the panel has usually just fetched,
    which comes back `cached`. Those two are the only statuses a real import ever
    sees, and refusing them left every imported Long Call with a zero premium.
  */
  it('prefills the quoted executable side of a delayed or cached snapshot', () => {
    expect(selectProviderPremium(contract({ status: 'delayed' }), 'buy')).toEqual({ value: 5.2, source: 'ask' });
    expect(selectProviderPremium(contract({ status: 'delayed' }), 'sell')).toEqual({ value: 4.8, source: 'bid' });
    expect(selectProviderPremium(contract({ status: 'cached' }), 'buy')).toEqual({ value: 5.2, source: 'ask' });
    expect(selectProviderPremium(contract({ status: 'stale' }), 'sell')).toBeNull();
  });

  it('treats a zero quoted side as an absent quote, never as a fill', () => {
    expect(selectProviderPremium(contract({ ask: 0 }), 'buy')).toBeNull();
    expect(selectProviderPremium(contract({ bid: 0 }), 'sell')).toBeNull();
  });

  it('imports a delayed Long Call with a positive premium, debit and break-even', () => {
    const delayed = contract({ status: 'delayed' });
    const result = importOptionContract(workspace(), chain(delayed), delayed.contractSymbol);
    const leg = result?.legs[0];
    expect(leg).toEqual(expect.objectContaining({ entryPremium: 5.2, premiumSource: 'ask', contractStatus: 'delayed' }));
    expect(leg && leg.entryPremium * leg.quantity * leg.multiplier).toBe(1_040);
    expect(providerContractGaps(result!)).toEqual([]);
  });

  it('names every field the provider could not supply', () => {
    const missing = contract({ bid: null, ask: null, mark: null, last: null, impliedVolatility: null });
    const result = importOptionContract(workspace(), chain(missing), missing.contractSymbol);
    expect(providerContractGaps(result!)).toEqual([
      { path: 'legs.0.entryPremium', label: 'ราคาสัญญาต่อหุ้น (Premium)' },
      { path: 'legs.0.impliedVolatility', label: 'ความผันผวนที่ตลาดคาด (IV)' },
    ]);
  });

  it('stays quiet for a leg that carries no provider contract identity', () => {
    expect(providerContractGaps(workspace())).toEqual([]);
  });

  it('rejects an unknown contract identity', () => {
    expect(importOptionContract(workspace(), chain(), 'unknown')).toBeNull();
    expect(findChainContract(chain(), 'unknown')).toBeNull();
    expect(findChainContract(chain(), contract().contractSymbol)?.strike).toBe(25);
  });

  /*
    The import effect decides success from the snapshot alone, because React
    applies a `setWorkspace` updater after the calling line has already run.
    That decision is only sound while these two conditions imply an import.
  */
  it('always imports when the identity resolves and the snapshot predates expiration', () => {
    const item = contract({ status: 'delayed' });
    const snapshot = chain(item);
    expect(snapshot.asOf.slice(0, 10) < item.expiration).toBe(true);
    expect(importOptionContract(workspace(), snapshot, item.contractSymbol)).not.toBeNull();
    expect(importOptionContract({ ...workspace(), valuationDate: '2028-01-01' }, snapshot, item.contractSymbol)).not.toBeNull();
  });
});
