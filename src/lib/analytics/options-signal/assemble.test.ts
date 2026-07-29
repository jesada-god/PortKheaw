import { describe, expect, it } from 'vitest';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import type { OptionsSrResult } from '@/src/lib/analytics/options-sr/types';
import {
  assembleOptionsSignalInput,
  buildPricingSlot,
  buildRiskRewardSlot,
  buildSentimentSlot,
  dataStateFromChainStatus,
  type OptionsSignalServerContext,
} from './assemble';
import type { OptionsSignalInputSlot, PriceLevelsInput } from './types';

const ASOF = '2026-07-27T20:00:00.000Z';

function contract(overrides: {
  type: 'call' | 'put';
  strike: number;
  impliedVolatility?: number | null;
  openInterest?: number | null;
}): OptionContract {
  return {
    contractSymbol: `${overrides.type}-${overrides.strike}`,
    underlyingSymbol: 'TEST',
    type: overrides.type,
    expiration: '2026-08-21',
    strike: overrides.strike,
    bid: 1, ask: 1.2, last: null, mark: null,
    volume: 10,
    openInterest: overrides.openInterest ?? 100,
    impliedVolatility: overrides.impliedVolatility ?? null,
    delta: null, gamma: null, theta: null, vega: null, rho: null,
    inTheMoney: null,
    multiplier: 100,
    currency: 'USD',
    provider: 'alpaca',
    marketDataProvider: null, marketDataFeed: null, oiAsOf: null,
    delayedMinutes: null, valuationSource: null,
    asOf: ASOF,
    timestampKind: 'receipt',
    status: 'delayed',
  };
}

function chain(impliedVolatility: number | null, status: OptionsChain['status'] = 'delayed'): OptionsChain {
  return {
    underlyingSymbol: 'TEST',
    spot: 100,
    expiration: '2026-08-21',
    expirations: ['2026-08-21'],
    calls: [95, 100, 105].map((strike) => contract({ type: 'call', strike, impliedVolatility })),
    puts: [95, 100, 105].map((strike) => contract({ type: 'put', strike, impliedVolatility })),
    provider: 'alpaca',
    asOf: ASOF,
    timestampKind: 'receipt',
    status,
    delayedMinutes: 15,
    completeness: 1,
    warnings: [],
  };
}

const availableSr: OptionsSrResult = {
  status: 'available',
  symbol: 'TEST',
  expiration: '2026-08-21',
  acceptedPrice: 100,
  callWall: null,
  putWall: null,
  maxPain: null,
  totalCallOI: 10_000,
  totalPutOI: 4_500,
  putCallOIRatio: 0.45,
  strikeCoverage: 12,
  contractCoverage: 1,
  provider: 'alpaca',
  asOf: ASOF,
  dataMode: 'DELAYED',
  reliability: 'high',
  limitations: [],
};

const levels: OptionsSignalInputSlot<PriceLevelsInput> = {
  status: 'available',
  state: 'DELAYED',
  value: { close: 98, support: 95, resistance: 110 },
  provider: 'yahoo',
  asOf: ASOF,
};

describe('dataStateFromChainStatus', () => {
  it('never claims a live state for a delayed or cached chain', () => {
    expect(dataStateFromChainStatus('live')).toBe('LIVE');
    expect(dataStateFromChainStatus('delayed')).toBe('DELAYED');
    expect(dataStateFromChainStatus('cached')).toBe('DELAYED');
    expect(dataStateFromChainStatus('stale')).toBe('STALE');
  });
});

describe('buildRiskRewardSlot', () => {
  it('anchors the confirmed daily levels to the accepted live price', () => {
    const slot = buildRiskRewardSlot(levels, 102);
    expect(slot.status).toBe('available');
    if (slot.status !== 'available') return;
    expect(slot.value).toEqual({ price: 102, support: 95, resistance: 110 });
  });

  it('falls back to the finalized close when no accepted price exists', () => {
    for (const price of [null, 0, Number.NaN]) {
      const slot = buildRiskRewardSlot(levels, price);
      expect(slot.status === 'available' && slot.value.price).toBe(98);
    }
  });

  it('stays unavailable when the zones themselves are unavailable', () => {
    const slot = buildRiskRewardSlot(
      { status: 'unavailable', state: 'UNAVAILABLE', reason: 'ไม่มีโซน', provider: null, asOf: null },
      100,
    );
    expect(slot.status).toBe('unavailable');
  });
});

