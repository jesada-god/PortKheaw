import { describe, expect, it } from 'vitest';
import { assembleLevelRows, nearestLevel, signedDistancePercent, toLevelInputs } from './level-rows';
import { calculateLevelStatistics } from '@/src/lib/analytics/level-statistics';
import { normalizeCanonicalBars } from '@/src/lib/analytics/canonical-bars';

/** The worked example from the spec: classic floor-trader pivots around 206.75. */
const LEVELS = {
  resistance: [211.10, 213.44, 216.01] as [number, number, number],
  support: [206.19, 203.62, 201.28] as [number, number, number],
};
const PRICE = 206.75;

describe('support/resistance rows', () => {
  const rows = assembleLevelRows(LEVELS, [], PRICE);

  it('orders resistance furthest-first and support nearest-first around the price', () => {
    expect(rows.map((row) => row.label)).toEqual(['R3', 'R2', 'R1', 'S1', 'S2', 'S3']);
  });

  it('computes the signed distance from the accepted price', () => {
    const byLabel = new Map(rows.map((row) => [row.label, row]));
    expect(byLabel.get('R1')?.distancePercent).toBeCloseTo(2.10, 2);
    expect(byLabel.get('R2')?.distancePercent).toBeCloseTo(3.24, 2);
    expect(byLabel.get('R3')?.distancePercent).toBeCloseTo(4.48, 2);
    expect(byLabel.get('S1')?.distancePercent).toBeCloseTo(-0.27, 2);
    expect(byLabel.get('S2')?.distancePercent).toBeCloseTo(-1.51, 2);
    expect(byLabel.get('S3')?.distancePercent).toBeCloseTo(-2.65, 2);
  });

  it('returns no distance when there is no accepted price rather than guessing one', () => {
    expect(signedDistancePercent(100, null)).toBeNull();
    expect(signedDistancePercent(100, 0)).toBeNull();
    assembleLevelRows(LEVELS, [], null).forEach((row) => expect(row.distancePercent).toBeNull());
  });

  it('names the nearest level and its distance', () => {
    const nearest = nearestLevel(rows, PRICE);
    expect(nearest?.label).toBe('S1');
    expect(nearest?.price).toBe(206.19);
    expect(Math.abs(nearest?.distancePercent ?? 0)).toBeCloseTo(0.27, 2);
  });

  it('has no nearest level without an accepted price', () => {
    expect(nearestLevel(assembleLevelRows(LEVELS, [], null), null)).toBeNull();
  });

  it('maps the pivot set to R1–R3 and S1–S3 statistics inputs', () => {
    const inputs = toLevelInputs(LEVELS);
    expect(inputs.map((input) => input.id)).toEqual(['R1', 'R2', 'R3', 'S1', 'S2', 'S3']);
    expect(inputs.filter((input) => input.type === 'resistance')).toHaveLength(3);
    expect(inputs.filter((input) => input.type === 'support')).toHaveLength(3);
  });

  it('joins the measured statistics onto the matching level', () => {
    const bars = normalizeCanonicalBars(Array.from({ length: 80 }, (_, index) => {
      const close = 206.75 + Math.sin(index / 5) * 5;
      return {
        time: Date.UTC(2026, 0, 5) / 1_000 + index * 86_400,
        open: close - 0.4, high: close + 1.2, low: close - 1.2, close, volume: 1_000,
      };
    }));
    const statistics = calculateLevelStatistics(bars, toLevelInputs(LEVELS));
    expect(statistics.status).toBe('available');
    const joined = assembleLevelRows(LEVELS, statistics.levels, PRICE);
    joined.forEach((row) => {
      expect(row.statistics?.id).toBe(row.label);
      expect(row.statistics?.price).toBe(row.price);
    });
  });
});
