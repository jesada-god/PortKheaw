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
 *
 * The suffix letter exists because two changes can land on one day and a date
 * alone would then describe two different models. `2026.08.19b` is the momentum
 * saturation widening from 1.0 to 3.5 ATR; `2026.08.19` is everything before it;
 * `2026.08.19c` moved the implied volatility onto the horizon chain.
 *
 * `2026.08.23` is the internal-contradiction pass. No weight and no threshold
 * below moved; what changed is WHICH factors reach the fraction at all. A factor
 * holding raw data it has no basis to judge (`fallback-neutral`) is now struck
 * from the numerator and the divisor, where it used to vote out of an absolute
 * band and keep its full weight. Options Sentiment without its own percentile
 * history is the case that reaches this on most symbols, so most divisors move
 * from 90 to 80 and every quality term downstream of the divisor moves with them.
 */
export const OPTIONS_SIGNAL_CONFIG_VERSION = '2026.08.23';

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

  /**
   * What happens when the heaviest factor points the other way.
   *
   * Trend carries 25 of the 90 available points, more than anything else, and
   * it was still possible for a chart whose EMAs are stacked DOWN to publish
   * "CALL WATCH" — because Macro (+15, identical on every symbol that day) and a
   * saturated Momentum (+19) simply outvoted it. The existing
   * `macro-trend-conflict` penalty took 10 points off CONFIDENCE for exactly
   * this shape, which is the right instinct aimed at the wrong number: nobody
   * reads a confidence figure to decide what the card said. The headline is what
   * they read.
   *
   * So the disagreement is applied where the headline comes from. This is NOT a
   * second penalty stacked on the first — the confidence penalty is unchanged
   * and untouched — it is the same disagreement finally reaching the number it
   * was always about.
   *
   * PROPORTIONAL, never a switch: the multiplier is `1 - strength × |trend|`, so
   * a trend that mildly disagrees (one EMA vote out of three) shaves a third off
   * the score and a trend that flatly contradicts the published bias cancels it.
   * The operation is odd — negating every input negates the result and leaves
   * the multiplier alone — so the put and call mirrors stay exact.
   *
   * It can only move a score TOWARD neutral. It can never flip a bias, and it
   * never turns a CALL into a PUT.
   *
   * Measured over the 30 regression tickers at `strength: 1`: 2 labels changed
   * (AVGO and AFRM, CALL_WATCH -> SIDEWAYS), 0 changes to PRIME membership.
   */
  trendVeto: {
    strength: 1,
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
     *
     * It used to be 1.0, which is the same defect the Risk/Reward tilt band had
     * before it was widened to `tiltSaturationRatio: 4.5`: a ceiling set inside
     * the ordinary range of the thing being measured, so the number published
     * was the ceiling and not the measurement. Measured across the 30 regression
     * tickers on 2026-08-19, |momentum ÷ ATR14| ran:
     *
     *     min 0.22 · p10 0.60 · p25 0.93 · MEDIAN 1.78 · p75 2.69 · p90 3.62 · max 5.39
     *
     * The median symbol was 78% ABOVE the old ceiling. 22 of 30 (73%) saturated,
     * so for three symbols in four the factor could not tell a 1.1 from a 5.4 —
     * and the card printed +19 of a possible 25 for both.
     *
     * 3.5 is the measured p90, rounded down to a value that can be written in a
     * sentence. Nine symbols in ten are now MEASURED and the tenth is genuinely
     * extreme, which is what a saturation point is supposed to mean. Candidates
     * were compared over the same 30 symbols by re-running the shipped engine:
     *
     *     saturation   capped   labels changed   PRIME
     *     1.0 (old)    73%      —                7
     *     2.5          27%      2 (7%)           7
     *     3.5 (new)    13%      2 (7%)           7
     *     4.5           7%      2 (7%)           7
     *     5.0           3%      3 (10%)          6
     *
     * 4.5 buys six more percentage points of headroom for no further resolution
     * — only ROKU at 3.54 sits between them — and pushes full weight further out
     * of reach for no measured benefit. 5.0 starts costing PRIME membership.
     *
     * Widening cuts BOTH ways on purpose, exactly as it did for Risk/Reward: a
     * full ±25 now needs 3.5 ATR of momentum rather than 1.0, so the factor gives
     * up some of its ability to shout in exchange for being able to speak. It
     * stays an ODD function of the momentum — the clamp is symmetric about zero —
     * so the put and call mirrors remain exact.
     */
    momentumAtrSaturation: 3.5,
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
    /**
     * Reward:risk at which a side counts as a fully WORKABLE setup.
     *
     * Deliberately separate from `tiltSaturationRatio` below. "This side is a
     * workable trade" and "this geometry is maximum directional evidence" are
     * two different statements, and collapsing them is what made the factor a
     * three-position switch.
     */
    saturationRatio: 2,
    /**
     * Reward:risk at which the DIRECTIONAL tilt saturates, on the same log base
     * both ways: `log(rr) / log(4.5)` reaches +1 at 4.5:1 and -1 at 1:4.5.
     *
     * It used to saturate at 2 and 0.5, which is far too shallow to describe
     * real charts. Measured across 30 symbols, the call reward:risk ranged from
     * 0.06 to 35 with a median of 2.31 — so 22 of the 27 that produced a ratio
     * were already pinned at one end or the other, and the factor could not tell
     * a 0.49 apart from a 0.24, or a 2.1 apart from a 12. A band that saturates
     * for four fifths of the market is not measuring anything.
     *
     * Widening cuts BOTH ways on purpose: full +15 now needs 4.5:1 in favour,
     * not 2:1. The factor gives up some of its ability to shout, which is the
     * price of it being able to speak at all. Everything between the ends is
     * where the resolution now lives.
     */
    tiltSaturationRatio: 4.5,
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
    /**
     * The first config version whose recorded ATM IV was read at the HORIZON
     * expiration rather than the front one, and therefore the oldest reading an
     * IV percentile may compare today's against.
     *
     * `readOwnHistory` keeps rows across config versions on purpose: IV and
     * Put/Call are provider measurements, not engine output, and no threshold
     * change moves them. This one did move them. A percentile mixing 2-day
     * readings with 44-day readings would rank a stock against a series of a
     * different instrument, and would do it silently, because the two are the
     * same field under the same name.
     *
     * A CUTOFF rather than an equality test: readings taken from this version on
     * are all on the same basis, so a later unrelated bump must not throw the
     * series away and restart a 60-day countdown for nothing. Version strings are
     * date-first and compare lexicographically for exactly this.
     */
    horizonBasisFromConfigVersion: '2026.08.19c',
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

  expectedMove: {
    /**
     * How far a level may sit, measured in expected moves, before the modal says
     * the contract probably expires before price gets there.
     *
     * The straddle prices roughly a one-standard-deviation move to ITS OWN
     * expiration. A level two of those away is not "a target with a worse
     * reward" — it is a target this contract is the wrong instrument for, and a
     * Risk:Reward ratio quoted against it reads far better than it deserves.
     *
     * Beyond this the factor is no longer merely WARNED about, it is scaled: the
     * scored side's contribution is multiplied by
     * `reachableWithin / distanceInExpectedMoves`, so a target at 3 expected
     * moves carries half the weight and one at 15 carries a tenth. The card used
     * to print +5 for a geometry it was warning about in the same paragraph.
     */
    reachableWithin: 1.5,
    /**
     * The horizon the expected move is READ AT, in days to expiration.
     *
     * It used to be read off the nearest expiration, which is whatever is on the
     * board today — 0 or 2 days, most days. The card's own SETUP section
     * recommends 30-60 DTE in the same breath, so the geometry was being judged
     * against a straddle nobody was being told to buy, over a horizon two orders
     * of magnitude shorter than the one recommended. Measured across the 30
     * regression tickers, "this level is further than the option can reach"
     * fired on 24 of 30 on the nearest chain and on 3 of 30 at 30 days: the
     * warning was almost entirely an artifact of the wrong horizon, and a
     * warning that fires on four fifths of the market warns of nothing.
     *
     * 45 is the one DTE inside BOTH `setup` bands below, so the expected move is
     * quoted over a horizon the card actually recommends whichever band applies.
     * The nearest listed expiration to this is used; the DTE that was really
     * read is published beside the number, never assumed.
     */
    horizonDays: 45,
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
    /**
     * Reserved symbol for the access canary.
     *
     * RLS is on with no policy, and a SELECT under a non-service-role key does
     * not error — PostgREST returns an empty set. An empty set is also the
     * correct answer for a symbol nobody has opened, so the two are
     * indistinguishable from a read alone and a misconfigured key would leave
     * the percentile "accumulating" forever, silently. The canary writes one row
     * under this symbol and reads it straight back: if the row it just wrote is
     * not there, the store is not reachable, whatever the reads say.
     *
     * Matches the table's symbol check, and the retention sweep clears old ones.
     */
    canarySymbol: 'ZZ-CANARY',
    /**
     * How long a canary row is kept, which is NOT `retentionDays`.
     *
     * The canary writes one row per day per deploy and nothing ever reads a row
     * older than the one it just wrote — the probe is "is the row I just wrote
     * there", and yesterday's answer is not evidence about today. Under the
     * 400-day retention those rows simply accumulated: a year of daily writes
     * under a reserved symbol that no percentile, no card and no query reads.
     *
     * Seven days rather than one, so a week of them survives as a record of when
     * the store was last reachable — which is the only question these rows can
     * answer after the fact — and the sweep counts and deletes them separately
     * so a canary clear-out can never be mistaken for real history being lost.
     */
    canaryRetentionDays: 7,
  },
} as const;

export type OptionsSignalConfig = typeof OPTIONS_SIGNAL_CONFIG;
