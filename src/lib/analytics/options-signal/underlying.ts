import { calculateSupportResistance } from '@/src/lib/analytics/support-resistance/calculations';
import { calculateTechnicalAnalysis } from '@/src/lib/analytics/technical/calculations';
import type { IndicatorPoint } from '@/src/lib/analytics/technical/types';
import type { DataFreshness, HistoricalPrice } from '@/src/lib/market-data/types';
import { OPTIONS_SIGNAL_CONFIG } from './config';
import { classifySqueezeState, realizedVolatility, ttmSqueezeSeries } from './indicators';
import type {
  MacroInput,
  MomentumInput,
  OptionsSignalDataState,
  OptionsSignalInputSlot,
  PriceLevelsInput,
  TrendInput,
} from './types';

/**
 * Deterministic mapping from the shared market-data freshness vocabulary to the
 * four data states the Options Signal UI is allowed to display. Anything the
 * pipeline could not vouch for becomes `UNAVAILABLE` rather than being shown as
 * a plain number.
 */
export function dataStateFromFreshness(freshness: DataFreshness): OptionsSignalDataState {
  switch (freshness.status) {
    case 'realtime': return 'LIVE';
    case 'delayed':
    case 'end-of-day':
    case 'cached': return 'DELAYED';
    case 'stale': return 'STALE';
    default: return 'UNAVAILABLE';
  }
}

export interface UnderlyingCandle extends HistoricalPrice {
  finalized: boolean;
}

export interface UnderlyingContextMeta {
  symbol: string;
  provider: string | null;
  freshness: DataFreshness;
  calculatedAt: string;
}

export interface UnderlyingSignalInputs {
  trend: OptionsSignalInputSlot<TrendInput>;
  momentum: OptionsSignalInputSlot<MomentumInput>;
  levels: OptionsSignalInputSlot<PriceLevelsInput>;
  realizedVolatility: { value: number; observations: number } | null;
  latestCandleAt: string | null;
  finalizedCandles: number;
}

/** Drop still-forming candles. Every technical input below is look-ahead free. */
export function finalizedOnly(candles: readonly UnderlyingCandle[]): HistoricalPrice[] {
  return candles
    .filter((candle) => candle.finalized)
    .map(({ finalized: _finalized, ...candle }) => candle);
}

/** Latest finalized volume relative to the 20 complete sessions before it. */
export function relativeVolume20(candles: readonly HistoricalPrice[]): number | null {
  const trailing = candles.slice(-21, -1).map((candle) => candle.volume);
  if (trailing.length !== 20 || trailing.some((volume) => volume == null || !Number.isFinite(volume))) return null;
  const average = (trailing as number[]).reduce((sum, volume) => sum + volume, 0) / 20;
  const latest = candles.at(-1)?.volume;
  if (average <= 0 || latest == null || !Number.isFinite(latest)) return null;
  return latest / average;
}

/** Nearest confirmed level on each side of `price`, or null when none qualifies. */
export function nearestLevels(
  zones: ReadonlyArray<{ type: 'support' | 'resistance'; midpoint: number }>,
  price: number,
): { support: number | null; resistance: number | null } {
  const supports = zones
    .filter((zone) => zone.type === 'support' && zone.midpoint <= price)
    .map((zone) => zone.midpoint);
  const resistances = zones
    .filter((zone) => zone.type === 'resistance' && zone.midpoint >= price)
    .map((zone) => zone.midpoint);
  return {
    support: supports.length ? Math.max(...supports) : null,
    resistance: resistances.length ? Math.min(...resistances) : null,
  };
}

function unavailable<T>(meta: UnderlyingContextMeta, reason: string): OptionsSignalInputSlot<T> {
  return { status: 'unavailable', state: 'UNAVAILABLE', reason, provider: meta.provider, asOf: meta.freshness.asOf };
}

/**
 * Build every candle-derived Options Signal input for one symbol from ONE
 * canonical daily dataset, reusing the shared technical and support/resistance
 * libraries. Nothing here fetches: the caller owns the (cached) candle request.
 */
