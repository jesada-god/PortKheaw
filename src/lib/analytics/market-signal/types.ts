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
 * Where the boundaries came from — and this distinction is the whole phase.
 *
 * The engine's `nearestSupport`/`nearestResistance` are, by construction, the
 * confirmed levels immediately below and above the CURRENT price. So whenever
 * both exist, price is inside them and cannot be closing beyond either: a zone
 * built only from that pair would read `sideways` forever and the label would be
 * a constant. What actually distinguishes a trending instrument is that one side
 * has no confirmed level left at all.
 *
 *   `structural`  Both levels exist and are more than an ATR apart. Price is
 *                 inside a range it has traded against, so the zone is sideways
 *                 and `positionPct` carries the lean.
 *   `open_above`  No confirmed resistance remains above price. It is beyond
 *                 every level anyone has defended — the real breakout state.
 *   `open_below`  The mirror: no confirmed support left beneath.
 *   `atr_band`    Both levels missing, or closer together than one ATR, which is
 *                 a "range" narrower than a normal day's movement and cannot be
 *                 broken meaningfully. Falls back to a band around EMA20, and
 *                 every number in it is a volatility envelope rather than a
 *                 level anybody has traded against.
 *
 * On an open side there is no boundary and no trigger, so those fields are
 * `null` rather than a projected number that would read as a real level.
 */
export type MarketSignalZoneMode = 'structural' | 'open_above' | 'open_below' | 'atr_band';

export interface MarketSignalZones {
  mode: MarketSignalZoneMode;
  /** The zone the latest FINALIZED close sits in, after confirmation and hysteresis. */
  zone: MarketSignalZoneName;
  /** `null` on an open side: there is no confirmed level there to name. */
  support: number | null;
  resistance: number | null;
  /** Close above this enters the upper zone; falling back below `resistance` leaves it. */
  upperTrigger: number | null;
  /** Close below this enters the lower zone; recovering above `support` leaves it. */
  lowerTrigger: number | null;
  /** Where the close sits between support and resistance; `null` when a side is open. */
  positionPct: number | null;
  /** Distance from the close to each trigger, in price and in ATR. */
  upperDistance: number | null;
  upperDistanceAtr: number | null;
  lowerDistance: number | null;
  lowerDistanceAtr: number | null;
  /** How many finalized bars price has held this zone under today's boundaries. */
  zoneAgeBars: number;
  /** Bars since a bar's range last reached either level; `null` if never within the walk. */
  lastTestedBarsAgo: number | null;
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
