import type { DataFreshness, HistoricalPrice } from '@/src/lib/market-data/types';

export type MarketSignalState =
  | 'STRONG_BULLISH'
  | 'BULLISH'
  | 'SIDEWAYS'
  | 'SQUEEZE'
  | 'OVEREXTENDED'
  | 'BEARISH'
  | 'STRONG_BEARISH';

export type MarketSignalBias = 'bullish' | 'bearish' | 'neutral';
export type MarketSignalConfidenceLabel = 'Low' | 'Medium' | 'High' | 'Insufficient';
export type MarketSignalComponentId = 'emaTrend' | 'momentum' | 'trendStrength' | 'volume' | 'priceStructure';
export type MarketSignalFlag =
  | 'squeeze'
  | 'overextended'
  | 'high_volume'
  | 'bullish_divergence'
  | 'bearish_divergence'
  | 'strong_momentum'
  | 'weak_confirmation'
  // P1 (`SIGNAL_GATE`). Never emitted while the flag is off.
  | 'conflicting_evidence'
  | 'low_volume_confirmation'
  | 'stale_or_partial_data'
  | 'earnings_imminent'
  | 'earnings_soon'
  | 'pre_earnings_breakout'
  // P2 (`SIGNAL_ZONES`). Never emitted while the flag is off.
  | 'pending_breakout'
  | 'pending_breakdown'
  | 'stale_zone'
  | 'narrow_range'
  // P3 (`SIGNAL_ACTIONABLE`). Never emitted while the flag is off.
  | 'unfavorable_risk_reward'
  | 'risk_leg_inside_noise'
  /*
   * P6 (`SIGNAL_HISTORY`). Added by the SERVICE, never by the engine.
   *
   * `calculateMarketSignal` is a pure function of the candles in front of it and
   * has no idea what it said yesterday, so this is the one member of this union
   * the engine cannot produce. It is listed here anyway because the union
   * describes what a PAYLOAD may carry, and a reader of the type should not have
   * to know which layer appended which member.
   */
  | 'recent_flip';

/** Which rollout phases the caller has turned on for this calculation. */
export interface MarketSignalFeatures {
  gate: boolean;
  zones: boolean;
  /** P3 reads the zone frame, so it does nothing unless `zones` is on too. */
  actionable: boolean;
}

/**
 * Where the next earnings report sits relative to the signal.
 *
 * `daysToNextReport` is whole calendar days, `null` when the calendar could not
 * answer — which is a normal outcome, not an error, and makes the engine skip
 * every earnings rule rather than assume the print is far away.
 */
export interface MarketSignalEarningsContext {
  daysToNextReport: number | null;
}

export type MarketSignalBand = 'neutral' | 'weak' | 'moderate' | 'strong';

/** Which side of its structure price is closing on. */
export type MarketSignalZoneName = 'uptrend' | 'sideways' | 'downtrend';

/**
 * Where the frame's boundaries came from.
 *
 * `structural` is the normal case: the most recent confirmed swing high and
 * swing low, anchored in the past and therefore crossable. `atr_band` is the
 * fallback when no usable pivot pair exists inside the lookback, or when the
 * pair is closer together than one ATR — a "range" narrower than a normal day's
 * movement, which cannot be broken meaningfully. In that mode every number is a
 * volatility envelope rather than a level anybody has traded against.
 */
export type MarketSignalZoneMode = 'structural' | 'atr_band';

/**
 * How close price is to the nearest edge of its frame.
 *
 * Descriptive only: it changes no label and no rule. It exists because
 * "sideways" was doing the work of two very different sentences — QQQ 0.05 ATR
 * below its trigger and CL-F 4.9 ATR from the nearest one both read as the same
 * word, which told a reader nothing about which one was about to matter.
 *
 * What it does NOT mean, measured in P4a: it is not a reliability ranking.
 * Directional accuracy is indistinguishable across all three bands at every
 * horizon. What it predicts is how long the LABEL lasts, and only over about
 * five bars — 64.8% of `near_trigger` zones are something else five bars later
 * against 51.4% of `deep_range` ones. By twenty bars the gap is 1.5pp and
 * `mid_range` is the least durable of the three.
 */
export type MarketSignalZoneProximity = 'near_trigger' | 'mid_range' | 'deep_range';

/**
 * The frame the CURRENT zone was entered by breaking.
 *
 * Captured at the moment of the break rather than reconstructed afterwards,
 * because the frame re-anchors on that same bar: by the time the walk finishes,
 * the boundaries that were crossed no longer exist anywhere in the result. P3
 * measures its target from here, so this is the difference between a target with
 * a provenance and a number.
 *
 * `height` is `null` when the broken frame was an ATR band. That is not missing
 * data — it is the rule that a band's height is a volatility multiple, so
 * projecting it would produce exactly the invented-looking-calculated number the
 * actionable layer refuses to publish.
 */