describe('buildPricingSlot', () => {
  const realized = { value: 0.32, observations: 250 };

  it('uses a real IV Rank when one is ever supplied', () => {
    const slot = buildPricingSlot(
      { chain: chain(0.24), optionsSr: availableSr, ivRank: { ivRank: 24, observations: 252 } },
      realized,
    );
    expect(slot.status).toBe('available');
    if (slot.status !== 'available') return;
    expect(slot.value.basis).toBe('iv-rank');
  });

  it('falls back to the labelled IV-vs-realized basis built from two real measurements', () => {
    const slot = buildPricingSlot({ chain: chain(0.24), optionsSr: availableSr }, realized);
    expect(slot.status).toBe('available');
    if (slot.status !== 'available' || slot.value.basis !== 'iv-vs-realized') throw new Error('expected fallback basis');
    expect(slot.value.impliedVolatility).toBeCloseTo(0.24, 6);
    expect(slot.value.realizedVolatility).toBe(0.32);
    expect(slot.value.ratio).toBeCloseTo(0.75, 6);
    expect(slot.state).toBe('DELAYED');
  });

  it('is unavailable — never zero — when the provider sent no implied volatility', () => {
    const slot = buildPricingSlot({ chain: chain(null), optionsSr: availableSr }, realized);
    expect(slot.status).toBe('unavailable');
    expect(slot.state).toBe('UNAVAILABLE');
  });

  it('is unavailable when there is no realized-volatility baseline to compare against', () => {
    const slot = buildPricingSlot({ chain: chain(0.24), optionsSr: availableSr }, null);
    expect(slot.status).toBe('unavailable');
  });

  it('is unavailable while the chain has not loaded', () => {
    expect(buildPricingSlot({ chain: null, optionsSr: null }, realized).status).toBe('unavailable');
  });
});

describe('buildSentimentSlot', () => {
  it('reuses the Put/Call open interest already computed for the same chain', () => {
    const slot = buildSentimentSlot({ chain: chain(0.24), optionsSr: availableSr });
    expect(slot.status).toBe('available');
    if (slot.status !== 'available') return;
    expect(slot.value).toMatchObject({ putCallRatio: 0.45, basis: 'open-interest', callTotal: 10_000 });
  });

  it('surfaces the options failure verbatim instead of guessing a ratio', () => {
    const slot = buildSentimentSlot({
      chain: null,
      optionsSr: {
        status: 'unavailable',
        symbol: 'TEST',
        expiration: '2026-08-21',
        reason: 'entitlement-required',
        message: 'แพ็กเกจไม่รองรับ options',
        provider: 'alpaca',
        asOf: ASOF,
        dataMode: 'DELAYED',
        limitations: [],
      },
    });
    expect(slot.status).toBe('unavailable');
    expect(slot.status === 'unavailable' && slot.reason).toBe('แพ็กเกจไม่รองรับ options');
  });

  it('is unavailable when open interest produced no usable ratio', () => {
    const slot = buildSentimentSlot({ chain: null, optionsSr: { ...availableSr, putCallOIRatio: null } });
    expect(slot.status).toBe('unavailable');
  });
});

describe('assembleOptionsSignalInput', () => {
  const context: OptionsSignalServerContext = {
    symbol: 'TEST',
    timeframe: '1D',
    calculatedAt: '2026-07-28T00:00:00.000Z',
    latestCandleAt: '2026-07-27',
    finalizedCandles: 250,
    macro: { status: 'unavailable', state: 'UNAVAILABLE', reason: 'x', provider: null, asOf: null },
    trend: { status: 'unavailable', state: 'UNAVAILABLE', reason: 'x', provider: null, asOf: null },
    momentum: { status: 'unavailable', state: 'UNAVAILABLE', reason: 'x', provider: null, asOf: null },
    levels,
    event: { status: 'unavailable', state: 'UNAVAILABLE', reason: 'x', provider: null, asOf: null },
    realizedVolatility: { value: 0.32, observations: 250 },
  };

  it('carries the server slots through untouched and derives the options slots', () => {
    const assembled = assembleOptionsSignalInput(context, {
      chain: chain(0.24),
      optionsSr: availableSr,
      acceptedPrice: 102,
    });
    expect(assembled.macro).toBe(context.macro);
    expect(assembled.trend).toBe(context.trend);
    expect(assembled.event).toBe(context.event);
    expect(assembled.pricing.status).toBe('available');
    expect(assembled.sentiment.status).toBe('available');
    expect(assembled.riskReward.status === 'available' && assembled.riskReward.value.price).toBe(102);
  });
});

