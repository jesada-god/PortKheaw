import type { EarningsSchedule } from '@/src/lib/analytics/earnings/types';
import type { MarketSignalResult } from '@/src/lib/analytics/market-signal/types';
import {
  MARKET_SIGNAL_STATUS,
  statusFromScore,
  type StatusLevel,
} from '@/src/lib/presentation/status';

/**
 * "สรุปหุ้นนี้" — the few facts a reader wants before they start reading tabs.
 *
 * Every row restates a value some existing canonical service already produced
 * for this page: the status rows come from the market-signal engine's own score
 * components, the nearest support and resistance from its support/resistance
 * calculation, and the report date from the earnings calendar service. This
 * module formats and orders them. It runs no technical analysis of its own.
 *
 * THE RULE THAT DECIDES WHICH ROWS EXIST, and the reason there are two status
 * rows rather than five.
 *
 * Phase 1 asked for แนวโน้ม, แรงส่ง, งบการเงิน, มูลค่าหุ้น and ความเสี่ยง. Two of
 * those have an engine behind them and three do not:
 *
 *  - แนวโน้ม and แรงส่ง are `scoreBreakdown.emaTrend` and
 *    `scoreBreakdown.momentum` — signed readings the market-signal engine
 *    published, on a scale it defined. Turning those into a status is what a
 *    status mapper is FOR.
 *  - มูลค่าหุ้น and ความเสี่ยง have no canonical service at all. Deciding that a
 *    P/E of 34 is "ค่อนข้างแพง" or that an ATR of 3.1% is "ความเสี่ยงสูง" would
 *    mean inventing the threshold here and printing the result as though
 *    something had measured it.
 *  - งบการเงิน is the case worth being explicit about, because it looks like it
 *    should qualify: `src/lib/analytics/fundamentals` is a real service and it
 *    is real data. But it publishes MEASUREMENTS — P/E, market cap, volume —
 *    and no verdict. "Are these financials good" is exactly the judgement
 *    nothing in this product makes, so the row would have the same invented
 *    threshold as มูลค่าหุ้น, dressed in a service's credibility.
 *
 * A row with no service is therefore not rendered at all. Not "—", not "N/A",
 * and not a locked placeholder: an absent row is the honest shape of an absent
 * measurement, and the three above are recorded in PLAN.md against the services
 * they are waiting on.
 */

/** Which existing tab answers a row, so tapping it goes somewhere real. */
export type StockSummaryTarget = 'Chart' | 'Financials' | 'Analysis';

export interface StockSummaryItem {
  id: string;
  text: string;
  target: StockSummaryTarget;
}

/** One "แนวโน้ม · 🟢 ขาขึ้น" line. */
export interface StockStatusRow {
  id: string;
  name: string;
  level: StatusLevel;
  label: string;
  target: StockSummaryTarget;
}

export interface StockSummaryView {
  /** แนวโน้ม and แรงส่ง, in that order. Empty without an entitled signal. */
  statuses: StockStatusRow[];
  /** Support, resistance and the next report date. */
  levels: StockSummaryItem[];
  /** The closing sentence, or `null` when there is no reading to close on. */
  closing: string | null;
}

/**
 * How near a level has to be before the closing line mentions it.
 *
 * Three percent of the current price. This is a PRESENTATION threshold on a
 * level the engine computed — it decides whether a sentence is worth printing,
 * never whether the level exists — which is the same kind of decision as the
 * score cut points and a different kind from inventing "ค่อนข้างแพง".
 */
const NEAR_LEVEL_PERCENT = 3;

/*
 * Where a component's −1…+1 reading sits on the shared 0–100 scale.
 *
 * The engine clamps every component to −1…+1 (`calculations.ts`), so the
 * rescale is exact and the cut points land symmetrically at ±0.4: beyond that
 * either way is a direction, inside it is a lean, and a reading of exactly zero
 * — no lean at all — is 🟡 ทรงตัว.
 */
const COMPONENT_THRESHOLDS = { good: 70, neutral: 50, weak: 30 } as const;

function componentStatus(normalizedScore: number | null | undefined): StatusLevel {
  if (normalizedScore === null || normalizedScore === undefined || !Number.isFinite(normalizedScore)) {
    return 'unknown';
  }
  return statusFromScore((normalizedScore + 1) / 2 * 100, COMPONENT_THRESHOLDS);
}

/** The words each row uses for each level. Four levels, four phrases, no scores. */
const TREND_LABEL: Readonly<Record<StatusLevel, string>> = {
  good: 'ขาขึ้น',
  neutral: 'ทรงตัว',
  weak: 'อ่อนแรง',
  bad: 'ขาลง',
  unknown: 'ยังไม่มีข้อมูล',
};

const MOMENTUM_LABEL: Readonly<Record<StatusLevel, string>> = {
  good: 'แข็งแรง',
  neutral: 'ปานกลาง',
  weak: 'อ่อนแรง',
  bad: 'อ่อนแอ',
  unknown: 'ยังไม่มีข้อมูล',
};

function formatLevel(value: number, currency: string | null): string {
  const formatted = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === 'USD' ? `$${formatted}` : `${formatted}${currency ? ` ${currency}` : ''}`;
}

