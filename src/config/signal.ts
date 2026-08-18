/**
 * The single home for every Market Signal threshold and weight.
 *
 * Nothing in the engine may hardcode a number that belongs here: a reader who
 * wants to know why a signal says what it says has to be able to read one file,
 * and a calibration pass (P4) has to be able to move one file.
 */

export const MARKET_SIGNAL_SCORE_WEIGHTS = {
  emaTrend: 30,
  momentum: 25,
  trendStrength: 15,
  volume: 15,
  priceStructure: 15,
} as const;

export const MARKET_SIGNAL_THRESHOLDS = {
  minimumSignalCandles: 50,
  minimumAvailableWeight: 50,
  directional: {
    strongBullish: 60,
    bullish: 20,
    bearish: -20,
    strongBearish: -60,
  },
  ema: {
    shortSlopeLookback: 5,
    mediumSlopeLookback: 10,
    longSlopeLookback: 20,
    strongSlopeRatio: 0.01,
    sidewaysSlopeRatio: 0.003,
    sidewaysCompressionRatio: 0.03,
  },
  momentum: {
    rsiBullishExtreme: 75,
    rsiBearishExtreme: 25,
    rsiSidewaysMinimum: 45,
    rsiSidewaysMaximum: 55,
    macdAtrScale: 0.2,
    histogramFlatAtrRatio: 0.05,
  },
  trendStrength: {
    adxSidewaysMaximum: 20,
    adxTrendMinimum: 25,
    adxStrong: 40,
  },
  volume: {
    relativeVolumeBaseline: 1,
    relativeVolumeConfirmation: 1.2,
    relativeVolumeHigh: 1.5,
    directionLookback: 5,
    obvSlopeLookback: 10,
  },
  structure: {
    pivotWindow: 3,
    breakoutBufferRatio: 0.001,
    /*
     * How far back a confirmed pivot may sit and still describe today's
     * structure. Without this the engine searched five years of pivots for "the
     * nearest support below the previous close" and could pick a level from
     * nine months ago — then report that price had just broken it. 120 daily
     * bars is roughly six months: long enough that a quiet instrument still
     * finds levels, short enough that the level is one a reader would recognise
     * on the chart in front of them.
     */
    pivotLookbackBars: 120,
  },
  squeeze: {
    keltnerPeriod: 20,
    keltnerAtrPeriod: 14,
    keltnerAtrMultiplier: 1.5,
  },
  overextended: {
    ema20DeviationPct: 8,
    atrDistance: 3,
    evidenceRequired: 2,
  },
  divergence: {
    minimumPivotSeparation: 3,
    rsiMinimumDifference: 2,
    macdAtrMinimumDifference: 0.02,
  },
  sideways: {
    evidenceRequired: 4,
    minimumAvailableEvidence: 4,
  },
  confidence: {
    completenessWeight: 0.3,
    agreementWeight: 0.25,
    strengthWeight: 0.2,
    volumeWeight: 0.1,
    regimeClarityWeight: 0.15,
    conflictPenaltyWeight: 0.25,
    mediumMinimum: 60,
    highMinimum: 80,
  },
} as const;

/**
 * P1 consistency layer — read only when `SIGNAL_GATE` is on.
 *
 * Kept as its own block rather than folded into `MARKET_SIGNAL_THRESHOLDS` so
 * that the numbers the flags-OFF engine reads and the numbers the gate reads
 * can never be confused for each other while both are live.
 */
