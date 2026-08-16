import type { EarningsSchedule } from '@/src/lib/analytics/earnings/types';
import type { MarketSignalResult } from '@/src/lib/analytics/market-signal/types';

/**
 * "สรุปหุ้นนี้" — the few facts a reader wants before they start reading tabs.
 *
 * Every row restates a value some existing canonical service already produced
 * for this page: the nearest support and resistance come from the market-signal
 * engine's own support/resistance calculation, and the report date comes from
 * the earnings calendar service. This module formats and orders them. It runs no
 * technical analysis of its own, and it deliberately carries no valuation or
 * 52-week row: PortKheaw has no canonical service for either, and the rule is
 * omit rather than guess.
 */

/** Which existing tab answers a row, so tapping it goes somewhere real. */
export type StockSummaryTarget = 'Chart' | 'Financials' | 'Analysis';

export interface StockSummaryItem {
  id: string;
  text: string;
  target: StockSummaryTarget;
}

function formatLevel(value: number, currency: string | null): string {
  const formatted = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === 'USD' ? `$${formatted}` : `${formatted}${currency ? ` ${currency}` : ''}`;
}

function distanceText(level: number, price: number | null): string {
  if (price === null || !Number.isFinite(price) || price <= 0) return '';
  const percent = Math.abs(level - price) / price * 100;
  return ` · ห่างจากราคาปัจจุบัน ${percent.toFixed(1)}%`;
}

export function buildStockSummary({
  price,
  currency,
  marketSignal,
  earnings,
}: {
  /** The accepted price the header is showing. Never a second quote read. */
  price: number | null;
  currency: string | null;
  /** Elite-gated; `null` for a reader without it, which drops the level rows. */
  marketSignal: MarketSignalResult | null;
  /** `null` when the calendar was not asked, or answered unavailable. */
  earnings: EarningsSchedule | null;
}): StockSummaryItem[] {
  const items: StockSummaryItem[] = [];
  const support = marketSignal?.metrics.nearestSupport ?? null;
  const resistance = marketSignal?.metrics.nearestResistance ?? null;

  /*
   * A level is only shown on the side it belongs on. The engine reports the
   * nearest zone of each kind, and a "support" printed above the current price
   * would be describing a level the price has already broken — truthful as a
   * zone, misleading as a summary line.
   */
  if (support !== null && Number.isFinite(support) && (price === null || support <= price)) {
    items.push({
      id: 'support',
      text: `แนวรับใกล้ที่สุด ${formatLevel(support, currency)}${distanceText(support, price)}`,
      target: 'Chart',
    });
  }
  if (resistance !== null && Number.isFinite(resistance) && (price === null || resistance >= price)) {
    items.push({
      id: 'resistance',
      text: `แนวต้านใกล้ที่สุด ${formatLevel(resistance, currency)}${distanceText(resistance, price)}`,
      target: 'Chart',
    });
  }
  if (earnings?.status === 'available' && Number.isFinite(earnings.daysToEarnings) && earnings.daysToEarnings >= 0) {
    items.push({
      id: 'earnings',
      text: earnings.daysToEarnings === 0
        ? `ประกาศผลประกอบการวันนี้ (${earnings.reportDate})`
        : `ผลประกอบการครั้งถัดไปในอีก ${earnings.daysToEarnings} วัน (${earnings.reportDate})`,
      target: 'Financials',
    });
  }
  return items;
}