export interface MarketSignalZoneEntry {
  /** The level price closed through: the broken frame's edge, before the buffer. */
  level: number;
  /** The broken frame's height, or `null` when it was an ATR band. */
  height: number | null;
  mode: MarketSignalZoneMode;
  /** Finalized bars since the break. */
  barsAgo: number;
}

export interface MarketSignalZones {
  mode: MarketSignalZoneMode;
  /** The zone the latest FINALIZED close sits in, after confirmation and hysteresis. */
  zone: MarketSignalZoneName;
  /** The frame's anchors. Fixed in the past, so price can close through them. */
  support: number;
  resistance: number;
  /** Close above this enters the upper zone; falling back below `resistance` leaves it. */
  upperTrigger: number;
  /** Close below this enters the lower zone; recovering above `support` leaves it. */
  lowerTrigger: number;
  /** Where the close sits across the frame. Deliberately unclamped: past 100 means broken out. */
  positionPct: number;
  /** Distance from the close to each trigger, in price and in ATR. Negative once crossed. */
  upperDistance: number;
  upperDistanceAtr: number;
  lowerDistance: number;
  lowerDistanceAtr: number;
  /** Bars since the frame was last anchored or re-anchored. */
  frameAgeBars: number;
  /** Descriptive split of the zone; changes no label. */
  proximity: MarketSignalZoneProximity;
  /** ATR to the nearest trigger. Negative once price is through one. */
  nearestTriggerAtr: number;
  /** How many finalized bars price has held this zone under today's boundaries. */
  zoneAgeBars: number;
  /** Bars since a bar's range last reached either level; `null` if never within the walk. */
  lastTestedBarsAgo: number | null;
  /**
   * How many closes in the replayed window landed beyond the then-current
   * trigger. Reported because it is the falsification check for the whole
   * design: a frame that price can never cross would read 0 here on every
   * instrument, which is exactly what the price-relative levels did.
   */
  triggerCrossings: number;
  /** A close is beyond a trigger but has not met the confirmation rule yet. */
  pendingBreakout: boolean;
  pendingBreakdown: boolean;
  /** What was broken to enter the current zone; `null` in a sideways zone. */
  entry: MarketSignalZoneEntry | null;
  /** The close the whole zone is measured from, and the bar it belongs to. */
  referenceClose: number;
  referenceDate: string;
}
export type MarketSignalConflict = 'ema_vs_momentum' | 'structure_vs_momentum';
export type MarketSignalEarningsProximity = 'imminent' | 'soon' | 'clear' | 'unknown';

/**
 * What the P1 consistency layer decided, and why.
 *
 * Present only when `SIGNAL_GATE` is on; absent — not null — otherwise, so a
 * flags-OFF payload is byte-identical to the one that shipped before P1.
 */
export interface MarketSignalGate {
  band: MarketSignalBand;
  /** Components whose signs contradict each other badly enough to void a direction. */
  conflicts: MarketSignalConflict[];
  /** True when a directional label was withheld despite a non-zero score. */
  forcedNeutral: boolean;
  earningsProximity: MarketSignalEarningsProximity;
  daysToEarnings: number | null;
  /** Every multiplier applied to confidence, in the order the product takes them. */
  confidenceFactors: {
    base: number;
    completeness: number;
    agreement: number;
    regimeClarity: number;
    conflict: number;
    earnings: number;
  };
}

/**
 * Which edge of the zone the invalidation is.
 *
 * `zone_floor` is the level an uptrend stands on; `zone_ceiling` is the one a
 * downtrend hangs from. They are the frame edges the engine's OWN hysteresis
 * reads to decide the zone has ended — see `calculateActionable` for why that,
 * and not the far side of the frame, is what "invalidated" means here.
 */
export type MarketSignalInvalidationBasis = 'zone_floor' | 'zone_ceiling';

/** The only target derivation the engine will publish. See `calculateActionable`. */
export type MarketSignalTargetBasis = 'measured_move';

/**
 * Why a number is missing, in machine-readable form.
 *
 * Every one of these is a reason the actionable layer declined to publish a
 * figure. They exist as codes rather than as prose so a test can assert WHICH
 * refusal happened, and so the UI can hide the right row instead of printing an
 * em dash where a price should be.
 */
