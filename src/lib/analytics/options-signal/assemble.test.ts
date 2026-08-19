import { describe, expect, it } from 'vitest';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import type { OptionsSrResult } from '@/src/lib/analytics/options-sr/types';
import {
  assembleOptionsSignalInput,
  atmStraddleExpectedMove,
  buildLiquiditySlot,
  buildPricingSlot,
  buildRiskRewardSlot,
  buildSentimentSlot,
  chainDte,
  dataStateFromChainStatus,
  ivPercentilePendingOf,
  putCallVolumeRatio,
  realizedWindowForDte,
  type OptionsSignalServerContext,
} from './assemble';
import { OPTIONS_SIGNAL_CONFIG } from './config';
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
    expect(slot.value).toEqual({ price: 102, support: 95, resistance: 110, atr: null, expectedMove: null });
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

/**
 * The assembly-layer half of the rework: the bases that make a raw IV or a raw
 * Put/Call mean something, the two yardsticks a percentage cannot supply, and
 * the chain tradeability the card was already telling readers to check.
 */

const realizedWindows = {
  long: { value: 0.30, observations: 250 },
  near: { value: 0.45, observations: 20 },
  far: { value: 0.40, observations: 30 },
};

describe('realized-volatility window follows the contract, not the calendar', () => {
  it('uses the 1-year window for a genuinely long-dated contract', () => {
    expect(realizedWindowForDte(90, realizedWindows, realizedWindows.long)?.windowDays)
      .toBe(OPTIONS_SIGNAL_CONFIG.iv.realizedWindowDays);
  });

  it('switches to a short window once DTE drops under the threshold', () => {
    // A 30-day option is not priced against a year of realized volatility.
    expect(realizedWindowForDte(30, realizedWindows, realizedWindows.long)?.windowDays).toBe(30);
    expect(realizedWindowForDte(14, realizedWindows, realizedWindows.long)?.windowDays).toBe(20);
  });

  it('sits on the threshold without switching', () => {
    expect(realizedWindowForDte(
      OPTIONS_SIGNAL_CONFIG.iv.shortDatedDteThreshold,
      realizedWindows,
      realizedWindows.long,
    )?.windowDays).toBe(OPTIONS_SIGNAL_CONFIG.iv.realizedWindowDays);
  });

  it('falls back to the long window rather than reporting nothing', () => {
    expect(realizedWindowForDte(20, { long: realizedWindows.long, near: null, far: null }, realizedWindows.long)?.windowDays)
      .toBe(OPTIONS_SIGNAL_CONFIG.iv.realizedWindowDays);
    expect(realizedWindowForDte(20, { long: null, near: null, far: null }, null)).toBeNull();
  });

  it('labels the basis with the window the slot actually used', () => {
    const slot = buildPricingSlot(
      { chain: chain(0.5), optionsSr: availableSr },
      realizedWindows.long,
      realizedWindows,
    );
    expect(slot.status).toBe('available');
    if (slot.status !== 'available' || slot.value.basis !== 'iv-vs-realized') throw new Error('expected the realized basis');
    // The fixture chain expires 25 calendar days after its asOf.
    expect(chainDte(chain(0.5))).toBe(25);
    expect(slot.value.dte).toBe(25);
    expect(slot.value.realizedWindowDays).toBe(20);
    expect(slot.value.realizedVolatility).toBe(0.45);
  });
});

describe('IV percentile prefers the readings this symbol has published before', () => {
  it('reports the percentile once enough of that history exists', () => {
    const history = Array.from({ length: 60 }, (_value, index) => 0.2 + index * 0.002);
    const slot = buildPricingSlot(
      { chain: chain(0.5), optionsSr: availableSr, ownHistory: { atmIv: history } },
      realizedWindows.long,
      realizedWindows,
    );
    if (slot.status !== 'available' || slot.value.basis !== 'iv-percentile') throw new Error('expected the percentile basis');
    expect(slot.value.ivPercentile).toBe(100);
    expect(slot.value.observations).toBe(60);
  });

  it('says how many days are still missing rather than reporting a failure', () => {
    expect(ivPercentilePendingOf(undefined)).toEqual({ observations: 0, required: 60, missingDays: 60 });
    expect(ivPercentilePendingOf(Array.from({ length: 12 }, () => 0.3)))
      .toEqual({ observations: 12, required: 60, missingDays: 48 });
    expect(ivPercentilePendingOf(Array.from({ length: 60 }, () => 0.3))).toBeNull();
  });
});

