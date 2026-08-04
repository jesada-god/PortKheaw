import { describe, expect, it } from 'vitest';
import {
  clampTooltipCenter,
  isWithinSlop,
  resolveSlotIndex,
  LONG_PRESS_MS,
  MOVE_SLOP,
  RELEASE_SLACK,
  TOOLTIP_MARGIN,
  type DockGeometry,
} from './dock-gesture';

/** A 296px capsule at the bottom of a 320px viewport, five equal slots. */
function geometry(): DockGeometry {
  const dock = { left: 12, right: 308, top: 646, bottom: 708, width: 296 };
  const inner = dock.left + 6;
  const slotWidth = 54.4;
  const slots = Array.from({ length: 5 }, (_, index) => {
    const left = inner + index * (slotWidth + 3);
    return { left, right: left + slotWidth, top: dock.top + 6, bottom: dock.bottom - 6, width: slotWidth };
  });
  return { dock, slots };
}

const centerOf = (index: number) => {
  const slot = geometry().slots[index];
  return slot.left + slot.width / 2;
};

describe('long-press thresholds', () => {
  it('holds the press window inside the 250-350ms the design asks for', () => {
    expect(LONG_PRESS_MS).toBeGreaterThanOrEqual(250);
    expect(LONG_PRESS_MS).toBeLessThanOrEqual(350);
  });

  it('treats small drift as a hold and anything larger as a scroll', () => {
    expect(isWithinSlop(0, 0)).toBe(true);
    expect(isWithinSlop(MOVE_SLOP, MOVE_SLOP)).toBe(true);
    expect(isWithinSlop(0, MOVE_SLOP + 1)).toBe(false);
    expect(isWithinSlop(-(MOVE_SLOP + 1), 0)).toBe(false);
  });
});

describe('resolveSlotIndex', () => {
  it('resolves each icon centre to its own destination', () => {
    const dock = geometry();
    for (let index = 0; index < 5; index += 1) {
      expect(resolveSlotIndex(centerOf(index), dock.dock.top + 30, dock)).toBe(index);
    }
  });

  it('gives the gap between two icons to the nearer of them', () => {
    const dock = geometry();
    const y = dock.dock.top + 30;
    const gapStart = dock.slots[1].right;
    const gapEnd = dock.slots[2].left;
    expect(resolveSlotIndex(gapStart + 0.4, y, dock)).toBe(1);
    expect(resolveSlotIndex(gapEnd - 0.4, y, dock)).toBe(2);
  });

  it('still resolves a finger that drifts a little off the capsule', () => {
    const dock = geometry();
    expect(resolveSlotIndex(centerOf(2), dock.dock.top - RELEASE_SLACK + 1, dock)).toBe(2);
    expect(resolveSlotIndex(centerOf(2), dock.dock.bottom + RELEASE_SLACK - 1, dock)).toBe(2);
  });

  it('returns nothing once the pointer has genuinely left the dock', () => {
    const dock = geometry();
    const y = dock.dock.top + 30;
    // Above it, below it, and off either end.
    expect(resolveSlotIndex(centerOf(2), dock.dock.top - RELEASE_SLACK - 1, dock)).toBeNull();
    expect(resolveSlotIndex(centerOf(2), dock.dock.bottom + RELEASE_SLACK + 1, dock)).toBeNull();
    expect(resolveSlotIndex(dock.dock.left - RELEASE_SLACK - 1, y, dock)).toBeNull();
    expect(resolveSlotIndex(dock.dock.right + RELEASE_SLACK + 1, y, dock)).toBeNull();
  });

  it('resolves nothing at all when there are no slots to choose between', () => {
    const dock = geometry();
    expect(resolveSlotIndex(centerOf(0), dock.dock.top + 30, { dock: dock.dock, slots: [] })).toBeNull();
  });
});

describe('clampTooltipCenter', () => {
  const TRACK = 296;
  const TIP = 96;

  it('leaves a tooltip that already fits exactly where its icon is', () => {
    expect(clampTooltipCenter(148, TIP, TRACK)).toBe(148);
  });

  it('pulls the first and last icons inward so neither end leaves the capsule', () => {
    const first = clampTooltipCenter(27, TIP, TRACK);
    expect(first - TIP / 2).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);

    const last = clampTooltipCenter(269, TIP, TRACK);
    expect(last + TIP / 2).toBeLessThanOrEqual(TRACK - TOOLTIP_MARGIN);
  });

  it('centres a tooltip too wide to fit rather than pushing one end off', () => {
    expect(clampTooltipCenter(27, TRACK + 40, TRACK)).toBe(TRACK / 2);
  });

  it('does not clamp against a width it has not measured yet', () => {
    // jsdom and the first paint both report 0; guessing a bound there would move
    // the tooltip somewhere it does not belong.
    expect(clampTooltipCenter(27, 0, TRACK)).toBe(27);
    expect(clampTooltipCenter(27, TIP, 0)).toBe(27);
  });
});
