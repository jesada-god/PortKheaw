import type { EarningsTimeOfDay } from '@/src/lib/analytics/earnings/types';

/**
 * Truthful per-source data state. Every factor carries one, so the UI can never
 * present a cached or stale number as if it were current, and an absent input is
 * always `UNAVAILABLE` — never silently zero.
 */
export type OptionsSignalDataState = 'LIVE' | 'DELAYED' | 'STALE' | 'UNAVAILABLE';

export type OptionsSignalFactorId = 'macro' | 'trend' | 'momentum' | 'sentiment' | 'riskReward';

export interface OptionsSignalProvenance {
  provider: string | null;
  asOf: string | null;
}

export type OptionsSignalInputSlot<T> = OptionsSignalProvenance & (
  | { status: 'available'; state: Exclude<OptionsSignalDataState, 'UNAVAILABLE'>; value: T }
  | { status: 'unavailable'; state: 'UNAVAILABLE'; reason: string }
);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface MacroBenchmarkInput {
  symbol: string;
  close: number;
  ema20: number | null;
}

export interface MacroInput {
  benchmarks: MacroBenchmarkInput[];
}

export interface TrendInput {
  close: number;
  ema20: number | null;
  ema50: number | null;
}

/**
 * TTM squeeze state. `ON` means Bollinger Bands are inside Keltner Channels —
 * volatility is compressing and NO direction has been chosen. A release is
 * `FIRED_*` only when the direction is confirmed by the squeeze momentum
 * histogram at the release bar.
 */
export type SqueezeState = 'ON' | 'FIRED_BULLISH' | 'FIRED_BEARISH' | 'OFF';

export interface MomentumInput {
  squeeze: SqueezeState;
  /** TTM squeeze momentum histogram value at the latest finalized candle. */
  squeezeMomentum: number | null;
  /** ATR14 at the same candle; used only to normalize `squeezeMomentum`. */
  atr: number | null;
  /** Latest finalized volume / 20-day average. Activity, never direction. */
  relativeVolume: number | null;
}

/**
 * Options pricing richness.
 *
 * `iv-rank` is the spec's canonical basis and needs a real historical IV series.
 * `iv-percentile` is the same idea computed from THIS symbol's own recorded ATM
 * IV readings, which accumulate one per computed signal. `iv-vs-realized` is an
 * explicitly-labelled fallback computed from two real measurements — today's ATM
 * implied volatility from the live chain and the underlying's own realized
 * volatility over a window matched to the contract's DTE — and is always
 * disclosed as such, window included.
 */
/**
 * Every basis carries `dte`, and it is not decoration.
 *
 * An implied volatility is a statement about ONE expiration. 103% on a contract
 * with two days left and 68% on one with forty-four are not a high reading and a
 * lower one — they are two different measurements, the first of them holding an
 * earnings report the second amortises over six weeks. A number that arrives
 * without the horizon it was read at cannot be compared with anything, including
 * the realized volatility beside it and the 30-60 day contract the card's own
 * setup section recommends.
 */
export type IvPricingInput =
  | {
    basis: 'iv-rank';
    ivRank: number;
    impliedVolatility: number | null;
    observations: number;
    /** Calendar days to the expiration the IV was read from, when known. */
    dte: number | null;
  }
  | {
    basis: 'iv-percentile';
    /** Share of recorded readings at or below today's, as a 0-100 percentile. */
    ivPercentile: number;
    impliedVolatility: number;
    observations: number;
    /** Calendar days to the expiration the IV was read from, when known. */
    dte: number | null;
  }
  | {
    basis: 'iv-vs-realized';
    impliedVolatility: number;
    realizedVolatility: number;
    ratio: number;
    observations: number;
    /** Trading days of realized volatility the ratio was measured against. */
    realizedWindowDays: number;
    /** Calendar days to the expiration the IV was read from, when known. */
    dte: number | null;
  };

