import { describe, expect, it } from 'vitest';
import { buildInstitutionalOverlaySpec, volumeProfileHistogram } from './overlay-spec';
import { calculateVisibleRangeVolumeProfile, type VrvpInputCandle } from './visible-range-profile';
import { volumeProfileConfirmation } from '@/src/components/stock/chart/technical/SupportResistancePanel';

const DAY = 86_400_000;

/** A distribution with a clear peak around 100 and thin tails. */
function candles(count = 120): VrvpInputCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const centre = 100 + Math.sin(index / 9) * 6;
    return {
      date: new Date(Date.UTC(2026, 0, 5) + index * DAY).toISOString(),
      open: centre - 0.4,
      high: centre + 1,
      low: centre - 1,
      close: centre + 0.4,
      // Heavy volume only near the middle of the swing, so the POC is decisive.
      volume: Math.abs(centre - 100) < 1.5 ? 10_000 : 500,
    };
  });
}

describe('visible-range volume profile → histogram spec', () => {
  const profile = calculateVisibleRangeVolumeProfile(candles());

  it('produces a bin for every profile bin, each normalized into [0, 1]', () => {
    if (profile.status !== 'available') throw new Error('fixture should produce a profile');
    const histogram = volumeProfileHistogram(profile);
    expect(histogram?.bars).toHaveLength(profile.profile.length);
    histogram?.bars.forEach((bar) => {
      expect(bar.ratio).toBeGreaterThanOrEqual(0);
      expect(bar.ratio).toBeLessThanOrEqual(1);
      expect(bar.priceHigh).toBeGreaterThan(bar.priceLow);
    });
  });

  it('marks exactly one bar as the point of control', () => {
    const histogram = volumeProfileHistogram(profile);
    expect(histogram?.bars.filter((bar) => bar.kind === 'poc')).toHaveLength(1);
    const poc = histogram?.bars.find((bar) => bar.kind === 'poc');
    expect(poc?.ratio).toBe(1);
  });

  it('places the value area between VAL and VAH', () => {
    if (profile.status !== 'available') throw new Error('fixture should produce a profile');
    const histogram = volumeProfileHistogram(profile);
    histogram?.bars.filter((bar) => bar.kind === 'value-area').forEach((bar) => {
      expect(bar.priceHigh).toBeGreaterThan(profile.val);
      expect(bar.priceLow).toBeLessThan(profile.vah);
    });
    expect(profile.vah).toBeGreaterThan(profile.val);
    expect(profile.poc).toBeGreaterThanOrEqual(profile.val);
    expect(profile.poc).toBeLessThanOrEqual(profile.vah);
  });

  it('uses only the visible slice, so a narrower viewport gives a narrower profile', () => {
    const all = calculateVisibleRangeVolumeProfile(candles());
    const slice = calculateVisibleRangeVolumeProfile(candles().slice(0, 20));
    if (all.status !== 'available' || slice.status !== 'available') throw new Error('expected profiles');
    expect(slice.candleCount).toBe(20);
    expect(all.candleCount).toBe(120);
    expect(slice.totalVolume).toBeLessThan(all.totalVolume);
  });

  it('allocates each candle exactly once — the total never exceeds the input volume', () => {
    const input = candles();
    if (profile.status !== 'available') throw new Error('expected a profile');
    const inputTotal = input.reduce((sum, candle) => sum + (candle.volume ?? 0), 0);
    const binTotal = profile.profile.reduce((sum, bin) => sum + bin.volume, 0);
    expect(binTotal).toBeCloseTo(inputTotal, 6);
    expect(profile.totalVolume).toBeCloseTo(inputTotal, 6);
  });

  it('is absent when the profile could not be computed', () => {
    const empty = calculateVisibleRangeVolumeProfile([]);
    expect(volumeProfileHistogram(empty)).toBeUndefined();
    expect(empty.status).toBe('unavailable');
  });

  it('is only attached to the overlay spec when the VPVR toggle asks for it', () => {
    const withHistogram = buildInstitutionalOverlaySpec({
      showZones: false, profile, showVolumeProfile: true, showAnchoredVwap: false, showVolumeProfileHistogram: true,
    });
    const withoutHistogram = buildInstitutionalOverlaySpec({
      showZones: false, profile, showVolumeProfile: true, showAnchoredVwap: false, showVolumeProfileHistogram: false,
    });
    expect(withHistogram.histogram?.bars.length).toBeGreaterThan(0);
    expect(withoutHistogram.histogram).toBeUndefined();
    // The POC/VAH/VAL reference lines are independent of the histogram.
    expect(withoutHistogram.lines.map((line) => line.id)).toEqual(['vrvp-poc', 'vrvp-vah', 'vrvp-val']);
  });
});

describe('VPVR as a confirmation layer only', () => {
  const profile = calculateVisibleRangeVolumeProfile(candles());

  it('grades a level by the traded volume sitting at it', () => {
    if (profile.status !== 'available') throw new Error('expected a profile');
    expect(volumeProfileConfirmation(profile, profile.poc)).toBe('strong');
    const thinPrice = profile.profile[0].midpoint;
    expect(['weak', 'moderate', 'strong']).toContain(volumeProfileConfirmation(profile, thinPrice));
  });

  it('returns no grade for a price outside the profile or with no profile at all', () => {
    expect(volumeProfileConfirmation(profile, 10_000)).toBeNull();
    expect(volumeProfileConfirmation(undefined, 100)).toBeNull();
    expect(volumeProfileConfirmation(calculateVisibleRangeVolumeProfile([]), 100)).toBeNull();
  });
});
