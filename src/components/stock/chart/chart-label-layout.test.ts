import { describe, expect, it } from 'vitest';
import { layoutLabelColumn } from './chart-label-layout';

const options = { height: 400, labelHeight: 18 };

describe('layoutLabelColumn', () => {
  it('leaves labels that already have room exactly where their price is', () => {
    const placements = layoutLabelColumn(
      [{ id: 'R1', y: 100 }, { id: 'S1', y: 300 }],
      options,
    );
    expect(placements.map((placement) => placement.y)).toEqual([100, 300]);
    expect(placements.map((placement) => placement.anchorY)).toEqual([100, 300]);
  });

  it('separates near-identical levels without moving the price they anchor to', () => {
    // R1 and R2 two pixels apart: the labels must not print on top of each other.
    const placements = layoutLabelColumn(
      [{ id: 'R1', y: 200 }, { id: 'R2', y: 202 }],
      options,
    );
    const [first, second] = placements;
    expect(Math.abs(second.y - first.y)).toBeGreaterThanOrEqual(options.labelHeight);
    // The line stays on the real price: only the text slid.
    expect(first.anchorY).toBe(200);
    expect(second.anchorY).toBe(202);
  });

  it('spreads a dense cluster evenly and keeps every label inside the pane', () => {
    const placements = layoutLabelColumn(
      Array.from({ length: 6 }, (_, index) => ({ id: `L${index}`, y: 40 + index })),
      options,
    );
    expect(placements).toHaveLength(6);
    const sorted = [...placements].sort((left, right) => left.y - right.y);
    sorted.forEach((placement, index) => {
      if (index === 0) return;
      expect(placement.y - sorted[index - 1].y).toBeGreaterThanOrEqual(options.labelHeight - 1e-9);
    });
    placements.forEach((placement) => {
      expect(placement.y).toBeGreaterThanOrEqual(options.labelHeight / 2);
      expect(placement.y).toBeLessThanOrEqual(options.height - options.labelHeight / 2);
    });
    // Anchors are reported untouched — nothing here may edit a price.
    expect(placements.map((placement) => placement.anchorY)).toEqual([40, 41, 42, 43, 44, 45]);
  });

  it('fits six levels, current price and four EMAs in the minimum mobile price pane', () => {
    const mobile = { height: 200, labelHeight: 18 };
    const placements = layoutLabelColumn(
      ['R1', 'R2', 'R3', 'current', 'S1', 'S2', 'S3', 'ema20', 'ema50', 'ema100', 'ema200']
        .map((id, index) => ({ id, y: 90 + index })),
      mobile,
    );
    expect(placements).toHaveLength(11);
    const sorted = [...placements].sort((left, right) => left.y - right.y);
    sorted.forEach((placement, index) => {
      expect(placement.y).toBeGreaterThanOrEqual(mobile.labelHeight / 2);
      expect(placement.y).toBeLessThanOrEqual(mobile.height - mobile.labelHeight / 2);
      if (index > 0) {
        expect(placement.y - sorted[index - 1].y).toBeGreaterThanOrEqual(mobile.labelHeight);
      }
    });
  });

  it('pulls a cluster at the bottom edge back inside instead of drawing it off-pane', () => {
    const placements = layoutLabelColumn(
      [{ id: 'S1', y: 396 }, { id: 'S2', y: 398 }, { id: 'S3', y: 400 }],
      options,
    );
    placements.forEach((placement) => {
      expect(placement.y).toBeLessThanOrEqual(options.height - options.labelHeight / 2);
    });
    expect(placements.map((placement) => placement.anchorY)).toEqual([396, 398, 400]);
  });

  it('drops labels whose price is scrolled out of the pane', () => {
    const placements = layoutLabelColumn(
      [{ id: 'above', y: -12 }, { id: 'inside', y: 120 }, { id: 'below', y: 460 }],
      options,
    );
    expect(placements.map((placement) => placement.id)).toEqual(['inside']);
  });

  it('returns placements in input order with the index needed to zip them back', () => {
    const placements = layoutLabelColumn(
      [{ id: 'low', y: 300 }, { id: 'high', y: 100 }],
      options,
    );
    expect(placements.map((placement) => placement.id)).toEqual(['low', 'high']);
    expect(placements.map((placement) => placement.index)).toEqual([0, 1]);
  });

  it('is empty for an empty column', () => {
    expect(layoutLabelColumn([], options)).toEqual([]);
  });
});