/**
 * Why an IV percentile could not be published yet. Distinguished from a plain
 * absence because "we need N more days" is a schedule, not a failure, and the
 * card must not say "unavailable" for something that fills itself in.
 */
export interface IvPercentilePending {
  observations: number;
  required: number;
  missingDays: number;
}

export interface SentimentInput {
  putCallRatio: number;
  basis: 'open-interest' | 'volume';
  putTotal: number;
  callTotal: number;
  expiration: string;
  /**
   * Same-chain Put/Call by traded VOLUME. Volume is today's activity where open
   * interest is an accumulated book, so when both exist the pair is far more
   * informative than either alone.
   */
  volumeRatio?: number | null;
  /**
   * Where today's ratio sits inside this symbol's own recent readings, 0-1.
   * `null` until enough of the symbol's own history has been recorded — a raw
   * ratio is not comparable across tickers and is never treated as if it were.
   */
  ownPercentile?: number | null;
  /** How many of the symbol's own readings the percentile was drawn from. */
  percentileObservations?: number;
}

/**
 * Confirmed daily levels around the last finalized close. Shipped separately
 * from {@link RiskRewardInput} so the browser can re-anchor the same levels to
 * the single accepted live price without recomputing any zone.
 */
export interface PriceLevelsInput {
  close: number;
  support: number | null;
  resistance: number | null;
  /** ATR14 at the same candle, so a distance can be quoted in volatility units. */
  atr?: number | null;
}

export interface RiskRewardInput {
  price: number;
  /** Nearest confirmed support at or below `price`. */
  support: number | null;
  /** Nearest confirmed resistance at or above `price`. */
  resistance: number | null;
  /** ATR14, for expressing each distance in units of daily range. */
  atr?: number | null;
  /** ATM straddle expected move to expiration, in price units. */
  expectedMove?: number | null;
  /**
   * Days to expiration of the straddle `expectedMove` was read from.
   *
   * Shown wherever the expected move is, because an expected move without its
   * horizon is a distance without a deadline: 6 dollars over four days and 6
   * dollars over sixty are not the same statement about the same chart.
   */
  expectedMoveDte?: number | null;
}

/**
 * Chain tradeability. Never scored into the direction — a liquid chain does not
 * make a stock go up — but a signal on a chain nobody can get out of is a signal
 * a beginner should not act on, and the card already tells them to check.
 */
export interface LiquidityInput {
  /** Median open interest across the near-ATM strikes examined. */
  medianOpenInterest: number | null;
  /** Median traded volume across the same strikes. */
  medianVolume: number | null;
  /** Median bid-ask spread as a percentage of the midpoint. */
  medianSpreadPercent: number | null;
  /** How many near-ATM contracts the medians were taken over. */
  contractsExamined: number;
  expiration: string;
  /**
   * Whether the regular session was OPEN at the moment the chain was captured.
   *
   * A bid-ask spread quoted while the book is closed is not a measurement of
   * what it costs to trade — market makers widen or pull quotes entirely
   * overnight, and a chain that is perfectly liquid at 10:00 can show a 40%
   * spread at 02:00. Grading that as "thin" tells a reader something false about
   * the instrument rather than something true about the hour, so the grade is
   * withheld instead. `null` when the capture time could not be classified.
   */
  marketOpenAtCapture?: boolean | null;
}

/**
 * `unknown` is not "no data" — the medians are still there and still shown. It
 * is the honest answer to "can I get in and out of this", asked while the book
 * is shut.
 */
export type LiquidityGrade = 'good' | 'fair' | 'thin' | 'unknown';

export interface EventRiskInput {
  reportDate: string;
  daysToEarnings: number;
  timeOfDay: EarningsTimeOfDay;
}

