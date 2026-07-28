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
 * `iv-vs-realized` is an explicitly-labelled fallback computed from two real
 * measurements — today's ATM implied volatility from the live chain and the
 * underlying's own realized volatility — and is always disclosed as such.
 */
export type IvPricingInput =
  | {
    basis: 'iv-rank';
    ivRank: number;
    impliedVolatility: number | null;
    observations: number;
  }
  | {
    basis: 'iv-vs-realized';
    impliedVolatility: number;
    realizedVolatility: number;
    ratio: number;
    observations: number;
  };

export interface SentimentInput {
  putCallRatio: number;
  basis: 'open-interest' | 'volume';
  putTotal: number;
  callTotal: number;
  expiration: string;
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
}

export interface RiskRewardInput {
  price: number;
  /** Nearest confirmed support at or below `price`. */
  support: number | null;
  /** Nearest confirmed resistance at or above `price`. */
  resistance: number | null;
}

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

export interface OptionsSignalDiagnostics {
  factors: Record<OptionsSignalFactorId, OptionsSignalFactorScore>;
  /** Raw sum of factor points, in the same units as the weights. */
  directionScore: number;
  availableWeight: number;
  totalWeight: number;
  /** directionScore rescaled to [-100, 100] against the AVAILABLE weight only. */
  normalizedScore: number;
  coverage: number;
  agreement: number;
  evidenceStrength: number;
  confidenceBase: number;
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
    state: OptionsSignalDataState;
  };
  iv: {
    level: IvLevel | null;
    basis: IvPricingInput['basis'] | null;
    ivRank: number | null;
    impliedVolatility: number | null;
    realizedVolatility: number | null;
    ratio: number | null;
    observations: number | null;
    state: OptionsSignalDataState;
    reason: string | null;
  };
  event: {
    reportDate: string | null;
    daysToEarnings: number | null;
    timeOfDay: EarningsTimeOfDay | null;
    state: OptionsSignalDataState;
    reason: string | null;
  };
  squeeze: {
    state: SqueezeState | null;
    momentum: number | null;
    normalizedMomentum: number | null;
    relativeVolume: number | null;
    confirmation: number | null;
  };
  macro: {
    benchmarks: Array<{ symbol: string; close: number; ema20: number | null; aboveEma20: boolean | null }>;
  };
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
  reasoning: OptionsSignalReason[];
  suggestedOptionsSetup: SuggestedOptionsSetup;
  diagnostics: OptionsSignalDiagnostics;
}

export type OptionsSignalResult = OptionsSignalBase & (
  | {
    status: 'available';
    signalType: OptionsSignalType;
    confidenceScore: number;
    underlyingBias: UnderlyingBias;
  }
  | {
    status: 'insufficient-data';
    signalType: null;
    confidenceScore: 0;
    underlyingBias: null;
    reason: string;
  }
);