export function buildUnderlyingInputs(
  candles: readonly UnderlyingCandle[],
  meta: UnderlyingContextMeta,
): UnderlyingSignalInputs {
  const finalized = finalizedOnly(candles);
  const state = dataStateFromFreshness(meta.freshness);
  const latestCandleAt = finalized.at(-1)?.date ?? null;
  const provenance = { provider: meta.provider, asOf: meta.freshness.asOf };
  const insufficient = `แท่งเทียน 1D ที่ปิดแล้วมีเพียง ${finalized.length} แท่ง`;

  // A dataset the pipeline itself could not vouch for is never scored: an
  // UNAVAILABLE freshness must not silently become a DELAYED-looking factor.
  if (state === 'UNAVAILABLE') {
    const reason = 'ชุดข้อมูลแท่งเทียนรายวันไม่พร้อมใช้งาน';
    return {
      trend: unavailable(meta, reason),
      momentum: unavailable(meta, reason),
      levels: unavailable(meta, reason),
      realizedVolatility: null,
      latestCandleAt,
      finalizedCandles: finalized.length,
    };
  }

  if (finalized.length < OPTIONS_SIGNAL_CONFIG.minimumFinalizedCandles) {
    return {
      trend: unavailable(meta, insufficient),
      momentum: unavailable(meta, insufficient),
      levels: unavailable(meta, insufficient),
      realizedVolatility: null,
      latestCandleAt,
      finalizedCandles: finalized.length,
    };
  }

  const technical = calculateTechnicalAnalysis(finalized, {
    symbol: meta.symbol,
    source: meta.provider,
    freshness: meta.freshness,
    calculatedAt: meta.calculatedAt,
  });
  if (technical.status !== 'available') {
    return {
      trend: unavailable(meta, technical.reason),
      momentum: unavailable(meta, technical.reason),
      levels: unavailable(meta, technical.reason),
      realizedVolatility: null,
      latestCandleAt,
      finalizedCandles: finalized.length,
    };
  }

  const latestOf = (result: { status: string; latest?: IndicatorPoint }) =>
    result.status === 'available' && result.latest ? result.latest.value : null;
  const close = finalized.at(-1)!.close;
  const ema20 = latestOf(technical.indicators.ema);
  const ema50 = latestOf(technical.indicators.ema50);
  const atr = latestOf(technical.indicators.atr);

  const trend: OptionsSignalInputSlot<TrendInput> = ema20 === null && ema50 === null
    ? unavailable(meta, 'คำนวณ EMA20/EMA50 จากแท่งที่ปิดแล้วไม่ได้')
    : { status: 'available', state, value: { close, ema20, ema50 }, ...provenance };

  const series = ttmSqueezeSeries(finalized);
  const squeeze = classifySqueezeState(series);
  const momentum: OptionsSignalInputSlot<MomentumInput> = squeeze === null
    ? unavailable(meta, 'คำนวณสถานะ TTM Squeeze จากแท่งที่ปิดแล้วไม่ได้')
    : {
      status: 'available',
      state,
      value: {
        squeeze,
        squeezeMomentum: series.momentum.at(-1) ?? null,
        atr,
        relativeVolume: relativeVolume20(finalized),
      },
      ...provenance,
    };

  const supportResistance = calculateSupportResistance(finalized, {
    symbol: meta.symbol,
    source: meta.provider,
    freshness: meta.freshness,
    calculatedAt: meta.calculatedAt,
  });
  const levels: OptionsSignalInputSlot<PriceLevelsInput> = supportResistance.status === 'available'
    ? {
      status: 'available',
      state,
      value: { close, ...nearestLevels(supportResistance.zones, close) },
      ...provenance,
    }
    : unavailable(meta, supportResistance.reason);

  return {
    trend,
    momentum,
    levels,
    realizedVolatility: realizedVolatility(
      finalized,
      OPTIONS_SIGNAL_CONFIG.iv.realizedWindowDays,
      OPTIONS_SIGNAL_CONFIG.iv.minimumRealizedObservations,
    ),
    latestCandleAt,
    finalizedCandles: finalized.length,
  };
}

export interface MacroBenchmarkSource {
  symbol: string;
  candles: readonly UnderlyingCandle[];
  provider: string | null;
  freshness: DataFreshness;
}

/**
 * Market regime from index proxies. A benchmark whose EMA20 cannot be computed
 * is omitted rather than defaulted, and the slot only reports `available` when
 * at least one real benchmark survived.
 */
export function buildMacroInput(
  sources: readonly MacroBenchmarkSource[],
  calculatedAt: string,
): OptionsSignalInputSlot<MacroInput> {
  const rank = ['LIVE', 'DELAYED', 'STALE'] as const;
  const benchmarks: MacroInput['benchmarks'] = [];
  const providers: string[] = [];
  const states: Array<(typeof rank)[number]> = [];
  let asOf: string | null = null;

  for (const source of sources) {
    const sourceState = dataStateFromFreshness(source.freshness);
    if (sourceState === 'UNAVAILABLE') continue;
    const finalized = finalizedOnly(source.candles);
    if (finalized.length < OPTIONS_SIGNAL_CONFIG.minimumFinalizedCandles) continue;
    const technical = calculateTechnicalAnalysis(finalized, {
      symbol: source.symbol,
      source: source.provider,
      freshness: source.freshness,
      calculatedAt,
    });
    if (technical.status !== 'available') continue;
    const ema20 = technical.indicators.ema.status === 'available' ? technical.indicators.ema.latest.value : null;
    if (ema20 === null) continue;
    benchmarks.push({ symbol: source.symbol, close: finalized.at(-1)!.close, ema20 });
    if (source.provider) providers.push(source.provider);
    states.push(sourceState);
    if (source.freshness.asOf && (asOf === null || source.freshness.asOf < asOf)) asOf = source.freshness.asOf;
  }

  if (!benchmarks.length) {
    return {
      status: 'unavailable',
      state: 'UNAVAILABLE',
      reason: 'ไม่มีข้อมูลดัชนีอ้างอิง (SPY/QQQ) ที่คำนวณ EMA20 ได้',
      provider: null,
      asOf: null,
    };
  }
  // The weakest state across the benchmarks is the honest state for the group.
  const worst = rank[Math.max(...states.map((value) => rank.indexOf(value)))];
  return {
    status: 'available',
    state: worst,
    value: { benchmarks },
    provider: [...new Set(providers)].join(', ') || null,
    asOf,
  };
}
