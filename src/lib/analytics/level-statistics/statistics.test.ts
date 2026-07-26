import { describe, expect, it } from 'vitest';
import { calculateLevelStatistics, type LevelInput } from './statistics';
import type { CanonicalBar } from '../canonical-bars';

const DAY = 86_400;
const START = Date.UTC(2026, 0, 5) / 1_000;

/**
 * Builds bars from a close path. Each bar is a small range around its close so
 * the ATR stays stable and the tolerance band is predictable.
 */
function barsFromCloses(closes: readonly number[], spread = 0.5): CanonicalBar[] {
  return closes.map((close, index) => ({
    time: START + index * DAY,
    open: index === 0 ? close : closes[index - 1],
    high: Math.max(close, index === 0 ? close : closes[index - 1]) + spread,
    low: Math.min(close, index === 0 ? close : closes[index - 1]) - spread,
    close,
    volume: 1_000,
    partial: false,
  }));
}

/** 25 quiet bars around 100 to warm the ATR up before the interesting part. */
const WARMUP = Array.from({ length: 25 }, (_, index) => (index % 2 === 0 ? 100 : 100.4));

const support: LevelInput = { id: 'S1', label: 'S1', price: 98, type: 'support' };
const resistance: LevelInput = { id: 'R1', label: 'R1', price: 102, type: 'resistance' };

describe('level statistics — availability', () => {
  it('reports insufficient data instead of inventing counts', () => {
    const result = calculateLevelStatistics(barsFromCloses([100, 101, 102]), [support]);
    expect(result.status).toBe('unavailable');
    expect(result.levels).toHaveLength(0);
    expect(result.reason).toContain('อย่างน้อย');
  });

  it('reports a null hold rate for a level that was never tested', () => {
    const result = calculateLevelStatistics(barsFromCloses([...WARMUP, ...WARMUP]), [
      { id: 'FAR', label: 'FAR', price: 500, type: 'resistance' },
    ]);
    expect(result.status).toBe('available');
    expect(result.levels[0].touches).toBe(0);
    expect(result.levels[0].holdRate).toBeNull();
    expect(result.levels[0].strength).toBeNull();
  });

  it('exposes the methodology and its parameters rather than a bare number', () => {
    const result = calculateLevelStatistics(barsFromCloses([...WARMUP, ...WARMUP]), [support]);
    expect(result.methodology).toContain('Touch');
    expect(result.atrPeriod).toBe(14);
    expect(result.validationBars).toBe(3);
    expect(result.cooldownBars).toBe(3);
  });
});

describe('level statistics — touches', () => {
  it('counts a support touch when the bar range enters the tolerance band', () => {
    const result = calculateLevelStatistics(
      barsFromCloses([...WARMUP, 99, 98.1, 100, 101, 101.5, 102, 102, 102]),
      [support],
    );
    expect(result.levels[0].touches).toBeGreaterThanOrEqual(1);
  });

  it('counts a resistance touch when the bar range enters the tolerance band', () => {
    const result = calculateLevelStatistics(
      barsFromCloses([...WARMUP, 101, 101.9, 100, 99, 98.5, 98, 98, 98]),
      [resistance],
    );
    expect(result.levels[0].touches).toBeGreaterThanOrEqual(1);
  });

  it('treats a run of adjacent candles testing the same zone as one interaction', () => {
    // Six consecutive bars sitting on the level: one test, not six.
    const result = calculateLevelStatistics(
      barsFromCloses([...WARMUP, 98.1, 98.05, 98.1, 98.05, 98.1, 98.05, 101, 102, 103, 103]),
      [support],
    );
    expect(result.levels[0].touches).toBe(1);
  });

  it('needs price to leave the band and the cooldown to elapse before counting again', () => {
    const result = calculateLevelStatistics(
      barsFromCloses([...WARMUP, 98.1, 103, 103, 103, 103, 98.1, 103, 103, 103, 103]),
      [support],
    );
    expect(result.levels[0].touches).toBe(2);
  });

  it('records the timestamp of the most recent test', () => {
    const closes = [...WARMUP, 98.1, 103, 103, 103, 103];
    const bars = barsFromCloses(closes);
    const result = calculateLevelStatistics(bars, [support]);
    expect(result.levels[0].lastTouchTime).toBe(bars[WARMUP.length].time);
  });
});

