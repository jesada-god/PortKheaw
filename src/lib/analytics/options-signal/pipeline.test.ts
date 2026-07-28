import { describe, expect, it } from 'vitest';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import type { OptionsSrResult } from '@/src/lib/analytics/options-sr/types';
import type { DataFreshness } from '@/src/lib/market-data/types';
import { assembleOptionsSignalInput, type OptionsSignalServerContext } from './assemble';
import { calculateOptionsSignal } from './calculations';
import { buildMacroInput, buildUnderlyingInputs, type UnderlyingCandle } from './underlying';

/**
 * End-to-end regression over the real assembly order: candles -> server context
 * -> browser assembly -> pure engine. It exists to catch drift between the three
 * layers, and to prove the still-forming candle can never move the result.
 */

const freshness: DataFreshness = { status: 'end-of-day', asOf: '2026-07-27T20:00:00.000Z', maxAgeSeconds: 21_600 };
const CALCULATED_AT = '2026-07-28T00:00:00.000Z';

function candles(length: number, closeAt: (index: number) => number, volumeAt: (index: number) => number = () => 1_000): UnderlyingCandle[] {
  return Array.from({ length }, (_value, index) => {
    const close = closeAt(index);
    return {
      date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
      open: close - 0.1,
      high: close + 0.6,
      low: close - 0.6,
      close,
      volume: volumeAt(index),
      finalized: true,
    };
  });
}

function optionContract(type: 'call' | 'put', strike: number, impliedVolatility: number): OptionContract {
  return {
    contractSymbol: `${type}-${strike}`,
    underlyingSymbol: 'TEST',
    type,
    expiration: '2026-08-21',
    strike,
    bid: 1, ask: 1.1, last: null, mark: null,
    volume: 25,
    openInterest: type === 'call' ? 5_000 : 2_000,
    impliedVolatility,
    delta: null, gamma: null, theta: null, vega: null, rho: null,
    inTheMoney: null,
    multiplier: 100,
    currency: 'USD',
    provider: 'alpaca',
    marketDataProvider: null, marketDataFeed: null, oiAsOf: null,
    delayedMinutes: 15, valuationSource: 'provider',
    asOf: '2026-07-27T20:00:00.000Z',
    timestampKind: 'receipt',
    status: 'delayed',
  };
}

function chainFixture(spot: number, impliedVolatility: number): OptionsChain {
  const strikes = [spot - 5, spot, spot + 5];
  return {
    underlyingSymbol: 'TEST',
    spot,
    expiration: '2026-08-21',
    expirations: ['2026-08-21'],
    calls: strikes.map((strike) => optionContract('call', strike, impliedVolatility)),
    puts: strikes.map((strike) => optionContract('put', strike, impliedVolatility)),
    provider: 'alpaca',
    asOf: '2026-07-27T20:00:00.000Z',
    timestampKind: 'receipt',
    status: 'delayed',
    delayedMinutes: 15,
    completeness: 1,
    warnings: [],
  };
}

const optionsSr: OptionsSrResult = {
  status: 'available',
  symbol: 'TEST',
  expiration: '2026-08-21',
  acceptedPrice: 100,
  callWall: null, putWall: null, maxPain: null,
  totalCallOI: 15_000,
  totalPutOI: 6_000,
  putCallOIRatio: 0.4,
  strikeCoverage: 12,
  contractCoverage: 1,
  provider: 'alpaca',
  asOf: '2026-07-27T20:00:00.000Z',
  dataMode: 'DELAYED',
  reliability: 'high',
  limitations: [],
};

