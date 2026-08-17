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
  | 'pre_earnings_breakout';

/** Which rollout phases the caller has turned on for this calculation. */
export interface MarketSignalFeatures {
  gate: boolean;
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