export interface OptionsSignalInput {
  symbol: string;
  timeframe: '1D';
  calculatedAt: string;
  /** Date of the newest FINALIZED candle every technical factor was derived from. */
  latestCandleAt: string | null;
  finalizedCandles: number;
  macro: OptionsSignalInputSlot<MacroInput>;
  trend: OptionsSignalInputSlot<TrendInput>;
  momentum: OptionsSignalInputSlot<MomentumInput>;
  pricing: OptionsSignalInputSlot<IvPricingInput>;
  sentiment: OptionsSignalInputSlot<SentimentInput>;
  riskReward: OptionsSignalInputSlot<RiskRewardInput>;
  event: OptionsSignalInputSlot<EventRiskInput>;
  /** Optional: absent on any path that has no options chain to judge. */
  liquidity?: OptionsSignalInputSlot<LiquidityInput>;
  /** Optional: how far today's IV percentile still is from being publishable. */
  ivPercentilePending?: IvPercentilePending | null;
  /**
   * The reading history could not be reached at all.
   *
   * Kept rigidly separate from `ivPercentilePending`, which says "this fills
   * itself in, come back in N days". A store that cannot be read is not
   * accumulating anything, and telling a reader to wait 60 days for a countdown
   * that will never move is a worse lie than saying nothing.
   */
  historyDegraded?: boolean;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type OptionsSignalType =
  | 'PRIME_CALL'
  | 'CALL_WATCH'
  | 'SIDEWAYS'
  | 'PUT_WATCH'
  | 'PRIME_PUT'
  | 'IV_WARNING';

export type UnderlyingBias = 'bullish' | 'bearish' | 'neutral';

export type IvLevel = 'low' | 'normal' | 'high' | 'extreme';

export interface OptionsSignalFactorScore {
  id: OptionsSignalFactorId;
  points: number | null;
  maxPoints: number;
  /** Signed contribution in [-1, 1] before the weight is applied. */
  normalized: number | null;
  state: OptionsSignalDataState;
  available: boolean;
  /** True when the factor scored but one of its own inputs was missing. */
  partial: boolean;
  detail: string;
  reason: string | null;
  provider: string | null;
  asOf: string | null;
}

export interface OptionsSignalPenalty {
  id: string;
  amount: number;
  detail: string;
}

export interface OptionsSignalReason {
  id: string;
  polarity: 'positive' | 'negative' | 'caution' | 'information';
  text: string;
}

export type SuggestedOptionsSetup =
  | {
    status: 'suggested';
    direction: 'call' | 'put';
    dteMin: number;
    dteMax: number;
    deltaMin: number;
    deltaMax: number;
    rationale: string;
    warnings: string[];
  }
  | {
    status: 'not-recommended';
    reason: string;
    warnings: string[];
  };

/**
 * The ONE published provenance of a whole signal.
 *
 * Each factor keeps its own source and timestamp for the audit trail; this is
 * the number a reader is entitled to treat as "how current is this card", and it
 * is the OLDEST of them, because a signal cannot be fresher than its stalest
 * input. `staleMix` says the sources disagree enough that the card should say so.
 */
export interface OptionsSignalProvenanceSummary {
  /** Oldest `asOf` across every available source. Null when none carried one. */
  asOf: string | null;
  /** Newest `asOf` across the same set. */
  newestAsOf: string | null;
  /** Hours between the two, or null when fewer than two timestamps exist. */
  spreadHours: number | null;
  staleMix: boolean;
  sources: Array<{ id: string; provider: string | null; asOf: string | null }>;
}

export interface OptionsSignalLiquidityDiagnostics {
  grade: LiquidityGrade | null;
  score: number | null;
  medianOpenInterest: number | null;
  medianVolume: number | null;
  medianSpreadPercent: number | null;
  contractsExamined: number | null;
  expiration: string | null;
  /** False when the spread below is an after-hours quote rather than a cost. */
  marketOpenAtCapture: boolean | null;
  /**
   * What the open-interest and volume evidence alone says, with the unreliable
   * spread excluded. Present when the market was shut, so the reader keeps the
   * measurement even though the badge stops making a claim.
   */
  offHoursAssessment: { grade: Exclude<LiquidityGrade, 'unknown'>; score: number } | null;
  state: OptionsSignalDataState;
  reason: string | null;
  detail: string;
}

export interface OptionsSignalDiagnostics {
  factors: Record<OptionsSignalFactorId, OptionsSignalFactorScore>;
  /**
   * ONE scale, three numbers, and nothing else.
   *
   * There used to be two normalizations in this object: a bipolar
   * `normalizedScore` in [-100, 100] and a 0-100 `score`. They were the same
   * quantity on different rulers, which meant a reader who did the printed
   * arithmetic got a number that did not match a number printed beside it. The
   * bipolar figure is gone from everything published; it survives only as the
   * scale the direction/quality THRESHOLDS are written on, inside the engine.
   *
   * `rawDirectionPoints` is the signed sum, `availableWeight` is what it could
   * have been (the weight of the factors that had data, never the full model),
   * and `directionScore0to100` is those two put on the ruler every surface uses.
   */
  rawDirectionPoints: number;
  /**
   * The trend veto: how far the heaviest factor disagreed with the direction the
   * others summed to, and what that did to the score.
   *
   * `pointsBeforeVeto × multiplier = rawDirectionPoints`. `opposition` is 0 when
   * the trend agreed, was flat, or was not measured; `applied` distinguishes
   * "checked, and the trend agreed" from "not checked".
   */
  trendVeto: {
    applied: boolean;
    opposition: number;
    multiplier: number;
    pointsBeforeVeto: number;
  };
  availableWeight: number;
  totalWeight: number;
  /** `(rawDirectionPoints + availableWeight) / (2 * availableWeight) * 100`. */
  directionScore0to100: number;
  /** That conversion written out, so the card and the modal cannot drift apart. */
  scoreFormula: string;
  coverage: number;
  agreement: number;
  evidenceStrength: number;
  confidenceBase: number;
  /**
   * The confidence arithmetic written out, exponents and all.
   *
   * Produced by the same function that produces `confidenceBase`, from the same
   * `confidence.exponents` constants, for the reason `scoreFormula` exists: the
   * modal used to describe this as "การคูณกัน ของสามค่า", and a reader who
   * multiplied the three printed terms got 2% beside a published 20%. It is a
   * weighted GEOMETRIC mean and always was — only the sentence was wrong.
   */
  confidenceFormula: string;
  penalties: OptionsSignalPenalty[];
  penaltyTotal: number;
  dataSufficiency: {
    passed: boolean;
    missing: OptionsSignalFactorId[];
    primeEligible: boolean;
    primeBlockers: string[];
  };
  riskReward: {
    price: number | null;
    support: number | null;
    resistance: number | null;
    upsidePercent: number | null;
    downsidePercent: number | null;
    callRewardRisk: number | null;
    putRewardRisk: number | null;
    /** Which side's R:R the factor was scored on, or null when nothing led. */
    scoredSide: 'call' | 'put' | null;
    /** 0-1 quality of the BEST available side, independent of any direction. */
    setupQuality: number | null;
    /** Distances in units of ATR14, which a percentage alone cannot convey. */
    upsideAtr: number | null;
    downsideAtr: number | null;
    /** Distances as a share of the ATM straddle's expected move to expiration. */
    upsideExpectedMoves: number | null;
    downsideExpectedMoves: number | null;
    expectedMove: number | null;
    /** Days to expiration of the straddle the expected move came from. */
    expectedMoveDte: number | null;
    /**
     * Set when a level sits further away than this contract's own pricing says
     * it can reach before expiry — the case where a flattering Risk:Reward is
     * measured against a target the instrument will not live to see.
     */
    expectedMoveHorizonWarning: string | null;
    /**
     * The fraction of the scored side's geometry that survived the reachability
     * scaling, in (0, 1]. 1 when the target sits inside the expected move, or
     * when no expected move was available to judge it against.
     */
    reachability: number;
    state: OptionsSignalDataState;
  };
  iv: {
    level: IvLevel | null;
    basis: IvPricingInput['basis'] | null;
    ivRank: number | null;
    ivPercentile: number | null;
    /** Set when a percentile is still accumulating; the card shows the countdown. */
    percentilePending: IvPercentilePending | null;
    /**
     * True when the percentile is missing because the STORE is unreachable, not
     * because the series is short. The card must not show a countdown for this.
     */
    percentileStoreUnavailable: boolean;
    impliedVolatility: number | null;
    realizedVolatility: number | null;
    /** Which realized-volatility window the ratio used. */
    realizedWindowDays: number | null;
    dte: number | null;
    ratio: number | null;
    observations: number | null;
    state: OptionsSignalDataState;
    reason: string | null;
    /** Provider that supplied the implied volatility. */
    source: string | null;
    /** When that measurement was taken — the disclosure that makes STALE meaningful. */
    fetchedAt: string | null;
  };
  liquidity: OptionsSignalLiquidityDiagnostics;
  event: {
    reportDate: string | null;
    daysToEarnings: number | null;
    timeOfDay: EarningsTimeOfDay | null;
    state: OptionsSignalDataState;
    reason: string | null;
    /** Earnings-calendar provider that answered. */
    source: string | null;
    fetchedAt: string | null;
  };
  squeeze: {
    state: SqueezeState | null;
    momentum: number | null;
    normalizedMomentum: number | null;
    /** True when |momentum ÷ ATR| exceeded the saturation and was clamped to ±1. */
    normalizedMomentumCapped: boolean;
    relativeVolume: number | null;
    confirmation: number | null;
    /**
     * Every term between the raw indicator and the published momentum points,
     * so the factor's number can be re-derived rather than taken on trust.
     *
     * `rawAtr` clamped to ±`saturation` gives `clamped`; the squeeze state turns
     * that into `afterSqueeze`; `× multiplier` gives the normalized value the
     * weight is applied to. The clamp is the term worth watching — it fires on
     * most symbols on most days, which makes the ceiling, not the measurement,
     * the usual source of a large momentum score.
     */
    breakdown: {
      rawAtr: number | null;
      saturation: number;
      clamped: number | null;
      afterSqueeze: number | null;
      multiplier: number;
    };
  };
  macro: {
    benchmarks: Array<{ symbol: string; close: number; ema20: number | null; aboveEma20: boolean | null }>;
  };
  provenance: OptionsSignalProvenanceSummary;
  gates: {
    ivWarning: boolean;
    ivWarningReasons: string[];
    downgrades: string[];
  };
}

interface OptionsSignalBase {
  symbol: string;
  timeframe: '1D';
  calculatedAt: string;
  latestCandleAt: string | null;
  finalizedCandles: number;
  /** The oldest source timestamp behind this signal. See {@link OptionsSignalProvenanceSummary}. */
  asOf: string | null;
  /** True when the sources behind this signal span more than the configured window. */
  staleMix: boolean;
  /** Config revision the numbers were produced under. */
  configVersion: string;
  /** True when the reading history could not be reached; see `historyDegraded`. */
  historyDegraded: boolean;
  reasoning: OptionsSignalReason[];
  suggestedOptionsSetup: SuggestedOptionsSetup;
  diagnostics: OptionsSignalDiagnostics;
}

export type OptionsSignalResult = OptionsSignalBase & (
  | {
    status: 'available';
    signalType: OptionsSignalType;
    /** Identical to `diagnostics.directionScore0to100`, by construction. */
    directionScore0to100: number;
    confidenceScore: number;
    underlyingBias: UnderlyingBias;
    liquidityGrade: LiquidityGrade | null;
  }
  | {
    status: 'insufficient-data';
    signalType: null;
    directionScore0to100: null;
    confidenceScore: 0;
    underlyingBias: null;
    liquidityGrade: null;
    reason: string;
  }
);
