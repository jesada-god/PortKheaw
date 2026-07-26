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
  | 'weak_confirmation';

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
}