function distancePercent(level: number, price: number | null): number | null {
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  return Math.abs(level - price) / price * 100;
}

function distanceText(level: number, price: number | null): string {
  const percent = distancePercent(level, price);
  return percent === null ? '' : ` · ห่างจากราคาปัจจุบัน ${percent.toFixed(1)}%`;
}

/**
 * The sentence that closes the block — "ยังเป็นขาขึ้น แต่ราคาใกล้แนวต้าน".
 *
 * Two clauses at most, and both restate something already on the screen: the
 * card's own state, and whichever level the price is standing near. It never
 * adds a third clause, never says what to do, and returns `null` rather than
 * padding when there is no reading to open with — a closing line with nothing
 * to close is the "AI summary" this page is written to not have.
 */
function buildClosing(
  marketSignal: MarketSignalResult | null,
  price: number | null,
): string | null {
  if (!marketSignal || marketSignal.status !== 'available') return null;
  const level = MARKET_SIGNAL_STATUS[marketSignal.state];
  const direction = level === 'good' ? 'ยังเป็นขาขึ้น'
    : level === 'bad' ? 'ยังเป็นขาลง'
      : level === 'weak' ? 'แนวโน้มเริ่มอ่อนแรง'
        : 'ยังไม่มีทิศทางชัดเจน';

  const support = marketSignal.metrics.nearestSupport ?? null;
  const resistance = marketSignal.metrics.nearestResistance ?? null;
  /*
   * Resistance is checked first and only one clause is ever added. Price near
   * both edges at once happens on a narrow range, and naming both would produce
   * "ใกล้แนวต้าน และใกล้แนวรับ" — a sentence that cancels itself out.
   */
  const nearResistance = resistance !== null
    && Number.isFinite(resistance)
    && (price === null || resistance >= price)
    && (distancePercent(resistance, price) ?? Number.POSITIVE_INFINITY) <= NEAR_LEVEL_PERCENT;
  if (nearResistance) return `${direction} แต่ราคาใกล้แนวต้าน`;

  const nearSupport = support !== null
    && Number.isFinite(support)
    && (price === null || support <= price)
    && (distancePercent(support, price) ?? Number.POSITIVE_INFINITY) <= NEAR_LEVEL_PERCENT;
  if (nearSupport) return `${direction} และราคาใกล้แนวรับ`;

  return direction;
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
  /** Elite-gated; `null` for a reader without it, which drops every signal row. */
  marketSignal: MarketSignalResult | null;
  /** `null` when the calendar was not asked, or answered unavailable. */
  earnings: EarningsSchedule | null;
}): StockSummaryView {
  const statuses: StockStatusRow[] = [];
  const available = marketSignal?.status === 'available' ? marketSignal : null;

  /*
   * A reader without the entitlement sees no status rows, rather than two rows
   * wearing padlocks. The page already has one locked surface — the technical
   * outlook card in Financials names the plan and opens the prompt — and a
   * second one at the top of every stock page would be advertising where the
   * reader came to read.
   */
  if (available) {
    for (const [id, name, component, labels] of [
      ['trend', 'แนวโน้ม', available.scoreBreakdown.emaTrend, TREND_LABEL],
      ['momentum', 'แรงส่ง', available.scoreBreakdown.momentum, MOMENTUM_LABEL],
    ] as const) {
      // A component the engine could not compute is dropped, not shown as ⚪:
      // the row is a reading, and there is no reading here to report.
      if (!component.available) continue;
      const level = componentStatus(component.normalizedScore);
      if (level === 'unknown') continue;
      statuses.push({ id, name, level, label: labels[level], target: 'Financials' });
    }
  }

  const levels: StockSummaryItem[] = [];
  const support = available?.metrics.nearestSupport ?? null;
  const resistance = available?.metrics.nearestResistance ?? null;

  /*
   * A level is only shown on the side it belongs on. The engine reports the
   * nearest zone of each kind, and a "support" printed above the current price
   * would be describing a level the price has already broken — truthful as a
   * zone, misleading as a summary line.
   */
  if (support !== null && Number.isFinite(support) && (price === null || support <= price)) {
    levels.push({
      id: 'support',
      text: `แนวรับใกล้ที่สุด ${formatLevel(support, currency)}${distanceText(support, price)}`,
      target: 'Chart',
    });
  }
  if (resistance !== null && Number.isFinite(resistance) && (price === null || resistance >= price)) {
    levels.push({
      id: 'resistance',
      text: `แนวต้านใกล้ที่สุด ${formatLevel(resistance, currency)}${distanceText(resistance, price)}`,
      target: 'Chart',
    });
  }
  if (earnings?.status === 'available' && Number.isFinite(earnings.daysToEarnings) && earnings.daysToEarnings >= 0) {
    levels.push({
      id: 'earnings',
      text: earnings.daysToEarnings === 0
        ? `ประกาศผลประกอบการวันนี้ (${earnings.reportDate})`
        : `ผลประกอบการครั้งถัดไปในอีก ${earnings.daysToEarnings} วัน (${earnings.reportDate})`,
      target: 'Financials',
    });
  }

  return { statuses, levels, closing: buildClosing(available, price) };
}
