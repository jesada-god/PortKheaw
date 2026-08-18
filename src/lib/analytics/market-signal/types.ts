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
  | 'narrow_range';

/** Which rollout phases the caller has turned on for this calculation. */
export interface MarketSignalFeatures {
  gate: boolean;
  zones: boolean;
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
 */
export type MarketSignalZoneProximity = 'near_trigger' | 'mid_range' | 'deep_range';

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
}

export type MarketSignalResult = MarketSignalBase & ({
  status: 'available';
  state: MarketSignalState;
  bias: MarketSignalBias;
  score: number;
  confidence: number;
  confidenceLabel: Exclude<MarketSignalConfidenceLabel, 'Insufficient'>;
} | {
  status: 'insufficient-data';
  state: null;
  bias: null;
  score: null;
  confidence: 0;
  confidenceLabel: 'Insufficient';
  reason: string;
});

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