function buildContext(rows: readonly UnderlyingCandle[]): OptionsSignalServerContext {
  const underlying = buildUnderlyingInputs(rows, {
    symbol: 'TEST', provider: 'yahoo-finance-chart', freshness, calculatedAt: CALCULATED_AT,
  });
  return {
    symbol: 'TEST',
    timeframe: '1D',
    calculatedAt: CALCULATED_AT,
    latestCandleAt: underlying.latestCandleAt,
    finalizedCandles: underlying.finalizedCandles,
    macro: buildMacroInput([
      { symbol: 'SPY', candles: candles(200, (index) => 400 + index * 0.4), provider: 'yahoo-finance-chart', freshness },
      { symbol: 'QQQ', candles: candles(200, (index) => 300 + index * 0.3), provider: 'yahoo-finance-chart', freshness },
    ], CALCULATED_AT),
    trend: underlying.trend,
    momentum: underlying.momentum,
    levels: underlying.levels,
    event: {
      status: 'available',
      state: 'DELAYED',
      value: { reportDate: '2026-08-25', daysToEarnings: 28, timeOfDay: 'post-market' },
      provider: 'alpha-vantage',
      asOf: '2026-07-27T20:00:00.000Z',
    },
    realizedVolatility: underlying.realizedVolatility,
  };
}

describe('options-signal pipeline', () => {
  // A rising series that still oscillates, so realized volatility is a real,
  // non-degenerate number rather than the artefact of a perfectly straight line.
  const uptrend = candles(
    320,
    (index) => 50 + index * 0.25 + Math.sin(index) * 1.2,
    (index) => (index >= 315 ? 2_000 : 1_000),
  );

  it('carries a real bullish uptrend through every layer into a call-side signal', () => {
    const context = buildContext(uptrend);
    const realized = context.realizedVolatility!.value;
    const result = calculateOptionsSignal(assembleOptionsSignalInput(context, {
      // Premium priced BELOW the underlying's own realized volatility is the
      // "cheap options" branch of the risk gate.
      chain: chainFixture(context.levels.status === 'available' ? context.levels.value.close : 100, realized * 0.75),
      optionsSr,
      acceptedPrice: null,
    }));

    expect(result.status).toBe('available');
    expect(result.underlyingBias).toBe('bullish');
    expect(['PRIME_CALL', 'CALL_WATCH']).toContain(result.signalType);
    expect(result.diagnostics.factors.trend.points).toBeGreaterThan(0);
    expect(result.diagnostics.factors.macro.points).toBeGreaterThan(0);
    expect(result.diagnostics.factors.sentiment.points).toBeGreaterThan(0);
    expect(result.diagnostics.iv.basis).toBe('iv-vs-realized');
    expect(result.diagnostics.iv.ratio).toBeCloseTo(0.75, 2);
    expect(result.diagnostics.iv.level).toBe('low');
    expect(result.diagnostics.iv.realizedVolatility).toBeGreaterThan(0);
    expect(result.suggestedOptionsSetup).toMatchObject({ status: 'suggested', direction: 'call' });
  });

  it('ignores the still-forming candle, so no factor can repaint', () => {
    const withPartial: UnderlyingCandle[] = [
      ...uptrend,
      // A violent, still-forming bar that would flip trend and RVOL if counted.
      {
        date: '2026-07-28', open: 130, high: 180, low: 10, close: 12, volume: 9_000_000, finalized: false,
      },
    ];
    const stable = calculateOptionsSignal(assembleOptionsSignalInput(buildContext(uptrend), {
      chain: null, optionsSr, acceptedPrice: null,
    }));
    const withForming = calculateOptionsSignal(assembleOptionsSignalInput(buildContext(withPartial), {
      chain: null, optionsSr, acceptedPrice: null,
    }));
    expect(withForming.diagnostics.factors.trend).toEqual(stable.diagnostics.factors.trend);
    expect(withForming.diagnostics.factors.momentum).toEqual(stable.diagnostics.factors.momentum);
    expect(withForming.signalType).toBe(stable.signalType);
    expect(withForming.latestCandleAt).toBe(stable.latestCandleAt);
  });

  it('reports insufficient data for a short history rather than a weak guess', () => {
    const result = calculateOptionsSignal(assembleOptionsSignalInput(buildContext(candles(30, () => 100)), {
      chain: null, optionsSr, acceptedPrice: null,
    }));
    expect(result.status).toBe('insufficient-data');
    expect(result.signalType).toBeNull();
  });
});
