import { describe, expect, it } from 'vitest';
import {
  aggregateIndustryChartSeries,
  attachBenchmark,
} from './industry-chart';

const candles = (values: number[], offset = 0) => values.map((close, index) => ({
  timestamp: 1_700_000_000 + index * 86_400 + offset,
  close,
}));

describe('industry historical aggregation', () => {
  it('aligns finalized timestamps and applies the 60% coverage threshold', () => {
    const result = aggregateIndustryChartSeries([
      { symbol: 'A', candles: candles([100, 110, 120]) },
      { symbol: 'B', candles: candles([200, 220, 240]) },
      { symbol: 'C', candles: candles([50, 55, 60]) },
      { symbol: 'MISALIGNED', candles: candles([100, 200, 300], 60) },
      { symbol: 'PARTIAL', candles: candles([100, 110, 120]).map((item) => ({ ...item, partial: true })) },
    ], 5, 3);
    expect(result.points).toHaveLength(3);
    expect(result.points[1]?.industryReturn).toBeCloseTo(10);
    expect(result.points[1]?.memberCount).toBe(3);
    expect(result.usableMembers).toBe(4);
  });

  it('returns an unavailable series when timestamp coverage is below threshold', () => {
    const result = aggregateIndustryChartSeries([
      { symbol: 'A', candles: candles([100, 110, 120]) },
      { symbol: 'B', candles: candles([100, 110, 120], 30) },
    ], 5, 3);
    expect(result.points).toEqual([]);
  });

  it('attaches only an exactly aligned finalized benchmark', () => {
    const industry = aggregateIndustryChartSeries([
      { symbol: 'A', candles: candles([100, 110, 120]) },
      { symbol: 'B', candles: candles([100, 110, 120]) },
      { symbol: 'C', candles: candles([100, 110, 120]) },
    ], 3, 3);
    const points = attachBenchmark(industry.points, candles([200, 220, 240]));
    expect(points.map((point) => point.benchmarkReturn)).toHaveLength(3);
    expect(points[0]?.benchmarkReturn).toBeCloseTo(0);
    expect(points[1]?.benchmarkReturn).toBeCloseTo(10);
    expect(points[2]?.benchmarkReturn).toBeCloseTo(20);
  });
});
