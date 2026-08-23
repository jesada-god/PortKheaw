/**
 * THE PUT/CALL FALLBACK CASE — a constructed input, not a card anyone published.
 *
 * It exists to exercise one change: an Options Sentiment reading that is real
 * but has no history of its own to rank it against, sitting beside factors that
 * pull hard in opposite directions. Put/Call 0.90 lands in the neutral band of
 * the old absolute thresholds, so this case isolates the DIVISOR half of P0-2 —
 * the factor was already scoring zero, and what changes is only whether its 10
 * points stay in the denominator.
 *
 * IT IS NOT THE CARD THE CONTRADICTION REPORT WAS WRITTEN FROM. That card is
 * `report-card.fixture.ts`, and it publishes 51 / confidence 5 over a completely
 * different factor table. This file used to claim the report in its own header,
 * and so did `screenshotCase` in `symmetry.test.ts`; both claims were wrong and
 * the two together are why the release notes carried one number from each.
 * `docs/options-signal/changelog.md` now tabulates all three.
 *
 * The values below are chosen for the mechanism, not copied from a screen:
 *
 *   Macro         SPY above its EMA20, QQQ below   → the two cancel to a
 *                                                    MEASURED zero
 *   Trend         close < EMA20 < EMA50            → fully down, −25
 *   Momentum      histogram 1.6 on ATR 2, RVOL 1.06, Squeeze OFF
 *   Sentiment     Put/Call 0.90 with 1 of the 20 days needed to rank it
 *   Risk/Reward   price 100, support 93.77, resistance 110.83
 *   IV            98.6% against 30-day realized 128.4%, read at 41 DTE
 *   Earnings      5 days out — inside that contract's life
 */

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

export function available<T>(value: T, state: 'LIVE' | 'DELAYED' | 'STALE' = 'DELAYED'): OptionsSignalInputSlot<T> {
  return { status: 'available', state, value, provider: 'fixture', asOf: '2026-08-21T20:00:00.000Z' };
}

export const macro: MacroInput = {
  benchmarks: [
    { symbol: 'SPY', close: 500, ema20: 480 },
    { symbol: 'QQQ', close: 380, ema20: 390 },
  ],
};
export const trend: TrendInput = { close: 90, ema20: 95, ema50: 100 };
export const momentum: MomentumInput = {
  squeeze: 'OFF', squeezeMomentum: 1.6, atr: 2, relativeVolume: 1.06,
};
export const sentiment: SentimentInput = {
  putCallRatio: 0.9, basis: 'open-interest', putTotal: 9_000, callTotal: 10_000, expiration: '2026-10-02',
  percentileObservations: 1, ownPercentile: null,
};
export const riskReward: RiskRewardInput = { price: 100, support: 93.77, resistance: 110.83 };
export const pricing: IvPricingInput = {
  basis: 'iv-vs-realized', impliedVolatility: 0.986, realizedVolatility: 1.284, ratio: 0.768,
  observations: 30, realizedWindowDays: 30, dte: 41,
};
export const event: EventRiskInput = { reportDate: '2026-08-27', daysToEarnings: 5, timeOfDay: 'post-market' };

export function baseInput(overrides: Partial<OptionsSignalInput> = {}): OptionsSignalInput {
  return {
    symbol: 'TEST',
    timeframe: '1D',
    calculatedAt: '2026-08-22T00:00:00.000Z',
    latestCandleAt: '2026-08-21',
    finalizedCandles: 250,
    macro: available(macro),
    trend: available(trend),
    momentum: available(momentum),
    pricing: available<IvPricingInput>(pricing),
    sentiment: available(sentiment),
    riskReward: available(riskReward),
    event: available(event),
    ...overrides,
  };
}

