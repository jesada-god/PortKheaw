import { describe, expect, it } from 'vitest';
import { calculateUpsideDownsidePct, positiveFinite } from './calculations';

describe('analyst target calculations', () => {
  it('keeps full precision for upside and downside', () => {
    expect(calculateUpsideDownsidePct(125, 100)).toBe(25);
    expect(calculateUpsideDownsidePct(75, 100)).toBe(-25);
    expect(calculateUpsideDownsidePct(100, 30)).toBeCloseTo(233.33333333333334);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined])(
    'rejects invalid current prices (%s)',
    (currentPrice) => {
      expect(calculateUpsideDownsidePct(100, currentPrice)).toBeNull();
    },
  );

  it('accepts only finite positive numbers', () => {
    expect(positiveFinite(1)).toBe(1);
    expect(positiveFinite('1')).toBeNull();
    expect(positiveFinite(0)).toBeNull();
  });
});
