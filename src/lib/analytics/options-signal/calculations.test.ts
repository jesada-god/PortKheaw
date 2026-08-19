import { describe, expect, it } from 'vitest';
import {
  biasFromDirectionBalance,
  calculateOptionsSignal,
  classifyIvLevel,
  scoreMacro,
  scoreMomentum,
  scoreRiskReward,
  scoreSentiment,
  scoreTrend,
} from './calculations';
import { OPTIONS_SIGNAL_CONFIG, OPTIONS_SIGNAL_TOTAL_WEIGHT, OPTIONS_SIGNAL_WEIGHTS } from './config';
import type {
  EventRiskInput,
  IvPricingInput,
  MacroInput,
  MomentumInput,
  OptionsSignalInput,
  OptionsSignalInputSlot,
  RiskRewardInput,
  SentimentInput,
  TrendInput,
} from './types';

function available<T>(value: T, state: 'LIVE' | 'DELAYED' | 'STALE' = 'DELAYED'): OptionsSignalInputSlot<T> {
  return { status: 'available', state, value, provider: 'fixture', asOf: '2026-07-27T20:00:00.000Z' };
}

function missing<T>(reason = 'ไม่มีข้อมูล'): OptionsSignalInputSlot<T> {
  return { status: 'unavailable', state: 'UNAVAILABLE', reason, provider: null, asOf: null };
}

const bullishMacro: MacroInput = {
  benchmarks: [
    { symbol: 'SPY', close: 500, ema20: 480 },
    { symbol: 'QQQ', close: 400, ema20: 390 },
  ],
};
const bearishMacro: MacroInput = {
  benchmarks: [
    { symbol: 'SPY', close: 460, ema20: 480 },
    { symbol: 'QQQ', close: 380, ema20: 390 },
  ],
};
const bullishTrend: TrendInput = { close: 110, ema20: 105, ema50: 100 };
const bearishTrend: TrendInput = { close: 90, ema20: 95, ema50: 100 };
const firedBullishMomentum: MomentumInput = {
  squeeze: 'FIRED_BULLISH', squeezeMomentum: 2.4, atr: 2, relativeVolume: 1.8,
};
const firedBearishMomentum: MomentumInput = {
  squeeze: 'FIRED_BEARISH', squeezeMomentum: -2.4, atr: 2, relativeVolume: 1.8,
};
const bullishSentiment: SentimentInput = {
  putCallRatio: 0.45, basis: 'open-interest', putTotal: 4_500, callTotal: 10_000, expiration: '2026-08-21',
};
const bullishRiskReward: RiskRewardInput = { price: 110, support: 105, resistance: 130 };
const bearishRiskReward: RiskRewardInput = { price: 90, support: 70, resistance: 95 };
const cheapIv: IvPricingInput = {
  basis: 'iv-vs-realized', impliedVolatility: 0.24, realizedVolatility: 0.32, ratio: 0.75,
  observations: 250, realizedWindowDays: 252, dte: 55,
};
const farEarnings: EventRiskInput = { reportDate: '2026-09-01', daysToEarnings: 28, timeOfDay: 'post-market' };

function input(overrides: Partial<OptionsSignalInput> = {}): OptionsSignalInput {
  return {
    symbol: 'TEST',
    timeframe: '1D',
    calculatedAt: '2026-07-28T00:00:00.000Z',
    latestCandleAt: '2026-07-27',
    finalizedCandles: 250,
    macro: available(bullishMacro),
    trend: available(bullishTrend),
    momentum: available(firedBullishMomentum),
    pricing: available<IvPricingInput>(cheapIv),
    sentiment: available(bullishSentiment),
    riskReward: available(bullishRiskReward),
    event: available(farEarnings),
    ...overrides,
  };
}