describe('level statistics — holds and breaks', () => {
  it('counts a support hold when price is rejected back up without a confirmed breakdown', () => {
    const result = calculateLevelStatistics(
      barsFromCloses([...WARMUP, 98.1, 100, 101, 102, 103, 103, 103]),
      [support],
    );
    expect(result.levels[0].successfulHolds).toBe(1);
    expect(result.levels[0].breaks).toBe(0);
    expect(result.levels[0].holdRate).toBe(100);
  });

  it('counts a resistance hold when price is rejected back down', () => {
    const result = calculateLevelStatistics(
      barsFromCloses([...WARMUP, 101.9, 100, 99, 98, 97, 97, 97]),
      [resistance],
    );
    expect(result.levels[0].successfulHolds).toBe(1);
    expect(result.levels[0].breaks).toBe(0);
  });

  it('counts a confirmed close below support as a breakdown', () => {
    const result = calculateLevelStatistics(
      barsFromCloses([...WARMUP, 98.1, 95, 94, 93, 92, 92, 92]),
      [support],
    );
    expect(result.levels[0].breaks).toBe(1);
    expect(result.levels[0].successfulHolds).toBe(0);
    expect(result.levels[0].holdRate).toBe(0);
  });

  it('counts a confirmed close above resistance as a breakout', () => {
    const result = calculateLevelStatistics(
      barsFromCloses([...WARMUP, 101.9, 105, 106, 107, 108, 108, 108]),
      [resistance],
    );
    expect(result.levels[0].breaks).toBe(1);
  });

  it('does not treat a wick through the level as a break', () => {
    // A deep wick below support, but every close stays back above it.
    const bars = barsFromCloses([...WARMUP, 99, 100, 101, 102, 103, 103, 103]);
    const wickIndex = WARMUP.length;
    bars[wickIndex] = { ...bars[wickIndex], low: 90 };
    const result = calculateLevelStatistics(bars, [support]);
    expect(result.levels[0].touches).toBe(1);
    expect(result.levels[0].breaks).toBe(0);
    expect(result.levels[0].successfulHolds).toBe(1);
  });

  it('derives hold rate strictly as holds ÷ touches', () => {
    const result = calculateLevelStatistics(
      barsFromCloses([...WARMUP, 98.1, 102, 103, 104, 104, 98.1, 94, 93, 92, 92, 92]),
      [support],
    );
    const level = result.levels[0];
    expect(level.touches).toBe(2);
    expect(level.holdRate).toBeCloseTo((level.successfulHolds / level.touches) * 100, 10);
  });
});

describe('level statistics — determinism and look-ahead', () => {
  const closes = [...WARMUP, 98.1, 100, 101, 98.05, 96, 95, 97, 99, 101, 103, 103];

  it('produces identical results for identical inputs', () => {
    const first = calculateLevelStatistics(barsFromCloses(closes), [support, resistance]);
    const second = calculateLevelStatistics(barsFromCloses(closes), [support, resistance]);
    expect(second).toEqual(first);
  });

  it('does not classify an interaction whose validation window has not closed yet', () => {
    const bars = barsFromCloses(closes);
    const full = calculateLevelStatistics(bars, [support]);
    // Appending future bars may add new interactions, but must never change the
    // outcome already recorded for an earlier one.
    const extended = calculateLevelStatistics(barsFromCloses([...closes, 90, 89, 88]), [support]);
    full.levels[0].interactions.forEach((interaction, index) => {
      expect(extended.levels[0].interactions[index]).toEqual(interaction);
    });
  });

  it('ignores levels that are not finite positive prices', () => {
    const result = calculateLevelStatistics(barsFromCloses([...WARMUP, ...WARMUP]), [
      { id: 'BAD', label: 'BAD', price: Number.NaN, type: 'support' },
    ]);
    expect(result.status).toBe('unavailable');
  });
});
