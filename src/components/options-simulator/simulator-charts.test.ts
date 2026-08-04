import { describe, expect, it } from 'vitest';
import { buildPathSummaryData, buildPriceMarkers, MONTE_CARLO_PATH_SERIES } from './simulator-charts';

describe('options simulator chart contracts', () => {
  it('uses three fixed series while aggregating every simulation sample path', () => {
    const paths = Array.from({ length: 40 }, (_, path) => [100, 100 + path, 101 + path * 2]);
    const summary = buildPathSummaryData(paths);

    expect(MONTE_CARLO_PATH_SERIES.map((series) => series.dataKey)).toEqual(['lower', 'median', 'upper']);
    expect(MONTE_CARLO_PATH_SERIES).toHaveLength(3);
    expect(summary).toHaveLength(3);
    expect(summary[1]).toEqual({ step: 1, lower: 103.9, median: 119.5, upper: 135.1 });
    expect(summary[2].upper).toBeCloseTo(171.2, 10);
  });

  it('creates marker lines only for current, target, and canonical break-even prices', () => {
    const markers = buildPriceMarkers({
      currentPrice: 100,
      targetPrice: 110,
      breakEvenPrices: [105],
      format: String,
    });

    expect(markers.map((marker) => marker.id)).toEqual(['current', 'target', 'break-even-0']);
    expect(markers).toHaveLength(3);
  });
});
