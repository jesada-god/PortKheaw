import { isUsMarketHoliday } from './us-market-calendar';
import { zonedParts } from './session';

/**
 * The CME Globex trading week, for the commodity cards.
 *
 * ===========================================================================
 * Why neither of the two session models already here would do
 * ===========================================================================
 *
 * The app knew two kinds of market. The US equity session has an opening bell,
 * a close, and pre/post windows around it; using it for gold would report the
 * metal as closed from 16:00 New York, when COMEX is in fact trading, and would
 * invent a pre-market that does not exist. The continuous model ("ซื้อขายตลอด
 * 24 ชม.") is right for a crypto pair and wrong here in the other direction: a
 * futures market has a weekend and a daily maintenance halt, so a card claiming
 * 24/7 would report an open market on a Saturday afternoon.
 *
 * Globex, in exchange-local time (America/Chicago), for the metals and energy
 * contracts this product quotes:
 *
 *   * The week opens Sunday 17:00 CT and closes Friday 16:00 CT.
 *   * Monday through Thursday there is a 60-minute halt, 16:00–17:00 CT, between
 *     one trading day and the next.
 *
 * Chicago time, not New York: these are CME Group venues and the schedule is
 * published in CT. It happens to be a fixed offset from New York today, so a
 * reader would not notice the difference — but the schedule is CT, and writing
 * it in the exchange's own zone is what keeps it correct if that ever stops
 * being true.
 *
 * ===========================================================================
 * Holidays
 * ===========================================================================
 *
 * Full-day exchange holidays come from `isUsMarketHoliday`, which is the rule
 * set the exchanges publish rather than a hardcoded list, and which the equity
 * calendar in this app already uses. CME closes its metals and energy pits for
 * the same full-day holidays as the equity market, so the set is reused rather
 * than copied.
 *
 * What is deliberately NOT modelled is the shortened session — CME runs a
 * partial day before some holidays, on its own schedule, and guessing at it
 * would be exactly the "wrong market status" this is meant to avoid. The effect
 * of not modelling it is bounded and safe: on such an afternoon this reports
 * open while the venue has settled early, and the card's own status is driven by
 * the freshness of the price, so a stale print still reads as stale rather than
 * as a live number.
 */
export const COMMODITY_MARKET_TIMEZONE = 'America/Chicago';

/** 16:00 CT — the daily settlement, and the Friday close. */
const DAILY_CLOSE_MINUTE = 16 * 60;
/** 17:00 CT — the daily reopen, and the Sunday open. */
const DAILY_OPEN_MINUTE = 17 * 60;

export type CommoditySessionState = 'open' | 'closed';

/**
 * Why the venue is shut, in the vocabulary the rest of the app already uses
 * (`MarketCloseReason`). 'NORMAL' is the daily 16:00–17:00 CT halt — a scheduled
 * break between two trading days, which is neither a weekend nor a holiday.
 */
export type CommodityCloseReason = 'WEEKEND' | 'HOLIDAY' | 'NORMAL';

export interface CommoditySession {
  state: CommoditySessionState;
  /** The pill on the card. Names the venue's state, not a vendor's. */
  label: string;
  /** Null while trading. */
  closeReason: CommodityCloseReason | null;
  /** Exchange-local date the instant falls on, for the trading-date field. */
  tradingDate: string;
}

/*
 * The pill states the market's STATE and nothing else, in the same words the
 * equity cards use.
 *
 * These read "ตลาดล่วงหน้าเปิด/ปิด" at first, and on a 238px handset card that
 * pill is `shrink-0` — so it took the width the instrument's name needed and
 * "ทองคำ" rendered as "ท..". The fact it dropped is not lost: the card's own
 * subtitle says "· สัญญาล่วงหน้า" directly under the name, which is where a
 * reader looks to find out WHAT they are being quoted. Repeating it in the state
 * pill cost the name its legibility and told them nothing new.
 */
export const COMMODITY_SESSION_OPEN_LABEL = 'ตลาดเปิด';
export const COMMODITY_SESSION_CLOSED_LABEL = 'ตลาดปิด';

function isoDate(parts: { year: number; month: number; day: number }): string {
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

/**
 * Whether the Globex week is running at this instant.
 *
 * Split out from `resolveCommoditySession` so the schedule itself can be tested
 * against the boundary minutes without going through the label.
 */
function closeReasonAt(now: Date): CommodityCloseReason | null {
  const parts = zonedParts(now, COMMODITY_MARKET_TIMEZONE);
  const minuteOfDay = parts.hour * 60 + parts.minute;

  // A full-day exchange holiday closes the venue whatever the clock says, and it
  // is checked first so a holiday is never reported as a routine halt.
  if (isUsMarketHoliday(isoDate(parts))) return 'HOLIDAY';

  switch (parts.weekday) {
    // Saturday has no trading at any hour: the week closed on Friday afternoon
    // and does not reopen until Sunday evening.
    case 'Sat':
      return 'WEEKEND';
    case 'Sun':
      return minuteOfDay >= DAILY_OPEN_MINUTE ? null : 'WEEKEND';
    case 'Fri':
      return minuteOfDay < DAILY_CLOSE_MINUTE ? null : 'WEEKEND';
    // Monday through Thursday: trading except the scheduled 16:00–17:00 halt.
    default:
      return minuteOfDay < DAILY_CLOSE_MINUTE || minuteOfDay >= DAILY_OPEN_MINUTE
        ? null
        : 'NORMAL';
  }
}

export function isCommodityMarketOpen(now: Date): boolean {
  return closeReasonAt(now) === null;
}

export function resolveCommoditySession(now: Date): CommoditySession {
  const closeReason = closeReasonAt(now);
  const open = closeReason === null;
  return {
    state: open ? 'open' : 'closed',
    label: open ? COMMODITY_SESSION_OPEN_LABEL : COMMODITY_SESSION_CLOSED_LABEL,
    closeReason,
    tradingDate: isoDate(zonedParts(now, COMMODITY_MARKET_TIMEZONE)),
  };
}