describe('Put/Call gains a volume ratio and a self-relative percentile', () => {
  it('sums traded volume off the same chain', () => {
    // The fixture puts 10 contracts of volume on each of six legs.
    expect(putCallVolumeRatio(chain(0.24))).toBe(1);
    expect(putCallVolumeRatio(null)).toBeNull();
  });

  it('carries the percentile through only when there are enough readings', () => {
    const history = Array.from({ length: 30 }, (_value, index) => 0.3 + index * 0.01);
    const withHistory = buildSentimentSlot({
      chain: chain(0.24), optionsSr: availableSr, ownHistory: { putCallRatio: history },
    });
    if (withHistory.status !== 'available') throw new Error('expected a sentiment reading');
    expect(withHistory.value.ownPercentile).not.toBeNull();
    expect(withHistory.value.percentileObservations).toBe(30);
    expect(withHistory.value.volumeRatio).toBe(1);

    const withoutHistory = buildSentimentSlot({ chain: chain(0.24), optionsSr: availableSr });
    if (withoutHistory.status !== 'available') throw new Error('expected a sentiment reading');
    expect(withoutHistory.value.ownPercentile).toBeNull();
    expect(withoutHistory.value.percentileObservations).toBe(0);
  });
});

describe('expected move comes from the real ATM straddle', () => {
  it('adds the two ATM legs at the same strike', () => {
    // Every fixture leg is bid 1 / ask 1.2, so each mid is 1.1.
    expect(atmStraddleExpectedMove(chain(0.24))).toBeCloseTo(2.2, 6);
  });

  it('returns nothing rather than substituting a model when the legs are unpriced', () => {
    const priced = chain(0.24);
    const stripped: OptionsChain = {
      ...priced,
      calls: priced.calls.map((leg) => ({ ...leg, bid: null, ask: null, mark: null, last: null })),
      puts: priced.puts.map((leg) => ({ ...leg, bid: null, ask: null, mark: null, last: null })),
    };
    expect(atmStraddleExpectedMove(stripped)).toBeNull();
  });

  it('reaches the risk/reward slot so the modal can quote distances in expected moves', () => {
    const slot = buildRiskRewardSlot({ ...levels, value: { ...levels.value, atr: 2 } }, 100, 2.2);
    if (slot.status !== 'available') throw new Error('expected levels');
    expect(slot.value.expectedMove).toBe(2.2);
    expect(slot.value.atr).toBe(2);
  });
});

describe('liquidity is measured off the near-the-money strikes only', () => {
  it('takes medians over the strikes inside the ATM window', () => {
    const slot = buildLiquiditySlot({ chain: chain(0.24), optionsSr: availableSr });
    if (slot.status !== 'available') throw new Error('expected a liquidity reading');
    expect(slot.value.contractsExamined).toBe(6);
    expect(slot.value.medianOpenInterest).toBe(100);
    expect(slot.value.medianVolume).toBe(10);
    // bid 1 / ask 1.2 -> mid 1.1 -> spread 0.2 / 1.1 = 18.18%.
    expect(slot.value.medianSpreadPercent).toBeCloseTo(18.18, 2);
  });

  it('ignores the wings, which are thin on every chain', () => {
    const base = chain(0.24);
    const withWings: OptionsChain = {
      ...base,
      calls: [...base.calls, contract({ type: 'call', strike: 500 })],
      puts: [...base.puts, contract({ type: 'put', strike: 5 })],
    };
    const slot = buildLiquiditySlot({ chain: withWings, optionsSr: availableSr });
    if (slot.status !== 'available') throw new Error('expected a liquidity reading');
    expect(slot.value.contractsExamined).toBe(6);
  });

  it('is unavailable, not zero, when no chain has loaded', () => {
    expect(buildLiquiditySlot({ chain: null, optionsSr: null }).status).toBe('unavailable');
  });
});