describe('factor scoring', () => {
  it('scores macro from index proxies only, and never from a missing EMA', () => {
    expect(scoreMacro(bullishMacro).normalized).toBe(1);
    expect(scoreMacro(bearishMacro).normalized).toBe(-1);
    expect(scoreMacro({ benchmarks: [{ symbol: 'SPY', close: 500, ema20: 480 }, { symbol: 'QQQ', close: 380, ema20: 390 }] }).normalized).toBe(0);
    const noEma = scoreMacro({ benchmarks: [{ symbol: 'SPY', close: 500, ema20: null }] });
    expect(noEma.normalized).toBeNull();
  });

  it('scores trend from EMA20/EMA50 structure and flags a missing EMA50 as partial', () => {
    expect(scoreTrend(bullishTrend).normalized).toBe(1);
    expect(scoreTrend(bearishTrend).normalized).toBe(-1);
    const partial = scoreTrend({ close: 110, ema20: 105, ema50: null });
    expect(partial.normalized).toBe(1);
    expect(partial.partial).toBe(true);
    expect(scoreTrend({ close: 110, ema20: null, ema50: null }).normalized).toBeNull();
  });

  it('treats a squeeze that is ON as compression, not as bullish evidence', () => {
    const on = scoreMomentum({ squeeze: 'ON', squeezeMomentum: 2, atr: 2, relativeVolume: 1.5 });
    const off = scoreMomentum({ squeeze: 'OFF', squeezeMomentum: 2, atr: 2, relativeVolume: 1.5 });
    expect(on.normalized).toBeLessThan(off.normalized!);
    expect(on.normalized).toBeCloseTo(off.normalized! * OPTIONS_SIGNAL_CONFIG.momentum.squeezeOnDamping, 6);
    // A squeeze that is ON with flat momentum is still not directional.
    const flat = scoreMomentum({ squeeze: 'ON', squeezeMomentum: 0, atr: 2, relativeVolume: 1.5 });
    expect(flat.normalized).toBe(0);
  });

  it('adds directional evidence only when the squeeze actually fires', () => {
    const bullish = scoreMomentum({ squeeze: 'FIRED_BULLISH', squeezeMomentum: null, atr: 2, relativeVolume: 1.5 });
    const bearish = scoreMomentum({ squeeze: 'FIRED_BEARISH', squeezeMomentum: null, atr: 2, relativeVolume: 1.5 });
    expect(bullish.normalized).toBeGreaterThan(0);
    expect(bearish.normalized).toBeLessThan(0);
    expect(bullish.normalized).toBeCloseTo(-bearish.normalized!, 6);
  });

  it('uses RVOL only to confirm an existing direction and never to create one', () => {
    const quiet = scoreMomentum({ squeeze: 'OFF', squeezeMomentum: 2, atr: 2, relativeVolume: 0.5 });
    const busy = scoreMomentum({ squeeze: 'OFF', squeezeMomentum: 2, atr: 2, relativeVolume: 2 });
    expect(Math.sign(quiet.normalized!)).toBe(1);
    expect(busy.normalized!).toBeGreaterThan(quiet.normalized!);
    // High RVOL on a flat market still yields no direction.
    expect(scoreMomentum({ squeeze: 'OFF', squeezeMomentum: 0, atr: 2, relativeVolume: 3 }).normalized).toBe(0);
  });

  it('marks momentum partial (never zero) when RVOL is unavailable', () => {
    const outcome = scoreMomentum({ squeeze: 'OFF', squeezeMomentum: 2, atr: 2, relativeVolume: null });
    expect(outcome.partial).toBe(true);
    expect(outcome.confirmation).toBeNull();
    expect(outcome.normalized).toBeCloseTo(OPTIONS_SIGNAL_CONFIG.momentum.unconfirmedMultiplier, 6);
  });

  it('reports momentum unavailable when neither the histogram nor a fire exists', () => {
    expect(scoreMomentum({ squeeze: 'OFF', squeezeMomentum: null, atr: null, relativeVolume: 1.2 }).normalized).toBeNull();
  });

  it('reads Put/Call open interest as positioning with a neutral band', () => {
    expect(scoreSentiment({ ...bullishSentiment, putCallRatio: 0.4 }).normalized).toBe(1);
    expect(scoreSentiment({ ...bullishSentiment, putCallRatio: 0.9 }).normalized).toBe(0);
    expect(scoreSentiment({ ...bullishSentiment, putCallRatio: 1.5 }).normalized).toBe(-1);
  });

  it('scores risk/reward symmetrically around a 1:1 ratio, for the led direction', () => {
    const bullish = { direction: 'bullish' as const };
    expect(scoreRiskReward({ price: 100, support: 90, resistance: 110 }, bullish).normalized).toBe(0);
    const favourable = scoreRiskReward({ price: 100, support: 95, resistance: 110 }, bullish);
    expect(favourable.normalized).toBe(1);
    expect(favourable.callRewardRisk).toBe(2);
    expect(favourable.scoredSide).toBe('call');
    const unfavourable = scoreRiskReward({ price: 100, support: 90, resistance: 105 }, bullish);
    expect(unfavourable.normalized).toBe(-1);
    expect(scoreRiskReward({ price: 100, support: null, resistance: null }, bullish).normalized).toBeNull();
  });

  it('mirrors the same geometry onto the Put side when the evidence leads bearish', () => {
    // Identical chart, opposite lead: a 2:1 PUT reward:risk is bearish evidence
    // of exactly the magnitude a 2:1 call reward:risk would be bullish evidence.
    const bearish = scoreRiskReward({ price: 100, support: 80, resistance: 110 }, { direction: 'bearish' });
    expect(bearish.scoredSide).toBe('put');
    expect(bearish.putRewardRisk).toBe(2);
    expect(bearish.normalized).toBe(-1);
  });

  it('treats a missing level as unbounded on that side, in mirror image', () => {
    // All-time high: nothing confirmed overhead is clear runway up.
    const noResistance = scoreRiskReward({ price: 100, support: 90, resistance: null });
    expect(noResistance.scoredSide).toBe('call');
    expect(noResistance.normalized).toBe(1);
    expect(noResistance.partial).toBe(true);
    // All-time low: nothing confirmed beneath is open downside risk.
    const noSupport = scoreRiskReward({ price: 100, support: null, resistance: 110 });
    expect(noSupport.normalized).toBe(-1);
    expect(noSupport.partial).toBe(true);
  });

  it('reads a price sitting on a level as a touch, not as a target', () => {
    expect(scoreRiskReward({ price: 100, support: 100, resistance: 110 }).normalized).toBe(1);
    expect(scoreRiskReward({ price: 100, support: 90, resistance: 100 }).normalized).toBe(-1);
    expect(scoreRiskReward({ price: 100, support: 100, resistance: 100 }).normalized).toBe(0);
    // A level the price is sitting on is not a "direction" question, so the
    // touch cases keep their full magnitude with or without a lead.
  });

  it('classifies IV Rank exactly on the documented boundaries', () => {
    const rank = (ivRank: number): IvPricingInput => ({ basis: 'iv-rank', ivRank, impliedVolatility: 0.3, observations: 252 });
    expect(classifyIvLevel(rank(29.9))).toBe('low');
    expect(classifyIvLevel(rank(30))).toBe('normal');
    expect(classifyIvLevel(rank(50))).toBe('normal');
    expect(classifyIvLevel(rank(50.1))).toBe('high');
    expect(classifyIvLevel(rank(69.9))).toBe('high');
    expect(classifyIvLevel(rank(70))).toBe('extreme');
  });

  it('classifies the labelled IV-vs-realized fallback on its own boundaries', () => {
    const ratio = (value: number): IvPricingInput => ({
      basis: 'iv-vs-realized', impliedVolatility: 0.3, realizedVolatility: 0.3 / value, ratio: value,
      observations: 250, realizedWindowDays: 252, dte: 55,
    });
    expect(classifyIvLevel(ratio(0.8))).toBe('low');
    expect(classifyIvLevel(ratio(0.9))).toBe('normal');
    expect(classifyIvLevel(ratio(1.25))).toBe('normal');
    expect(classifyIvLevel(ratio(1.3))).toBe('high');
    expect(classifyIvLevel(ratio(1.6))).toBe('extreme');
  });

  it('maps the normalized score onto a bias at the configured boundaries', () => {
    expect(biasFromDirectionBalance(OPTIONS_SIGNAL_CONFIG.direction.bullish)).toBe('bullish');
    expect(biasFromDirectionBalance(OPTIONS_SIGNAL_CONFIG.direction.bullish - 1)).toBe('neutral');
    expect(biasFromDirectionBalance(OPTIONS_SIGNAL_CONFIG.direction.bearish)).toBe('bearish');
    expect(biasFromDirectionBalance(OPTIONS_SIGNAL_CONFIG.direction.bearish + 1)).toBe('neutral');
  });
});