describe('stale-if-error fallback (429/5xx keeps Put/Call and IV readable)', () => {
  const FETCHED_AT = '2026-07-28T19:30:00.000Z';
  const fallback = {
    chain: chain(0.4),
    result: availableSr,
    fetchedAt: FETCHED_AT,
    reason: 'rate-limited',
  };

  it('serves Put/Call from the last-good chain and marks it STALE with its real fetch time', () => {
    const slot = buildSentimentSlot({ chain: null, optionsSr: null, staleFallback: fallback });
    expect(slot.status).toBe('available');
    if (slot.status !== 'available') return;
    expect(slot.state).toBe('STALE');
    expect(slot.value.putCallRatio).toBe(0.45);
    expect(slot.value.basis).toBe('open-interest');
    expect(slot.provider).toBe('alpaca');
    // Disclosed as of the moment the data was really fetched, not "now".
    expect(slot.asOf).toBe(FETCHED_AT);
  });

  it('serves IV from the last-good chain as STALE, still on the labelled realized basis', () => {
    const slot = buildPricingSlot(
      { chain: null, optionsSr: null, staleFallback: fallback },
      { value: 0.3, observations: 250 },
    );
    expect(slot.status).toBe('available');
    if (slot.status !== 'available') return;
    expect(slot.state).toBe('STALE');
    expect(slot.value.basis).toBe('iv-vs-realized');
    expect(slot.asOf).toBe(FETCHED_AT);
  });

  it('prefers the live chain and ignores the fallback whenever one is present', () => {
    const slot = buildSentimentSlot({
      chain: chain(0.4),
      optionsSr: availableSr,
      staleFallback: { ...fallback, result: { ...availableSr, putCallOIRatio: 9.99 } },
    });
    expect(slot.status).toBe('available');
    if (slot.status !== 'available') return;
    expect(slot.state).toBe('DELAYED');
    expect(slot.value.putCallRatio).toBe(0.45);
  });

  it('stays UNAVAILABLE with a reason when the failure had no last-good chain', () => {
    const sentiment = buildSentimentSlot({ chain: null, optionsSr: null, staleFallback: null });
    const pricing = buildPricingSlot({ chain: null, optionsSr: null, staleFallback: null }, { value: 0.3, observations: 250 });
    for (const slot of [sentiment, pricing]) {
      expect(slot.status).toBe('unavailable');
      if (slot.status !== 'unavailable') continue;
      expect(slot.state).toBe('UNAVAILABLE');
      expect(slot.reason.length).toBeGreaterThan(0);
    }
  });

  it('carries the stale reading through the whole assembled input', () => {
    const context: OptionsSignalServerContext = {
      symbol: 'TEST',
      timeframe: '1D',
      calculatedAt: '2026-07-28T20:00:00.000Z',
      latestCandleAt: '2026-07-27',
      finalizedCandles: 250,
      macro: { status: 'unavailable', state: 'UNAVAILABLE', reason: 'n/a', provider: null, asOf: null },
      trend: { status: 'unavailable', state: 'UNAVAILABLE', reason: 'n/a', provider: null, asOf: null },
      momentum: { status: 'unavailable', state: 'UNAVAILABLE', reason: 'n/a', provider: null, asOf: null },
      levels,
      event: { status: 'unavailable', state: 'UNAVAILABLE', reason: 'n/a', provider: null, asOf: null },
      realizedVolatility: { value: 0.3, observations: 250 },
    };
    const input = assembleOptionsSignalInput(context, {
      chain: null,
      optionsSr: null,
      staleFallback: fallback,
      acceptedPrice: 100,
    });
    expect(input.sentiment.state).toBe('STALE');
    expect(input.pricing.state).toBe('STALE');
  });
});
