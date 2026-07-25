import type { DataFreshness, HistoricalPrice } from '@/src/lib/market-data/types';

export type MarketSignalDirection = 'bullish' | 'neutral' | 'bearish';
export type MarketSignalConfidence = 'Low' | 'Medium' | 'High' | 'Insufficient';
export type MarketSignalComponentId = 'trend' | 'momentum' | 'volume' | 'structure';

export interface MarketSignalCandle extends HistoricalPrice {
  finalized: boolean;
}

export interface MarketSignalComponent {
  score: number | null;
  weight: 30 | 25 | 20;
  coverage: number;
  factorsUsed: number;
}

export interface MarketSignalReason {
  id: string;
  polarity: 'positive' | 'negative' | 'caution';
  text: string;
  impact: number;
}

export interface MarketSignalIndicators {
  close: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  relativeVolume20: number | null;
  obvTrend: 'rising' | 'flat' | 'falling' | null;
  adx14: number | null;
  plusDi14: number | null;
  minusDi14: number | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
}

interface MarketSignalBase {
  timeframe: '1D';
  calculatedAt: string;
  latestCandleAt: string | null;
  source: string | null;
  freshness: DataFreshness;
  dataPoints: { received: number; finalized: number };
  components: Record<MarketSignalComponentId, MarketSignalComponent>;
  reasons: MarketSignalReason[];
  indicators: MarketSignalIndicators;
}

export type MarketSignalResult = MarketSignalBase & ({
  status: 'available';
  signal: MarketSignalDirection;
  score: number;
  confidence: Exclude<MarketSignalConfidence, 'Insufficient'>;
  confidencePct: number;
} | {
  status: 'insufficient-data';
  signal: null;
  score: null;
  confidence: 'Insufficient';
  confidencePct: number;
  reason: string;
});

export interface MarketSignalContext {
  symbol: string;
  source: string | null;
  freshness: DataFreshness;
  calculatedAt: string;
}
