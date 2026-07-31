import type { IndustryChartPoint } from './types';

export const INDUSTRY_CHART_MIN_COVERAGE = 0.6;
export const INDUSTRY_CHART_MIN_MEMBERS = 3;

export interface ChartCandle {
  timestamp: number;
  close: number;
  partial?: boolean;
}

export interface MemberCandleSeries {
  symbol: string;
  candles: readonly ChartCandle[];
}

export interface AggregatedIndustrySeries {
  points: Array<Omit<IndustryChartPoint, 'benchmarkReturn'>>;
  usableMembers: number;
}

function finalized(candles: readonly ChartCandle[]): ChartCandle[] {
  return candles
    .filter((candle) =>
      candle.partial !== true
      && Number.isInteger(candle.timestamp)
      && Number.isFinite(candle.close)
      && candle.close > 0
    )
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function normalizedReturnSeries(
  candles: readonly ChartCandle[],
): Map<number, number> {
  const valid = finalized(candles);
  const baseline = valid[0]?.close;
  if (!baseline) return new Map();
  return new Map(valid.map((candle) => [
    candle.timestamp,
    (candle.close / baseline - 1) * 100,
  ]));
}

/**
 * Equal-weighted return at timestamps shared by enough finalized constituent
 * candles. Missing slots are excluded rather than forward-filled or estimated.
 */
export function aggregateIndustryChartSeries(
  series: readonly MemberCandleSeries[],
  requestedMembers: number,
  minimumPoints: number,
  minimumCoverage = INDUSTRY_CHART_MIN_COVERAGE,
): AggregatedIndustrySeries {
  const normalized = series
    .map((item) => ({ symbol: item.symbol, returns: normalizedReturnSeries(item.candles) }))
    .filter((item) => item.returns.size >= minimumPoints);
  const timestamps = [...new Set(normalized.flatMap((item) => [...item.returns.keys()]))]
    .sort((left, right) => left - right);
  const denominator = Math.max(requestedMembers, 1);
  const minimumMembers = Math.max(
    INDUSTRY_CHART_MIN_MEMBERS,
    Math.ceil(denominator * minimumCoverage),
  );
  const points = timestamps.flatMap((timestamp) => {
    const values = normalized.flatMap((item) => {
      const value = item.returns.get(timestamp);
      return value === undefined ? [] : [value];
    });
    if (values.length < minimumMembers) return [];
    return [{
      timestamp,
      industryReturn: values.reduce((sum, value) => sum + value, 0) / values.length,
      memberCount: values.length,
    }];
  });
  return {
    points: points.length >= minimumPoints ? points : [],
    usableMembers: normalized.length,
  };
}

export function attachBenchmark(
  points: readonly Omit<IndustryChartPoint, 'benchmarkReturn'>[],
  benchmarkCandles: readonly ChartCandle[],
): IndustryChartPoint[] {
  const benchmark = normalizedReturnSeries(benchmarkCandles);
  return points.map((point) => ({
    ...point,
    benchmarkReturn: benchmark.get(point.timestamp) ?? null,
  }));
}
