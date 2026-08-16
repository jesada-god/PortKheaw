/**
 * "สิ่งที่ควรรู้เร็ว ๆ นี้" — one list, three existing sources.
 *
 * Earnings dates come from the earnings calendar service, expiries from the
 * option ledger the portfolio already replayed, and alert proximity from the
 * price alerts the reader created. Nothing here polls, schedules, notifies or
 * stores: it is a read-only projection of state that already exists, which is
 * why it is a view model and not an events table.
 */

export type UpcomingEventKind = 'earnings' | 'option-expiry' | 'alert';

export interface UpcomingEventBase {
  /** Stable within one build, so React keys and tests can name a row. */
  id: string;
  kind: UpcomingEventKind;
  /** The instrument a reader would open from this row. */
  symbol: string;
  /**
   * Whole days until the event, or `null` for one that has no date at all —
   * an alert is "close", not "in four days".
   */
  days: number | null;
  /** Fully-formed Thai sentence. Built by the pure builder, never by the UI. */
  text: string;
}

export interface UpcomingEarningsEvent extends UpcomingEventBase {
  kind: 'earnings';
  days: number;
  reportDate: string;
}

export interface UpcomingExpiryEvent extends UpcomingEventBase {
  kind: 'option-expiry';
  days: number;
  contractSymbol: string;
  expirationDate: string;
}

export interface UpcomingAlertEvent extends UpcomingEventBase {
  kind: 'alert';
  days: null;
  /** How far the last accepted price still is from the target, in percent. */
  distancePercent: number;
}

export type UpcomingEvent = UpcomingEarningsEvent | UpcomingExpiryEvent | UpcomingAlertEvent;

export interface UpcomingFeed {
  events: UpcomingEvent[];
  /** Total count before the card's limit — what "ดูทั้งหมด X รายการ" says. */
  total: number;
}
