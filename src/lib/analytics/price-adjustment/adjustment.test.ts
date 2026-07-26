import { describe, expect, it } from 'vitest';
import { adjustmentFactor, isAdjustableInterval, resolvePriceAdjustment } from './adjustment';
import { applyAdjustment } from '@/src/lib/market-data/candles/normalize';

describe('price adjustment provenance', () => {
  it('reports adjusted only when the provider confirms it', () => {
    const meta = resolvePriceAdjustment({ interval: '1D', requested: true, providerAdjusted: true, source: 'polygon' });
    expect(meta.mode).toBe('adjusted');
    expect(meta.downgradeReason).toBeNull();
    expect(meta.label).toContain('ปรับ split');
  });

  it('reports raw — and says why — when adjusted data was asked for but not served', () => {
    const meta = resolvePriceAdjustment({ interval: '1D', requested: true, providerAdjusted: false, source: 'polygon' });
    expect(meta.mode).toBe('raw');
    expect(meta.downgradeReason).toContain('ไม่ได้ส่งข้อมูลที่ปรับ');
  });

  it('never claims intraday candles are adjusted', () => {
    for (const interval of ['1m', '5m', '45m', '3h', '4h'] as const) {
      const meta = resolvePriceAdjustment({ interval, requested: true, providerAdjusted: true, source: 'polygon' });
      expect(meta.mode).toBe('raw');
      expect(isAdjustableInterval(interval)).toBe(false);
    }
  });

  it('treats daily, weekly and monthly as the adjustable intervals', () => {
    for (const interval of ['1D', 'Week', 'Month'] as const) {
      expect(isAdjustableInterval(interval)).toBe(true);
    }
  });

  it('describes a plain unadjusted daily series without pretending it is adjusted', () => {
    const meta = resolvePriceAdjustment({ interval: '1D', requested: false, providerAdjusted: false, source: 'polygon' });
    expect(meta.mode).toBe('raw');
    expect(meta.label).toContain('ยังไม่ปรับ');
    expect(meta.downgradeReason).toBeNull();
  });
});

describe('corporate-action factor', () => {
  it('is adjustedClose ÷ rawClose', () => {
    expect(adjustmentFactor(200, 100)).toBeCloseTo(0.5, 10);
    expect(adjustmentFactor(100, 100)).toBe(1);
  });

  it('is null when the provider gave no adjusted close', () => {
    expect(adjustmentFactor(100, undefined)).toBeNull();
    expect(adjustmentFactor(0, 100)).toBeNull();
  });

  it('scales O/H/L by the factor and keeps the provider adjusted close verbatim', () => {
    // A 2-for-1 split fixture: the pre-split bar must halve without a price cliff.
    const raw = { timestamp: 1_767_600_000, open: 200, high: 210, low: 190, close: 204, adjustedClose: 102, volume: 1_000 };
    const adjusted = applyAdjustment(raw);
    const factor = adjustmentFactor(raw.close, raw.adjustedClose) as number;
    expect(factor).toBeCloseTo(0.5, 10);
    expect(adjusted.open).toBeCloseTo(200 * factor, 10);
    expect(adjusted.high).toBeCloseTo(210 * factor, 10);
    expect(adjusted.low).toBeCloseTo(190 * factor, 10);
    expect(adjusted.close).toBe(102);
    // The bar stays internally consistent — no fabricated gap between O/H/L/C.
    expect(adjusted.high).toBeGreaterThanOrEqual(Math.max(adjusted.open, adjusted.close, adjusted.low));
    expect(adjusted.low).toBeLessThanOrEqual(Math.min(adjusted.open, adjusted.close, adjusted.high));
  });

  it('leaves a bar untouched when the provider supplied no adjusted close', () => {
    const raw = { timestamp: 1_767_600_000, open: 200, high: 210, low: 190, close: 204, volume: 1_000 };
    expect(applyAdjustment(raw)).toEqual(raw);
  });

  it('keeps a split-adjusted daily series free of a fabricated cliff', () => {
    // Pre-split bars carry adjustedClose at half; post-split bars are already adjusted.
    const series = [
      { timestamp: 1, open: 200, high: 202, low: 198, close: 200, adjustedClose: 100, volume: 10 },
      { timestamp: 2, open: 202, high: 206, low: 200, close: 204, adjustedClose: 102, volume: 10 },
      { timestamp: 3, open: 102, high: 104, low: 101, close: 103, volume: 10 },
    ].map(applyAdjustment);
    const steps = series.slice(1).map((bar, index) => Math.abs(bar.close - series[index].close) / series[index].close);
    // Every day-over-day move stays small; a raw series would show a ~50% cliff.
    steps.forEach((step) => expect(step).toBeLessThan(0.1));
  });
});
