import { describeCondition } from '@/src/lib/alerts/logic';
import type { AlertCondition } from '@/src/lib/alerts/types';
import type { OptionPositionSummary } from '@/src/lib/portfolio/options/types';
import type { EarningsSchedule } from '@/src/lib/analytics/earnings/types';
import type { UpcomingAlertEvent, UpcomingEarningsEvent, UpcomingEvent, UpcomingExpiryEvent, UpcomingFeed } from './types';

/** How far ahead a dated event is still "เร็ว ๆ นี้". */
export const UPCOMING_HORIZON_DAYS = 30;
/** How close a price has to get before an alert is worth mentioning. */
export const NEAR_ALERT_PERCENT = 5;
/** How many rows the summary card shows before it defers to the full list. */
export const UPCOMING_CARD_LIMIT = 3;

export interface UpcomingAlertInput {
  id: string;
  symbol: string;
  condition: AlertCondition;
  targetValue: number;
  enabled: boolean;
  /** The last accepted price for the symbol, or null when there is none. */
  price: number | null;
  /** Today's percent change, needed only by the percent-change conditions. */
  changePercent: number | null;
}

export interface UpcomingExpiryInput {
  position: OptionPositionSummary;
}

/**
 * How far a price still has to travel to satisfy an alert, as a percentage of
 * where it is now. `null` whenever the question cannot be answered honestly:
 * no price, a nonsensical target, or a condition that is already met — an alert
 * that has fired is history, not something coming up.
 */
export function alertDistancePercent(input: UpcomingAlertInput): number | null {
  if (!input.enabled) return null;
  if (!Number.isFinite(input.targetValue) || input.targetValue <= 0) return null;
  if (input.condition === 'percent_change_up' || input.condition === 'percent_change_down') {
    if (input.changePercent === null || !Number.isFinite(input.changePercent)) return null;
    const travelled = input.condition === 'percent_change_up' ? input.changePercent : -input.changePercent;
    const remaining = input.targetValue - travelled;
    return remaining <= 0 ? null : remaining;
  }
  if (input.price === null || !Number.isFinite(input.price) || input.price <= 0) return null;
  const remaining = input.condition === 'above'
    ? input.targetValue - input.price
    : input.price - input.targetValue;
  if (remaining <= 0) return null;
  return remaining / input.price * 100;
}

function earningsEvent(schedule: EarningsSchedule): UpcomingEarningsEvent | null {
  if (schedule.status !== 'available') return null;
  if (!Number.isFinite(schedule.daysToEarnings) || schedule.daysToEarnings < 0) return null;
  if (schedule.daysToEarnings > UPCOMING_HORIZON_DAYS) return null;
  return {
    id: `earnings:${schedule.symbol}:${schedule.reportDate}`,
    kind: 'earnings',
    symbol: schedule.symbol,
    days: schedule.daysToEarnings,
    reportDate: schedule.reportDate,
    text: schedule.daysToEarnings === 0
      ? `${schedule.symbol} · ประกาศผลประกอบการวันนี้`
      : `${schedule.symbol} · ประกาศผลประกอบการในอีก ${schedule.daysToEarnings} วัน`,
  };
}

function expiryEvent(position: OptionPositionSummary): UpcomingExpiryEvent | null {
  if (position.status !== 'open') return null;
  if (!Number.isFinite(position.dte) || position.dte < 0) return null;
  if (position.dte > UPCOMING_HORIZON_DAYS) return null;
  const kind = position.optionKind === 'call' ? 'Call' : 'Put';
  return {
    id: `expiry:${position.key}`,
    kind: 'option-expiry',
    symbol: position.underlyingSymbol,
    days: position.dte,
    contractSymbol: position.contractSymbol,
    expirationDate: position.expirationDate,
    text: position.dte === 0
      ? `${position.underlyingSymbol} ${kind} · หมดอายุวันนี้`
      : `${position.underlyingSymbol} ${kind} · หมดอายุในอีก ${position.dte} วัน`,
  };
}

function alertEvent(input: UpcomingAlertInput): UpcomingAlertEvent | null {
  const distancePercent = alertDistancePercent(input);
  if (distancePercent === null || distancePercent > NEAR_ALERT_PERCENT) return null;
  return {
    id: `alert:${input.id}`,
    kind: 'alert',
    symbol: input.symbol,
    days: null,
    distancePercent,
    text: `${input.symbol} · ราคาเข้าใกล้การแจ้งเตือนที่ตั้งไว้ (${describeCondition(input.condition, input.targetValue)})`,
  };
}

/**
 * Everything worth knowing soon, in the order a reader would want it.
 *
 * Dated events come first, soonest first, because a date is a deadline. An
 * alert has no date — it is a price that has crept close — so it sorts after
 * them, nearest first. Ties break on the row id so the list is stable across
 * renders and across the server/client boundary.
 */
export function buildUpcomingFeed({
  earnings = [],
  positions = [],
  alerts = [],
  limit,
}: {
  earnings?: readonly EarningsSchedule[];
  positions?: readonly OptionPositionSummary[];
  alerts?: readonly UpcomingAlertInput[];
  /** Applied after ordering. Omit to keep every event. */
  limit?: number;
}): UpcomingFeed {
  const events: UpcomingEvent[] = [
    ...earnings.map(earningsEvent),
    ...positions.map(expiryEvent),
    ...alerts.map(alertEvent),
  ].filter((event): event is UpcomingEvent => event !== null);

  events.sort((left, right) => {
    if (left.days !== null && right.days !== null) {
      return left.days - right.days || left.id.localeCompare(right.id);
    }
    if (left.days !== null) return -1;
    if (right.days !== null) return 1;
    return (left as UpcomingAlertEvent).distancePercent - (right as UpcomingAlertEvent).distancePercent
      || left.id.localeCompare(right.id);
  });

  return {
    total: events.length,
    events: limit === undefined ? events : events.slice(0, Math.max(0, limit)),
  };
}
