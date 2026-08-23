/**
 * THE CARD THE CONTRADICTION REPORT WAS WRITTEN FROM, as engine input.
 *
 * The published card read **51 / 100 · confidence 5 / 100**, over a factor table
 * of macro 0, trend −8, momentum +9, sentiment 0 and Risk/Reward +1 — a total of
 * +2 out of 90. Nothing in this directory reproduced that until now: the two
 * fixtures that each described themselves as "the case from the report" both
 * carry a different set of points entirely and land on 52/58 and 42/41. Neither
 * is this card. See `docs/options-signal/changelog.md` for all three side by
 * side.
 *
 * Every value below is from the report, EXCEPT the four noted as derived. Those
 * four are not choices about the answer — each is either pinned by arithmetic
 * the report does state, or provably cannot move the published numbers. They are
 * marked individually rather than listed here, so a reader meets the caveat at
 * the value it applies to.
 *
 *   Price         41.88
 *   Support       39.2727   → 6.23% below, 0.66 ATR
 *   Resistance    46.4144   → 10.83% above, 1.15 ATR
 *   Momentum      TTM histogram 6.0774, Squeeze OFF, RVOL 1.06×
 *   Sentiment     Put/Call OI 0.89, Volume 0.79, no history to rank either
 *   IV            98.6% ATM against 30-day realized 128.4%, read at 41 DTE
 *   Earnings      2026-08-27, five days out, inside the contract's life
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

export const PRICE = 41.88;
export const SUPPORT = 39.2727;
export const RESISTANCE = 46.4144;

/**
 * DERIVED (1 of 4). The report quotes the two distances in ATR — 1.15 up and
 * 0.66 down — and not the ATR itself, so it is recovered from them:
 *
 *   (46.4144 − 41.88) ÷ 1.15 = 3.943      (41.88 − 39.2727) ÷ 0.66 = 3.951
 *
 * Any ATR in `(3.9259, 3.9602]` prints both figures exactly as the report does.
 * The published points do not vary anywhere inside that band — Momentum scores 9
 * at both ends of it — so this is a value the report determines to within a
 * range, and the range is narrower than the answer's sensitivity to it.
 * `report-card.test.ts` asserts both of those claims rather than restating them.
 */
export const ATR = 3.95;

/**
 * DERIVED (2 of 4). The report gives the factor score, −8 of 25, and not the
 * moving averages behind it.
 *
 * That score pins the inputs more tightly than it looks. `scoreTrend` reads only
 * the SIGNS of three comparisons and averages them, so −8 of 25 is reachable by
 * exactly one sign pattern — a vote sum of −1 out of 3 — and the magnitudes
 * never enter the arithmetic. Choosing numbers here is therefore choosing
 * nothing the report has not already stated: price above EMA20, below EMA50, and
 * EMA20 below EMA50, which is the shape of a downtrend price has begun to lift
 * out of.
 */
export const trend: TrendInput = { close: PRICE, ema20: 41.2, ema50: 42.6 };

/**
 * DERIVED (3 of 4). The report gives macro 0 of 15, counted at full weight.
 *
 * A MEASURED zero, not a missing factor — the card shows it inside the divisor.
 * With two benchmarks the only way to measure zero is one above its EMA20 and
 * one below, so the structure is fixed and only the quotes are invented.
 */
export const macro: MacroInput = {
  benchmarks: [
    { symbol: 'SPY', close: 500, ema20: 480 },
    { symbol: 'QQQ', close: 380, ema20: 390 },
  ],
};

export const momentum: MomentumInput = {
  squeeze: 'OFF', squeezeMomentum: 6.0774, atr: ATR, relativeVolume: 1.06,
};

/**
 * DERIVED (4 of 4). `putTotal` / `callTotal` are back-solved from the published
 * ratio (0.89 on open interest) at a plausible chain size. They are disclosure
 * only: `scoreSentiment` reads `putCallRatio`, and the totals are printed beside
 * it so a reader can see the ratio is not a rounding of two tiny numbers.
 *
 * `percentileObservations: 1` is the report's own state, not a derivation — the
 * card said this symbol had one of the twenty days it needs, which is exactly
 * why the factor scored a fallback zero.
 */
export const sentiment: SentimentInput = {
  putCallRatio: 0.89, basis: 'open-interest', putTotal: 8_900, callTotal: 10_000,
  volumeRatio: 0.79, expiration: '2026-10-02',
  percentileObservations: 1, ownPercentile: null,
};

export const riskReward: RiskRewardInput = {
  price: PRICE, support: SUPPORT, resistance: RESISTANCE, atr: ATR,
};

export const pricing: IvPricingInput = {
  basis: 'iv-vs-realized', impliedVolatility: 0.986, realizedVolatility: 1.284,
  ratio: 0.986 / 1.284, observations: 30, realizedWindowDays: 30, dte: 41,
};

export const event: EventRiskInput = { reportDate: '2026-08-27', daysToEarnings: 5, timeOfDay: 'post-market' };

export function reportCardInput(overrides: Partial<OptionsSignalInput> = {}): OptionsSignalInput {
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
