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
 *  - a TTM squeeze that is ON is compression, not a direction;
 *  - liquidity is a tradeability badge, never a direction and never a weight.
 */

/**
 * Bump on ANY change to a number below, or to the arithmetic that reads them.
 * Every history record carries it, so a row recorded under an older model can
 * never be silently compared against one recorded under a newer one.
 */
export const OPTIONS_SIGNAL_CONFIG_VERSION = '2026.08.19';

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
    /**
     * RVOL confirmation is a LOGISTIC curve, not a step.
     *
     * The old floor/saturation ramp read 0.99x and 1.01x as 0% and 2% confirmation
     * — a cliff at exactly average volume, which is where the measurement is least
     * certain. `rvolMidpoint` is the RVOL that scores 50%; `rvolSteepness` sets how
     * fast it moves away from there, and nothing reaches a hard 0% or 100%.
     */
    rvolMidpoint: 1,
    rvolSteepness: 6,
    /** Confirmation multiplier range applied to an EXISTING direction. Never a sign flip. */
    minimumConfirmation: 0.6,
    /** Multiplier used when RVOL is genuinely unavailable; also blocks PRIME. */
    unconfirmedMultiplier: 0.8,
  },

  sentiment: {
    /**
     * Absolute Put/Call open-interest bands. Used ONLY when this symbol has no
     * history of its own — a raw 1.51 means different things on two tickers, so
     * the percentile basis below is preferred whenever it can be computed.
     */
    bullishBelow: 0.7,
    bullishSaturation: 0.4,
    bearishAbove: 1.1,
    bearishSaturation: 1.5,
    /** Trading days of this symbol's OWN Put/Call readings used for the percentile. */
    percentileLookbackDays: 60,
    /** Below this many recorded readings the percentile is withheld, not estimated. */
    minimumPercentileObservations: 20,
    /** Percentile band that reads as neutral positioning for this symbol. */
    percentileNeutralLow: 0.35,
    percentileNeutralHigh: 0.65,
  },

  riskReward: {
    /** Reward:risk at which the factor saturates (2:1 in the favoured direction). */
    saturationRatio: 2,
    /** A level closer than this (% of price) is treated as touching, not as a target. */
    minimumDistancePercent: 0.1,
    /**
     * With no direction to serve, geometry is SETUP QUALITY, not a vote.
     *
     * A neutral tape whose call R:R is 0.24 and whose put R:R is 4.23 is not
     * "bearish evidence worth -15" — it is one workable side, one unworkable one,
     * on a chart that has not chosen. The residual tilt is kept (it is real) but
     * damped to this fraction, so the factor can never cast a full-weight
     * directional vote the rest of the evidence never asked for.
     */
    sidewaysDamping: 0.25,
    /** R:R at or above which a side counts as a workable setup. */
    workableRatio: 2,
  },

  /**
   * How expensive the premium is. Three bases, in order of preference:
   *
   *  1. `iv-rank` — a provider-supplied historical IV Rank. None supplies one.
   *  2. `iv-percentile` — this symbol's OWN recorded ATM IV readings. Needs
   *     `minimumPercentileObservations` days; below that the card is told how many
   *     days are still missing rather than being shown "unavailable".
   *  3. `iv-vs-realized` — today's real ATM IV against the underlying's own
   *     realized volatility, always labelled with the window it used.
   */
  iv: {
    rank: { normalFrom: 30, highAbove: 50, extremeFrom: 70 },
    realized: { normalFrom: 0.9, highAbove: 1.25, extremeFrom: 1.6 },
    /** Trading days used for the LONG realized-volatility comparison window. */
    realizedWindowDays: 252,
    minimumRealizedObservations: 120,
    /**
     * A 30-day contract is not priced against a year of realized volatility.
     * Under this DTE the comparison switches to the short windows below.
     */
    shortDatedDteThreshold: 45,
    shortWindows: { near: 20, far: 30 },
    /** DTE at or below which the 20-day window is the closer match to the contract. */
    nearWindowDteThreshold: 25,
    minimumShortObservations: 15,
    /** Recorded ATM IV readings needed before a percentile may be published. */
    percentileLookbackDays: 60,
    minimumPercentileObservations: 60,
    percentile: { normalFrom: 30, highAbove: 50, extremeFrom: 70 },
  },

  /** Tradeability of the chain itself. A badge on the card; never a direction. */
  liquidity: {
    /** Only strikes within this % of spot are judged — the wings are always thin. */
    atmWindowPercent: 10,
    /** Open interest and volume that score a full 1.0 on their sub-score. */
    openInterestGood: 500,
    volumeGood: 100,
    /** Bid-ask spread as % of mid: at or below `good` scores 1.0, at `poor` scores 0. */
    spreadGoodPercent: 5,
    spreadPoorPercent: 25,
    /** Composite score bands for the badge. */
    goodFrom: 70,
    fairFrom: 45,
  },

  event: {
    /** Earnings this close force the IV_WARNING gate regardless of direction. */
    warningDays: 3,
    /** Earnings this close downgrade any PRIME signal to a WATCH. */
    blockPrimeDays: 7,
  },

  confidence: {
    /**
     * Confidence is a WEIGHTED GEOMETRIC MEAN, not an average.
     *
     * The average let full coverage and strong-but-opposed factors buy back a
     * collapsed agreement: 21% agreement still published 62% confidence, which is
     * the most misleading number the card could show. A product cannot be bought
     * back — a near-zero term drags the whole result toward zero however good the
     * others are — and agreement carries the largest exponent because agreement is
     * the term that was being hidden.
     *
     * The three exponents sum to 1, so the result stays in [0, 1].
     */
    exponents: {
      coverage: 0.2,
      agreement: 0.55,
      strength: 0.25,
    },
    /**
     * Floor applied to each term before the log, so one genuinely-zero term
     * produces a very low confidence rather than an undefined one.
     */
    termFloor: 0.01,
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

  /**
   * Timestamp hygiene. Every factor carries its own `asOf`; the signal publishes
   * ONE `asOf` — the oldest of them, because a signal is only as current as its
   * stalest input — and flags the spread when the sources disagree by more than
   * `staleMixHours`.
   */
  provenance: {
    staleMixHours: 6,
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

  /**
   * Every computed signal, stored. Storage only; no back-test reads any of it.
   *
   * The durable store is what makes the IV and Put/Call percentiles reachable at
   * all: both need sixty of a symbol's own readings, and an in-process buffer
   * resets on every deploy, so the window could never close. The buffer survives
   * as the fallback for when the database cannot answer.
   */
  history: {
    /** Ceiling on the in-process FALLBACK buffer. An unbounded one is a leak. */
    maximumRecords: 200,
    /**
     * How far back a percentile read reaches. Wider than the 60 readings the
     * percentiles need, because rows are written when somebody opens the card
     * and a symbol nobody looked at on Tuesday has no Tuesday.
     */
    readLookbackDays: 180,
    /**
     * Retention. A little over a year of trading days plus the slack to make
     * "the same week last year" reachable. Mirrored in the migration, which
     * takes it as an argument rather than hardcoding it.
     */
    retentionDays: 400,
  },
} as const;

export type OptionsSignalConfig = typeof OPTIONS_SIGNAL_CONFIG;
