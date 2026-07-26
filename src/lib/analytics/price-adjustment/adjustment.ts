/**
 * Truthful raw/adjusted price provenance for the chart.
 *
 * The split/dividend math itself is *not* re-implemented here: the verified
 * factor methodology lives in `market-data/candles/normalize.ts#applyAdjustment`
 * (factor = providerAdjustedClose / rawClose, applied to O/H/L, with the
 * provider's adjusted close kept verbatim) and Polygon returns already-adjusted
 * aggregates when `adjusted=true`. What was missing — and what caused the
 * "Historical prices are unadjusted" warning to read as a defect — is a single
 * place that reports which mode the displayed series is actually in.
 *
 * Rules enforced here:
 *  - a series is `adjusted` only when the provider confirmed it; a request for
 *    adjusted data that the provider could not honour reports `raw`,
 *  - intraday candles are raw market prints by design, never claimed adjusted,
 *  - one series is never a mixture: the mode describes the whole series.
 */

import type { CandleInterval } from '@/src/lib/market-data/candles/contracts';

export type PriceAdjustmentMode = 'raw' | 'adjusted';

export interface PriceAdjustmentMeta {
  mode: PriceAdjustmentMode;
  source: string;
  /** Beginner-Thai explanation of exactly what is on screen. */
  label: string;
  /** Present when adjusted data was requested but could not be served. */
  downgradeReason: string | null;
}

/** Intervals for which corporate-action adjustment is meaningful. */
export const ADJUSTABLE_INTERVALS: readonly CandleInterval[] = ['1D', 'Week', 'Month'];

export function isAdjustableInterval(interval: CandleInterval): boolean {
  return ADJUSTABLE_INTERVALS.includes(interval);
}

export function resolvePriceAdjustment(input: {
  interval: CandleInterval;
  /** What the UI asked the provider for. */
  requested: boolean;
  /** What the provider says it actually returned. */
  providerAdjusted: boolean;
  source: string;
}): PriceAdjustmentMeta {
  if (!isAdjustableInterval(input.interval)) {
    return {
      mode: 'raw',
      source: input.source,
      label: 'ราคาดิบระหว่างวัน (ไม่ปรับ split/ปันผล)',
      downgradeReason: input.requested
        ? 'แท่งเทียนระหว่างวันใช้ราคาซื้อขายจริงของช่วงนั้น จึงไม่ปรับ split/ปันผล'
        : null,
    };
  }
  if (input.providerAdjusted) {
    return {
      mode: 'adjusted',
      source: input.source,
      label: 'ปรับ split และปันผลแล้ว',
      downgradeReason: null,
    };
  }
  return {
    mode: 'raw',
    source: input.source,
    label: 'ราคาดิบ ยังไม่ปรับ split และปันผล',
    downgradeReason: input.requested
      ? 'ผู้ให้บริการไม่ได้ส่งข้อมูลที่ปรับ split/ปันผลสำหรับช่วงนี้ ระบบจึงแสดงราคาดิบตามจริง'
      : null,
  };
}

/**
 * The corporate-action factor for one bar. Exposed so a split fixture can assert
 * the ratio directly; the O/H/L application itself stays in the shared
 * provider-side `applyAdjustment`.
 */
export function adjustmentFactor(rawClose: number, adjustedClose: number | undefined): number | null {
  if (adjustedClose === undefined || !Number.isFinite(adjustedClose) || !Number.isFinite(rawClose) || rawClose === 0) return null;
  const factor = adjustedClose / rawClose;
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}