export const MARKET_SIGNAL_GATE = {
  /*
   * A directional label has to survive its own evidence. The engine used to
   * publish "BULLISH" off a +1 score, which is a rounding artefact of five
   * components arguing with each other, not a direction.
   */
  bands: {
    /** Below this the score is noise and the label is neutral, whatever its sign. */
    neutral: 15,
    /** Below this the direction is real but thin. */
    weak: 40,
    /** At or above this a STRONG_* label becomes eligible (it still has to be confirmed). */
    strong: 70,
  },
  /*
   * Volume that is below its own 20-day average cannot be evidence FOR a move.
   * The component could previously score +8/15 on a rising OBV while relative
   * volume sat at 0.84x — the day was quieter than usual and the card said
   * participation supported the move.
   */
  volume: {
    belowAverageThreshold: 1,
    belowAverageMaximumPoints: 3,
  },
  /*
   * How much of a component's range it has to be using before its sign counts
   * as an opinion. Without this, silver — four of five components positive, a
   * score of 36, and an EMA component at -0.11 of its range — was forced to
   * NEUTRAL by a reading barely distinguishable from zero. A conflict is
   * supposed to mean two parts of the evidence genuinely disagree, not that one
   * of them rounded the wrong side of nothing.
   */
  conflictMinimumMagnitude: 0.2,
  /*
   * A divergence is meaningful near the ends of the oscillator's range and close
   * to meaningless in the middle of it. At RSI 54.86 the engine was raising a
   * "bullish divergence" chip with the same visual weight it would carry at RSI
   * 22. Weight it by how far RSI actually is from the midpoint, and keep the
   * chip for cases that clear `minimumFlagWeight` — below that it stays a
   * written caution only, which is also what stops it appearing as support and
   * as a warning at the same time.
   */
  divergence: {
    minimumFlagWeight: 0.3,
    /** Floor on the written caution's impact, so a weak divergence is still said, quietly. */
    minimumImpactShare: 0.2,
  },
  /*
   * Confidence multiplies rather than adds.
   *
   * Under the additive form a 30%-weighted completeness term could pay for
   * everything else: IREN reported 64% confidence on 100% completeness while
   * regime clarity was 2% and a quarter of the evidence pointed the other way.
   * A product cannot be rescued that way — every term is a veto in proportion
   * to how bad it is.
   *
   * Each floor maps its input from [0,1] onto [floor,1], so no single term can
   * drive confidence to zero on its own, but a genuinely bad one does real
   * damage. They are the obvious calibration surface for P4.
   */
  /*
   * Measured over 108 real instruments at the close of P1.5:
   *
   *   base          median 0.778   (min 0.636)
   *   completeness  median 1.000   INERT — every instrument had all five
   *                                components and fresh provider data
   *   agreement     median 0.850   (min 0.575)  <- the heaviest live term
   *   regimeClarity median 0.800   (min 0.500, i.e. its floor)
   *   conflict      median 0.970   (min 0.743)  deliberately UNFLOORED
   *   earnings      median 1.000   INERT — the dev calendar has no entitlement
   *
   * So the product has four live terms today, not six. That is a known state,
   * not a defect: `completeness` wakes up in P5 when optional context sources
   * start being genuinely absent, and `earnings` wakes up wherever the calendar
   * is entitled. Re-run `npm run signal:sensitivity -- --confidence` at the end
   * of P5 and compare against those medians.
   *
   * `conflict` has no floor ON PURPOSE. It is the term that should be able to
   * take confidence all the way down, because evidence pointing two ways is the
   * one condition under which a number here is worthless. A test watches for it
   * dropping below 0.3 so that the day it starts happening is a thing we learn
   * rather than a thing a floor hides.
   */
  confidence: {
    evidenceFloor: 0.6,
    completenessFloor: 0.6,
    agreementFloor: 0.5,
    regimeClarityFloor: 0.5,
    /** Provider data that is stale, cached or unknown is not 100% complete. */
    degradedDataFactor: 0.7,
    /** Not a clamp — the level at which the conflict term becomes worth reporting. */
    conflictFactorWatchLevel: 0.3,
  },
  /*
   * Event risk. A technical read across an earnings print is a read across a
   * gap it cannot see, so proximity discounts confidence and, inside three
   * days, forbids a STRONG label outright. Days come from the existing earnings
   * calendar; when it has nothing to say the whole block is skipped silently and
   * confidence is untouched.
   */
  earnings: {
    imminentDays: 3,
    imminentFactor: 0.5,
    soonDays: 10,
    soonFactor: 0.8,
  },
} as const;

export const MARKET_SIGNAL_EXPECTED_FACTORS = {
  emaTrend: 4,
  momentum: 3,
  trendStrength: 1,
  volume: 2,
  priceStructure: 2,
} as const;

export const MARKET_SIGNAL_TOTAL_WEIGHT = Object.values(MARKET_SIGNAL_SCORE_WEIGHTS)
  .reduce((sum, weight) => sum + weight, 0);

/**
 * P2 trend zones — read only when `SIGNAL_ZONES` is on.
 *
 * The card used to publish a directional label and, a few centimetres away, a
 * support and a resistance that said price was sitting in the middle of its
 * range. A zone makes the second thing decide the first: a label is a statement
 * about where price is relative to structure, not about a score.
 */
export const MARKET_SIGNAL_ZONE = {
  /*
   * How far past a level price has to close before the level counts as broken.
   * A quarter of ATR is small enough that a real break clears it on the day and
   * wide enough that a wick and a fill do not.
   */
  triggerAtrMultiple: 0.25,
  /*
   * Leaving a zone is easier than entering it, on purpose.
   *
   * Entry needs a close beyond `level + 0.25 ATR`; exit only needs a close back
   * inside the level itself. Without the gap a price oscillating around one
   * number flips the label on alternate days, which is worse than useless — it
   * teaches a reader the label is noise. Both sides use the same asymmetry.
   */
  confirmation: {
    /** One close beyond the trigger is enough when the day carried real volume. */
    highVolumeRelative: 1.2,
    /** Otherwise the break has to hold for this many consecutive closes. */
    barsWithoutVolume: 2,
  },
  /*
   * When support and resistance sit closer together than a single ATR, the
   * "range" is narrower than one day's normal movement and a break of it means
   * nothing. Fall back to a band around EMA20 and say so in `mode`.
   */
  narrowRange: {
    minimumAtrWidth: 1,
    atrBandMultiplier: 1.5,
  },
  /*
   * A level nobody has traded against in months is a line on a chart, not a
   * boundary. `lastTestedBarsAgo` past this many bars raises `stale_zone`.
   */
  expiry: {
    maximumUntestedBars: 60,
    touchToleranceAtrMultiple: 0.25,
  },
  /*
   * The frame is anchored to SWING STRUCTURE, not to the levels nearest the
   * current price.
   *
   * `nearestSupport`/`nearestResistance` are by construction the confirmed
   * levels immediately below and above price, so a trigger derived from them
   * moves every time price moves and can never be crossed. That answers a
   * different question from the one the card exists to answer, which is "how
   * far does price have to go before this becomes an uptrend". A frame built
   * from the most recent confirmed swing high and low is fixed in the past, so
   * price can and does close through it.
   *
   * `lookbackBars` bounds how stale an anchoring pivot may be. Beyond it the
   * frame is treated as having no structure to stand on and falls back to the
   * ATR band.
   */
  anchor: {
    lookbackBars: 120,
  },
  /*
   * How far back the zone walk starts — the window over which the frame is
   * replayed forward so `zoneAgeBars` and the current zone are the product of
   * the same rules a reader would apply by hand.
   */
  walkbackBars: 120,
} as const;