export type MarketSignalActionableNote =
  /** A sideways zone claims no direction, so nothing about it can be invalidated. */
  | 'no_direction_to_invalidate'
  /** The frame is an ATR envelope, not levels the market traded against. */
  | 'atr_band_fallback'
  /** The zone's own edge is on the wrong side of the close; it cannot be a stop. */
  | 'invalidation_behind_close'
  /** Nothing with a measurable height was broken to enter this zone. */
  | 'no_measurable_frame'
  /** The projection has already been reached, so it is no longer ahead of price. */
  | 'measured_move_reached'
  /** The close sits so near its own invalidation that the ratio is dominated by noise. */
  | 'risk_leg_inside_noise';

/**
 * The two numbers a reader would need before the card means anything.
 *
 * Present only when `SIGNAL_ACTIONABLE` is on AND a zone exists; absent — not
 * null — otherwise. Inside it, `null` is a first-class answer and appears
 * wherever structure does not support a figure, which on the current corpus is
 * most of the time. That is the design: the alternative is manufacturing a level
 * from an ATR multiple, which reads to a user as a derived number and is not one.
 */
export interface MarketSignalActionable {
  /** Price at which the published zone stops being the zone. */
  invalidation: number | null;
  /** Absolute distance from the reference close, in ATR and in percent. */
  invalidationAtr: number | null;
  invalidationPct: number | null;
  invalidationBasis: MarketSignalInvalidationBasis | null;
  target: number | null;
  targetAtr: number | null;
  targetBasis: MarketSignalTargetBasis | null;
  /**
   * True whenever a target is published, and it is always true today.
   *
   * A measured move is a charting CONVENTION — the claim that a broken range
   * tends to travel its own height again. It is not a measured property of these
   * instruments, and nothing in this repo has tested it yet; P4a's harness is
   * what turns it into a falsifiable claim. Until then the UI has to say so, and
   * this is the field it reads to know it must.
   */
  targetIsConvention: boolean;
  riskReward: number | null;
  notes: MarketSignalActionableNote[];
}

export interface MarketSignalCandle extends HistoricalPrice {
  finalized: boolean;
}

export interface MarketSignalScoreComponent {
  points: number | null;
  maxPoints: 30 | 25 | 15;
  normalizedScore: number | null;
  coverage: number;
  factorsUsed: number;
  available: boolean;
}

export type MarketSignalScoreBreakdown = Record<MarketSignalComponentId, MarketSignalScoreComponent>;

export interface MarketSignalReason {
  id: string;
  polarity: 'positive' | 'negative' | 'caution' | 'information';
  text: string;
  impact: number;
}

export interface MarketSignalMetrics {
  close: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  ema20SlopePct: number | null;
  ema50SlopePct: number | null;
  ema200SlopePct: number | null;
  emaCompressionRatio: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  /**
   * Whether the latest histogram bar is longer than the one before it, in the
   * engine's own reading of "longer".
   *
   * `macdHistogram` is a single bar, and the reason row the engine writes about
   * it says more than the bar does: it says whether the bar GREW or shrank,
   * which it reads off the previous bar. That comparison had no field, so the
   * card could not restate the row without dropping half of it. This is the
   * comparison, published.
   *
   * `null` is a real answer, not missing data: no previous bar, a histogram on
   * zero, or a bar identical to the one before it. On those the engine's own
   * sentence carries no growth clause either, so a reader is told nothing the
   * engine did not measure.
   */
  histogramExpanding: boolean | null;
  adx14: number | null;
  plusDi14: number | null;
  minusDi14: number | null;
  relativeVolume20: number | null;
  obvTrend: 'rising' | 'flat' | 'falling' | null;
  bollingerUpper: number | null;
  bollingerMiddle: number | null;
  bollingerLower: number | null;
  keltnerUpper: number | null;
  keltnerMiddle: number | null;
  keltnerLower: number | null;
  squeezeOn: boolean | null;
  atr14: number | null;
  ema20DeviationPct: number | null;
  atrNormalizedDistance: number | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
  divergence: 'bullish' | 'bearish' | null;
}

export interface MarketSignalConfidenceBreakdown {
  completeness: number;
  agreement: number;
  evidenceStrength: number;
  volumeConfirmation: number;
  regimeClarity: number;
  conflictPenalty: number;
}

interface MarketSignalBase {
  symbol: string;
  timeframe: '1D';
  calculatedAt: string;
  latestCandleAt: string | null;
  source: string | null;
  freshness: DataFreshness;
  dataPoints: { received: number; finalized: number };
  scoreBreakdown: MarketSignalScoreBreakdown;
  reasons: MarketSignalReason[];
  warnings: string[];
  flags: MarketSignalFlag[];
  metrics: MarketSignalMetrics;
  confidenceBreakdown: MarketSignalConfidenceBreakdown;
  /** P1 only. Omitted entirely when `SIGNAL_GATE` is off. */
  gate?: MarketSignalGate;
  /** P2 only. Omitted entirely when `SIGNAL_ZONES` is off, or when ATR is unavailable. */
  zones?: MarketSignalZones;
  /** P3 only. Omitted entirely when `SIGNAL_ACTIONABLE` is off, or when there is no zone. */
  actionable?: MarketSignalActionable;
  /** P6 only. Omitted entirely when `SIGNAL_HISTORY` is off, or when nothing is stored yet. */
  history?: MarketSignalHistory;
}

