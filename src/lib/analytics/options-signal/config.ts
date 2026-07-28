/**
 * Every threshold and weight the Options Signal Engine uses, in one place, so
 * the model can be re-tuned without touching the scoring code.
 *
 * Design rules encoded here (not just documented):
 *  - direction, signal quality and the risk gate are three SEPARATE stages; no
 *    single number is allowed to leak across them;
 *  - implied volatility never contributes a directional point — it only gates;
 *  - relative volume never contributes direction — it only scales an existing
 *    directional conviction;
 *  - a TTM squeeze that is ON is compression, not a direction.
 */

export const OPTIONS_SIGNAL_WEIGHTS = {
  macro: 15,
  trend: 25,
  momentum: 25,
  sentiment: 10,
  riskReward: 15,
} as const;

export const OPTIONS_SIGNAL_TOTAL_WEIGHT = Object.values(OPTIONS_SIGNAL_WEIGHTS)
  .reduce((sum, weight) => sum + weight, 0);

export const OPTIONS_SIGNAL_CONFIG = {
  timeframe: '1D',
  /** EMA50 + a 20-period squeeze + a 20-day RVOL baseline need this much history. */
  minimumFinalizedCandles: 60,
  /** Index proxies for market regime. Both are ordinary equities to the candle service. */
  macroBenchmarks: ['SPY', 'QQQ'] as const,

  direction: {
    /** Applied to the coverage-normalized score in [-100, 100]. */
    bullish: 20,
    bearish: -20,
  },

  quality: {
    primeScore: 55,
    primeConfidence: 65,
    primeAgreement: 0.7,
    watchScore: 20,
  },

  momentum: {
    /**
     * |TTM momentum| / ATR14 at which the momentum factor saturates. Normalizing
     * by ATR keeps a $400 and a $4 stock on the same scale.
     */
    momentumAtrSaturation: 1,
    /** A squeeze that is still ON has not chosen a side; its conviction is halved. */
    squeezeOnDamping: 0.5,
    /** Bars after a squeeze releases during which the release still counts as "fired". */
    firedLookbackBars: 3,
    /** Extra conviction (in normalized units) added by a confirmed squeeze release. */
    firedBonus: 0.35,
    /** RVOL below this adds no confirmation; at/above `rvolSaturation` it adds all of it. */
    rvolFloor: 1,
    rvolSaturation: 1.5,
    /** Confirmation multiplier range applied to an EXISTING direction. Never a sign flip. */
    minimumConfirmation: 0.6,
    /** Multiplier used when RVOL is genuinely unavailable; also blocks PRIME. */
    unconfirmedMultiplier: 0.8,
  },

  sentiment: {
    /** Put/Call open-interest positioning. Below `bullishBelow` reads call-heavy. */
    bullishBelow: 0.7,
    bullishSaturation: 0.4,
    bearishAbove: 1.1,
    bearishSaturation: 1.5,
  },

  riskReward: {
    /** Reward:risk at which the factor saturates (2:1 in the favoured direction). */
    saturationRatio: 2,
    /** A level closer than this (% of price) is treated as touching, not as a target. */
    minimumDistancePercent: 0.1,
  },

  /**
   * IV Rank bands (spec): <30 low, 30-50 normal, >50 high, >=70 high-risk.
   * The `realized` bands apply to the clearly-labelled fallback basis, which
   * compares today's real ATM IV with 1-year realized volatility.
   */
  iv: {
    rank: { normalFrom: 30, highAbove: 50, extremeFrom: 70 },
    realized: { normalFrom: 0.9, highAbove: 1.25, extremeFrom: 1.6 },
    /** Trading days used for the realized-volatility comparison window. */
    realizedWindowDays: 252,
    minimumRealizedObservations: 120,
  },

  event: {
    /** Earnings this close force the IV_WARNING gate regardless of direction. */
    warningDays: 3,
    /** Earnings this close downgrade any PRIME signal to a WATCH. */
    blockPrimeDays: 7,
  },

  confidence: {
    coverageWeight: 0.3,
    agreementWeight: 0.35,
    strengthWeight: 0.35,
    penalties: {
      earningsImminent: 0.25,
      earningsNear: 0.15,
      earningsApproaching: 0.07,
      earningsNearDays: 7,
      earningsApproachingDays: 14,
      ivExtreme: 0.15,
      ivHigh: 0.07,
      macroTrendConflict: 0.1,
      squeezeOn: 0.1,
      momentumUnconfirmed: 0.05,
    },
  },

  /** Educational contract shapes. Never an instruction, never a specific contract. */
  setup: {
    lowIv: { dteMin: 30, dteMax: 60, deltaMin: 0.55, deltaMax: 0.7 },
    normalIv: { dteMin: 45, dteMax: 75, deltaMin: 0.55, deltaMax: 0.65 },
  },

  sufficiency: {
    /** Without these the engine reports insufficient-data instead of a signal. */
    required: ['trend', 'momentum'] as const,
    /** PRIME additionally requires all of these AND the coverage floor below. */
    primeRequired: ['macro', 'trend', 'momentum', 'riskReward'] as const,
    primeMinimumCoverage: 0.75,
    /**
     * A squeeze that is still ON means the market has not chosen a side yet, so
     * it can never be the strongest tier of signal no matter how the rest of the
     * evidence stacks up.
     */
    blockPrimeWhileSqueezeOn: true,
    /**
     * PRIME asserts that the risk gate was actually checked. Without an options
     * pricing measurement the IV half of that gate cannot run, so the strongest
     * tier is withheld rather than issued on an unverified assumption.
     */
    requirePricingForPrime: true,
  },
} as const;

export type OptionsSignalConfig = typeof OPTIONS_SIGNAL_CONFIG;