describe('calculateOptionsSignal', () => {
  it('produces PRIME_CALL when every factor lines up bullishly with cheap options', () => {
    const result = calculateOptionsSignal(input());
    expect(result.status).toBe('available');
    expect(result.signalType).toBe('PRIME_CALL');
    expect(result.underlyingBias).toBe('bullish');
    expect(result.confidenceScore).toBeGreaterThanOrEqual(OPTIONS_SIGNAL_CONFIG.quality.primeConfidence);
    expect(result.diagnostics.dataSufficiency.primeBlockers).toEqual([]);
    expect(result.diagnostics.availableWeight).toBe(OPTIONS_SIGNAL_TOTAL_WEIGHT);
    expect(result.diagnostics.factors.macro.points).toBe(OPTIONS_SIGNAL_WEIGHTS.macro);
    expect(result.diagnostics.factors.trend.points).toBe(OPTIONS_SIGNAL_WEIGHTS.trend);
    expect(result.suggestedOptionsSetup).toMatchObject({
      status: 'suggested',
      direction: 'call',
      dteMin: OPTIONS_SIGNAL_CONFIG.setup.lowIv.dteMin,
      deltaMax: OPTIONS_SIGNAL_CONFIG.setup.lowIv.deltaMax,
    });
  });

  it('produces PRIME_PUT when every factor lines up bearishly', () => {
    const result = calculateOptionsSignal(input({
      macro: available(bearishMacro),
      trend: available(bearishTrend),
      momentum: available(firedBearishMomentum),
      sentiment: available({ ...bullishSentiment, putCallRatio: 1.6 }),
      riskReward: available(bearishRiskReward),
    }));
    expect(result.signalType).toBe('PRIME_PUT');
    expect(result.underlyingBias).toBe('bearish');
    expect(result.suggestedOptionsSetup).toMatchObject({ status: 'suggested', direction: 'put' });
  });

  it('produces SIDEWAYS and refuses a setup when the evidence cancels out', () => {
    const result = calculateOptionsSignal(input({
      macro: available<MacroInput>({ benchmarks: [{ symbol: 'SPY', close: 500, ema20: 480 }, { symbol: 'QQQ', close: 380, ema20: 390 }] }),
      trend: available<TrendInput>({ close: 100, ema20: 100, ema50: 100 }),
      momentum: available<MomentumInput>({ squeeze: 'OFF', squeezeMomentum: 0, atr: 2, relativeVolume: 1 }),
      sentiment: available({ ...bullishSentiment, putCallRatio: 0.9 }),
      riskReward: available<RiskRewardInput>({ price: 100, support: 90, resistance: 110 }),
    }));
    expect(result.signalType).toBe('SIDEWAYS');
    expect(result.underlyingBias).toBe('neutral');
    expect(result.suggestedOptionsSetup.status).toBe('not-recommended');
  });

  it('keeps a live squeeze out of PRIME and records the compression penalty', () => {
    const result = calculateOptionsSignal(input({
      momentum: available<MomentumInput>({ squeeze: 'ON', squeezeMomentum: 2.4, atr: 2, relativeVolume: 1.8 }),
    }));
    expect(result.diagnostics.squeeze.state).toBe('ON');
    expect(result.diagnostics.penalties.map((penalty) => penalty.id)).toContain('squeeze-on');
    expect(result.signalType === 'PRIME_CALL').toBe(false);
  });

  it('raises IV_WARNING when premium is extreme, even with strong direction', () => {
    const result = calculateOptionsSignal(input({
      pricing: available<IvPricingInput>({
        basis: 'iv-vs-realized', impliedVolatility: 0.6, realizedVolatility: 0.3, ratio: 2,
        observations: 250, realizedWindowDays: 252, dte: 55,
      }),
    }));
    expect(result.signalType).toBe('IV_WARNING');
    expect(result.underlyingBias).toBe('bullish');
    expect(result.diagnostics.gates.ivWarning).toBe(true);
    expect(result.suggestedOptionsSetup.status).toBe('not-recommended');
  });

  it('downgrades PRIME to WATCH when premium is merely high', () => {
    const result = calculateOptionsSignal(input({
      pricing: available<IvPricingInput>({
        basis: 'iv-vs-realized', impliedVolatility: 0.45, realizedVolatility: 0.3, ratio: 1.5,
        observations: 250, realizedWindowDays: 252, dte: 55,
      }),
    }));
    expect(result.signalType).toBe('CALL_WATCH');
    expect(result.diagnostics.gates.downgrades).toContain('high-iv-blocks-prime');
    expect(result.suggestedOptionsSetup.status).toBe('not-recommended');
  });

  it('raises IV_WARNING when earnings are imminent', () => {
    const result = calculateOptionsSignal(input({
      event: available<EventRiskInput>({ reportDate: '2026-07-30', daysToEarnings: 2, timeOfDay: 'post-market' }),
    }));
    expect(result.signalType).toBe('IV_WARNING');
    expect(result.diagnostics.gates.ivWarningReasons.join(' ')).toContain('2');
    expect(result.confidenceScore).toBeLessThan(calculateOptionsSignal(input()).confidenceScore);
  });

  it('blocks PRIME (but not the direction) when earnings are inside the block window', () => {
    const result = calculateOptionsSignal(input({
      event: available<EventRiskInput>({ reportDate: '2026-08-03', daysToEarnings: 6, timeOfDay: 'pre-market' }),
    }));
    expect(result.signalType).toBe('CALL_WATCH');
    expect(result.underlyingBias).toBe('bullish');
    expect(result.diagnostics.gates.downgrades).toContain('earnings-blocks-prime');
  });

  it('drops missing IV and Put/Call from BOTH numerator and denominator', () => {
    const result = calculateOptionsSignal(input({
      pricing: missing<IvPricingInput>('ผู้ให้บริการไม่ได้ส่ง Implied Volatility'),
      sentiment: missing<SentimentInput>('ไม่มี Open Interest'),
    }));
    expect(result.diagnostics.factors.sentiment.points).toBeNull();
    expect(result.diagnostics.factors.sentiment.state).toBe('UNAVAILABLE');
    expect(result.diagnostics.availableWeight).toBe(OPTIONS_SIGNAL_TOTAL_WEIGHT - OPTIONS_SIGNAL_WEIGHTS.sentiment);
    expect(result.diagnostics.iv.level).toBeNull();
    // Pricing is a gate, not a direction: the bias must survive its absence...
    expect(result.underlyingBias).toBe('bullish');
    // ...but PRIME asserts the gate ran, so it is withheld and no setup is given.
    expect(result.diagnostics.dataSufficiency.primeBlockers).toContain('iv-unavailable');
    expect(result.signalType).toBe('CALL_WATCH');
    expect(result.suggestedOptionsSetup.status).toBe('not-recommended');
  });

  it('keeps a signal when support/resistance is unavailable but blocks PRIME', () => {
    const result = calculateOptionsSignal(input({ riskReward: missing<RiskRewardInput>('ไม่มีโซนที่ยืนยันได้') }));
    expect(result.status).toBe('available');
    expect(result.diagnostics.factors.riskReward.available).toBe(false);
    expect(result.diagnostics.dataSufficiency.primeBlockers).toContain('missing:riskReward');
    expect(result.signalType).toBe('CALL_WATCH');
  });

  it('penalizes a macro/trend conflict and lowers confidence', () => {
    const conflicted = calculateOptionsSignal(input({ macro: available(bearishMacro) }));
    expect(conflicted.diagnostics.penalties.map((penalty) => penalty.id)).toContain('macro-trend-conflict');
    expect(conflicted.diagnostics.agreement).toBeLessThan(1);
    expect(conflicted.confidenceScore).toBeLessThan(calculateOptionsSignal(input()).confidenceScore);
  });

  it('reports insufficient-data without inventing a direction', () => {
    const noTrend = calculateOptionsSignal(input({ trend: missing<TrendInput>('คำนวณ EMA ไม่ได้') }));
    expect(noTrend.status).toBe('insufficient-data');
    expect(noTrend.signalType).toBeNull();
    expect(noTrend.underlyingBias).toBeNull();
    expect(noTrend.confidenceScore).toBe(0);
    expect(noTrend.suggestedOptionsSetup.status).toBe('not-recommended');

    const shortHistory = calculateOptionsSignal(input({ finalizedCandles: 10 }));
    expect(shortHistory.status).toBe('insufficient-data');
    expect(shortHistory.signalType).toBeNull();
  });

  it('never emits PRIME once coverage falls below the sufficiency floor', () => {
    const result = calculateOptionsSignal(input({
      macro: missing<MacroInput>('ไม่มีดัชนีอ้างอิง'),
      sentiment: missing<SentimentInput>('ไม่มี Open Interest'),
      riskReward: missing<RiskRewardInput>('ไม่มีโซน'),
    }));
    expect(result.diagnostics.coverage).toBeLessThan(OPTIONS_SIGNAL_CONFIG.sufficiency.primeMinimumCoverage);
    expect(result.diagnostics.dataSufficiency.primeEligible).toBe(false);
    expect(['CALL_WATCH', 'SIDEWAYS']).toContain(result.signalType);
  });

  it('is deterministic and never mutates its input', () => {
    const source = input();
    const snapshot = JSON.stringify(source);
    const first = calculateOptionsSignal(source);
    const second = calculateOptionsSignal(source);
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('always states that confidence is evidence strength, not a win rate', () => {
    const result = calculateOptionsSignal(input());
    expect(result.reasoning.some((reason) => reason.id === 'disclaimer')).toBe(true);
  });
});

describe('provenance on every degraded dimension', () => {
  it('reports source and fetchedAt for IV and earnings so a STALE reading is auditable', () => {
    const result = calculateOptionsSignal(input({
      pricing: { status: 'available', state: 'STALE', value: cheapIv, provider: 'alpaca', asOf: '2026-07-28T19:30:00.000Z' },
      event: { status: 'available', state: 'STALE', value: farEarnings, provider: 'financial-modeling-prep', asOf: '2026-07-28T06:00:00.000Z' },
    }));
    expect(result.diagnostics.iv.state).toBe('STALE');
    expect(result.diagnostics.iv.source).toBe('alpaca');
    expect(result.diagnostics.iv.fetchedAt).toBe('2026-07-28T19:30:00.000Z');
    expect(result.diagnostics.event.state).toBe('STALE');
    expect(result.diagnostics.event.source).toBe('financial-modeling-prep');
    expect(result.diagnostics.event.fetchedAt).toBe('2026-07-28T06:00:00.000Z');
  });

  it('gives every unavailable dimension a reason instead of a bare blank', () => {
    const result = calculateOptionsSignal(input({
      pricing: missing<IvPricingInput>('ผู้ให้บริการไม่ได้ส่ง Implied Volatility'),
      sentiment: missing<SentimentInput>('ไม่มี Open Interest'),
      event: missing<EventRiskInput>('แพ็กเกจของผู้ให้บริการไม่รองรับปฏิทินงบการเงิน'),
    }));
    expect(result.diagnostics.iv.reason).toBeTruthy();
    expect(result.diagnostics.event.reason).toBeTruthy();
    expect(result.diagnostics.factors.sentiment.reason).toBeTruthy();
    for (const dimension of [result.diagnostics.iv.state, result.diagnostics.event.state, result.diagnostics.factors.sentiment.state]) {
      expect(dimension).toBe('UNAVAILABLE');
    }
  });

  it('never turns a missing Put/Call, IV or earnings into a scored zero or a safe reading', () => {
    const result = calculateOptionsSignal(input({
      pricing: missing<IvPricingInput>('ไม่มี IV'),
      sentiment: missing<SentimentInput>('ไม่มี OI'),
      event: missing<EventRiskInput>('ไม่มีปฏิทิน'),
    }));
    // Missing sentiment must not contribute 0 points to the numerator...
    expect(result.diagnostics.factors.sentiment.points).toBeNull();
    // ...nor 10 points of weight to the denominator.
    expect(result.diagnostics.availableWeight).toBe(OPTIONS_SIGNAL_TOTAL_WEIGHT - 10);
    // Missing IV is not "cheap": no setup is offered and PRIME is withheld.
    expect(result.diagnostics.iv.level).toBeNull();
    expect(result.diagnostics.dataSufficiency.primeBlockers).toContain('iv-unavailable');
    expect(result.signalType).not.toBe('PRIME_CALL');
    expect(result.signalType).not.toBe('PRIME_PUT');
    // Missing earnings is not "no event risk": it never earns an all-clear penalty of 0 risk.
    expect(result.diagnostics.event.daysToEarnings).toBeNull();
    expect(result.suggestedOptionsSetup.status).toBe('not-recommended');
  });
});
