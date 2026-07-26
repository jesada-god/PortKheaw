import type { DataFreshness, HistoricalPrice } from '@/src/lib/market-data/types';

export type PriceField = 'open' | 'high' | 'low' | 'close';
export type TechnicalIndicatorId =
  | 'sma' | 'sma50' | 'sma100' | 'sma200'
  | 'ema' | 'ema50' | 'ema100' | 'ema200'
  | 'rsi' | 'macd' | 'bollinger' | 'atr'
  | 'volume' | 'averageVolume' | 'averageVolume50'
  | 'stochastic' | 'adx' | 'obv' | 'ichimoku' | 'roc' | 'vwap';

export interface IndicatorPoint {
  date: string;
  value: number;
}

export interface MacdPoint extends IndicatorPoint {
  signal: number | null;
  histogram: number | null;
}

export interface BollingerPoint extends IndicatorPoint {
  upper: number;
  middle: number;
  lower: number;
}

export interface KeltnerPoint extends IndicatorPoint {
  upper: number;
  middle: number;
  lower: number;
}

export interface StochasticPoint extends IndicatorPoint { k: number; d: number | null; }
export interface AdxPoint extends IndicatorPoint { plusDi: number; minusDi: number; }
export interface IchimokuPoint extends IndicatorPoint {
  conversion: number;
  base: number;
  leadingA: number | null;
  leadingB: number | null;
}

export interface TechnicalParameters {
  priceField: PriceField;
  smaPeriod: number;
  emaPeriod: number;
  rsiPeriod: number;
  macdFastPeriod: number;
  macdSlowPeriod: number;
  macdSignalPeriod: number;
  bollingerPeriod: number;
  bollingerStdDev: number;
  keltnerPeriod: number;
  keltnerAtrPeriod: number;
  keltnerAtrMultiplier: number;
  atrPeriod: number;
  averageVolumePeriod: number;
  stochasticPeriod: number;
  stochasticSmoothK: number;
  stochasticSmoothD: number;
  adxPeriod: number;
  rocPeriod: number;
  ichimokuConversionPeriod: number;
  ichimokuBasePeriod: number;
  ichimokuSpanPeriod: number;
  ichimokuDisplacement: number;
}

export interface TechnicalContext {
  symbol: string;
  source: string | null;
  freshness: DataFreshness;
  calculatedAt?: string;
}

export interface IndicatorUnavailable {
  status: 'unavailable';
  reason: string;
  minimumDataPoints: number;
  actualDataPoints: number;
}

export interface IndicatorAvailable<T> {
  status: 'available';
  points: T[];
  latest: T;
}

export type IndicatorResult<T> = IndicatorAvailable<T> | IndicatorUnavailable;

export interface TechnicalAnalysisResult {
  status: 'available';
  symbol: string;
  input: { priceField: PriceField; candleCount: number; interval: '1d' };
  dataSource: string | null;
  source: string | null;
  sourceType: 'provider/cache historical OHLCV';
  dataPoints: number;
  latestDataAt: string;
  calculatedAt: string;
  methodology: 'Deterministic technical indicators calculated from daily OHLCV';
  parameters: TechnicalParameters;
  freshness: DataFreshness;
  limitations: string[];
  assumptions: string[];
  indicators: {
    sma: IndicatorResult<IndicatorPoint>;
    sma50: IndicatorResult<IndicatorPoint>;
    sma100: IndicatorResult<IndicatorPoint>;
    sma200: IndicatorResult<IndicatorPoint>;
    ema: IndicatorResult<IndicatorPoint>;
    ema50: IndicatorResult<IndicatorPoint>;
    ema100: IndicatorResult<IndicatorPoint>;
    ema200: IndicatorResult<IndicatorPoint>;
    rsi: IndicatorResult<IndicatorPoint>;
    macd: IndicatorResult<MacdPoint>;
    bollinger: IndicatorResult<BollingerPoint>;
    keltner: IndicatorResult<KeltnerPoint>;
    atr: IndicatorResult<IndicatorPoint>;
    volume: IndicatorResult<IndicatorPoint>;
    averageVolume: IndicatorResult<IndicatorPoint>;
    averageVolume50: IndicatorResult<IndicatorPoint>;
    stochastic: IndicatorResult<StochasticPoint>;
    adx: IndicatorResult<AdxPoint>;
    obv: IndicatorResult<IndicatorPoint>;
    ichimoku: IndicatorResult<IchimokuPoint>;
    roc: IndicatorResult<IndicatorPoint>;
    vwap: IndicatorResult<IndicatorPoint>;
  };
}

export interface TechnicalAnalysisUnavailable {
  status: 'unavailable';
  symbol: string;
  reason: string;
  input: { priceField: PriceField; candleCount: number; interval: '1d' };
  dataSource: string | null;
  source: string | null;
  sourceType: 'provider/cache historical OHLCV';
  dataPoints: number;
  latestDataAt: string | null;
  calculatedAt: string;
  methodology: 'Deterministic technical indicators calculated from daily OHLCV';
  parameters: TechnicalParameters;
  freshness: DataFreshness;
  limitations: string[];
  assumptions: string[];
}

export type TechnicalAnalysis = TechnicalAnalysisResult | TechnicalAnalysisUnavailable;
export type TechnicalCandles = readonly HistoricalPrice[];
