import { describe, expect, it } from 'vitest';
import { ANCHORED_PANEL_GAP as GAP, resolveAnchoredPanel } from './anchored-panel';

const rect = (top: number, left: number, height = 44, width = 96) => ({
  top, left, bottom: top + height, right: left + width,
});

const base = {
  viewportWidth: 1440,
  viewportHeight: 900,
  width: 288,
  preferredMaxHeight: 520,
};

describe('resolveAnchoredPanel', () => {
  it('opens below the trigger and never taller than the room that exists', () => {
    const placement = resolveAnchoredPanel({ ...base, rect: rect(120, 200) });
    expect(placement.top).toBe(120 + 44 + GAP);
    expect(placement.left).toBe(200);
    expect(placement.maxHeight).toBeLessThanOrEqual(900 - placement.top - GAP + 1);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(900);
  });

  it('flips above the trigger when below is cramped and above is roomier', () => {
    const placement = resolveAnchoredPanel({ ...base, rect: rect(700, 200) });
    expect(placement.top).toBeLessThan(700);
    expect(placement.top).toBeGreaterThanOrEqual(GAP);
  });

  it('keeps the panel inside the viewport even when neither side has room', () => {
    const placement = resolveAnchoredPanel({ ...base, viewportHeight: 240, rect: rect(90, 200) });
    expect(placement.top).toBeGreaterThanOrEqual(GAP);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(240 - GAP + 0.001);
    // Capped rather than clipped, so the list can still scroll internally.
    expect(placement.maxHeight).toBeGreaterThan(0);
  });

  it('clamps the left edge so a trigger near the right edge cannot push the panel off-screen', () => {
    const placement = resolveAnchoredPanel({ ...base, rect: rect(120, 1400) });
    expect(placement.left + placement.width).toBeLessThanOrEqual(1440 - GAP);
    expect(placement.left).toBeGreaterThanOrEqual(GAP);
  });

  it('keeps its preferred width inside a phone viewport that can still hold it', () => {
    const placement = resolveAnchoredPanel({ ...base, viewportWidth: 390, rect: rect(120, 300) });
    expect(placement.width).toBe(288);
    expect(placement.left + placement.width).toBeLessThanOrEqual(390 - GAP);
  });

  it('shrinks the panel instead of overflowing a viewport narrower than its preferred width', () => {
    const placement = resolveAnchoredPanel({ ...base, viewportWidth: 280, rect: rect(120, 200) });
    expect(placement.width).toBe(280 - GAP * 2);
    expect(placement.left).toBe(GAP);
    expect(placement.left + placement.width).toBeLessThanOrEqual(280 - GAP);
  });

  it('aligns to the trigger end when asked, still inside the viewport', () => {
    const placement = resolveAnchoredPanel({ ...base, align: 'end', rect: rect(120, 900, 44, 120) });
    expect(placement.left + placement.width).toBe(900 + 120);
  });

  it('never returns a negative or NaN geometry for a degenerate viewport', () => {
    const placement = resolveAnchoredPanel({ ...base, viewportWidth: 0, viewportHeight: 0, rect: rect(0, 0) });
    for (const value of Object.values(placement)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