export type MarketSignalResult = MarketSignalBase & ({
  status: 'available';
  state: MarketSignalState;
  bias: MarketSignalBias;
  score: number;
  /**
   * @deprecated Read `evidenceAgreement`. Identical value, honest name.
   *
   * The word was wrong and P4a proved how wrong. This number measures how well
   * the engine's own evidence agrees with itself; a reader sees a percentage
   * beside a direction and reads a probability. Measured against outcomes, the
   * 90-99 band hits 53-55% — the same as the 20-29 band — so as a probability it
   * is off by up to 40 points and carries no ranking information below the
   * 20-bar horizon. Kept, unchanged, because removing a field is not additive.
   */
  confidence: number;
  /** @deprecated Read `evidenceAgreementLabel`. */
  confidenceLabel: Exclude<MarketSignalConfidenceLabel, 'Insufficient'>;
  /**
   * How well the five evidence components agree with each other, 0-100.
   *
   * NOT a probability that price will do anything. Same value as `confidence`,
   * which it replaces; both are emitted while callers migrate.
   */
  evidenceAgreement: number;
  evidenceAgreementLabel: Exclude<MarketSignalConfidenceLabel, 'Insufficient'>;
} | {
  status: 'insufficient-data';
  state: null;
  bias: null;
  score: null;
  /** @deprecated Read `evidenceAgreement`. */
  confidence: 0;
  /** @deprecated Read `evidenceAgreementLabel`. */
  confidenceLabel: 'Insufficient';
  evidenceAgreement: 0;
  evidenceAgreementLabel: 'Insufficient';
  reason: string;
});

/**
 * One day the card was published, as it was published.
 *
 * Read back out of `public.market_signal_history`, never recomputed. Replaying
 * today's engine over yesterday's bars gives yesterday's label AT TODAY'S
 * ENGINE, which is a different statement and the reason this is stored rather
 * than derived.
 */
export interface MarketSignalHistoryEntry {
  /** The finalized candle's date, `YYYY-MM-DD`. Not the date the row was written. */
  asOf: string;
  state: MarketSignalState;
  bias: MarketSignalBias;
  /** `null` on days `SIGNAL_ZONES` was off, which is a fact worth keeping. */
  zone: MarketSignalZoneName | null;
  score: number | null;
  evidenceAgreement: number | null;
  flags: readonly string[];
}

/**
 * P6 only. Omitted entirely when `SIGNAL_HISTORY` is off.
 *
 * WHAT THIS IS NOT. `currentLabelDays` is a fact about the LABEL, not about the
 * market, and P4a is why the distinction is load-bearing: a SIDEWAYS label is
 * still SIDEWAYS at twenty bars 72.6% of the time while price is still inside
 * the frame it named only 25.7% of the time. A label that has stood a long time
 * has demonstrated that it is slow to change. Nothing in the UI may present it
 * as a label that is more likely to be right — see
 * `docs/market-signal/p6-history-findings.md` for the measurement that settles
 * what this number is allowed to imply.
 */
export interface MarketSignalHistory {
  /**
   * Oldest first, and GAPPY ON PURPOSE.
   *
   * A row exists for a day only if the signal was computed that day, which
   * happens when somebody opened the card. A symbol nobody looked at on Tuesday
   * has no Tuesday entry. The array therefore has fewer than `windowDays`
   * members most of the time, and a renderer must draw the absence rather than
   * close the gap: interpolating invents a label that was never published.
   */
  entries: readonly MarketSignalHistoryEntry[];
  /** Days requested. `entries.length` below this is missing data, not a flat market. */
  windowDays: number;
  /**
   * Calendar days from the first recorded day of the current unbroken run of
   * this label to the newest entry. `null` when there is only one entry, because
   * a run of one has no length yet — and 0 would read as "changed today".
   */
  currentLabelDays: number | null;
  /** Whether the newest entry's label differs from any inside `recentFlipDays`. */
  recentFlip: boolean;
}

export interface MarketSignalContext {
  symbol: string;
  source: string | null;
  freshness: DataFreshness;
  calculatedAt: string;
  /** Rollout switches, resolved by the caller. Absent means every phase is off. */
  features?: Partial<MarketSignalFeatures>;
  /** Optional by design: the engine degrades rather than fails without it. */
  earnings?: MarketSignalEarningsContext;
}
