import { US_EQUITY_TIMEZONE, exchangeSessionDate } from './session';
import {
  EARLY_CLOSE_MINUTE,
  isUsMarketEarlyClose,
  previousUsTradingDate,
  usMarketHolidays,
} from './us-market-calendar';

/**
 * SINGLE SOURCE OF TRUTH for "what session is the market in RIGHT NOW".
 *
 * Three things that are routinely confused must stay separate:
 *
 *  1. **CURRENT MARKET SESSION** — the state of the exchange at this instant.
 *     That is what this module resolves, and nothing else may decide it.
 *  2. **PRICE SESSION** — which window a given print was executed in. Derived
 *     from the print's own timestamp (`classifyUsEquitySession`).
 *  3. **DATA TIMESTAMP** — which day/time a price came from.
 *
 * (2) and (3) are properties of a *price*. Neither is evidence that the market
 * is open now: a Friday 15:59 ET trade classifies as `regular` forever, so
 * deriving the current session from it labels a Sunday "ตลาดเปิด". The header
 * bug this module exists to kill did exactly that.
 *
 * The **exchange calendar in America/New_York is authoritative**. It is
 * evaluated at the current instant and decides the window:
 *
 *   PRE      04:00–09:30 ET
 *   REGULAR  09:30–16:00 ET  (09:30–13:00 on a published half-day)
 *   AFTER    16:00–20:00 ET  (13:00–17:00 on a published half-day)
 *   CLOSED   anything else, every weekend, every exchange holiday
 *
 * A market-status provider report may only REFINE that answer — it may declare a
 * HOLIDAY or an EARLY_CLOSE the calendar does not know about, and it may confirm
 * the window the calendar already resolved. It may never contradict the ET
 * clock: a coarse or stale `closed` report at 15:22 ET is rejected exactly as a
 * cached `open` on a Sunday is. That clamp runs in BOTH directions, because both
 * failures put a false session label in the header.
 *
 * Rejected as evidence, always: the browser's (or server's) local time zone —
 * the instant is used, the zone never is — any quote/candle/extended timestamp,
 * and a provider status whose `asOf` no longer belongs to the current trading
 * date.
 */

export type CurrentMarketSession =
  | 'PREMARKET'
  | 'REGULAR'
  | 'AFTER_HOURS'
  | 'CLOSED'
  | 'HOLIDAY'
  | 'EARLY_CLOSE'
  | 'HALTED'
  | 'UNKNOWN';

/**
 * The four phases the PRICE rules are written against.
 *
 * Deliberately coarser than {@link CurrentMarketSession}: a holiday, a weekend, an
 * early close and an ordinary evening are all one price rule — "show the latest
 * completed regular close" — and collapsing them here means that rule is written
 * once. WHY the market is closed is carried separately as {@link MarketCloseReason},
 * which is what the session icon and status text vary on.
 */
export type MarketSessionPhase = 'PRE' | 'REGULAR' | 'POST' | 'CLOSED';

/** Why the market is closed. Null whenever it is not. */
export type MarketCloseReason = 'NORMAL' | 'WEEKEND' | 'HOLIDAY' | 'EVENT' | 'EARLY_CLOSE';

/** Where the resolved session came from — surfaced in the ⓘ provenance detail. */
export type CurrentSessionSource =
  | 'market-status-provider'
  | 'exchange-calendar'
  | 'symbol-halt'
  | 'unresolved';

/** Why a provider report was not used as evidence of the current session. */
export type ProviderStatusRejection =
  | 'missing'
  | 'stale'
  | 'invalid-timestamp'
  | 'future-timestamp'
  | 'older-trading-date'
  | 'past-max-age'
  | 'unknown-status'
  | 'contradicts-calendar';

/** Provider market-status report plus everything needed to judge its freshness. */
export interface MarketStatusReport {
  status: 'pre-market' | 'open' | 'after-hours' | 'closed' | 'holiday' | 'early-close' | 'unknown';
  /** ISO instant the provider evaluated this status. */
  asOf: string | null;
  source: string | null;
  /** The pipeline already flagged this report as served from a stale cache. */
  stale: boolean;
  /** Provider-declared validity window; defaults to 5 minutes when absent. */
  maxAgeSeconds?: number | null;
}

export interface CurrentMarketSessionInput {
  /** The instant to evaluate, as an ISO string or Date. Never a quote timestamp. */
  now: string | Date;
  marketStatus?: MarketStatusReport | null;
  /**
   * Extra verified exchange holidays (`YYYY-MM-DD`, exchange-local) on top of
   * the built-in US calendar — an unscheduled closure, say. Never guessed.
   */
  holidays?: ReadonlySet<string>;
  timeZone?: string;
}

export interface CurrentMarketSessionResult {
  session: CurrentMarketSession;
  /** The coarse price-rule phase the session maps to. */
  phase: MarketSessionPhase;
  /** Why the market is closed, or null when it is open in some window. */
  closeReason: MarketCloseReason | null;
  /** The instant the session was resolved at — NOT the price timestamp. */
  evaluatedAt: string;
  source: CurrentSessionSource;
  /** Exchange-local trading date of the evaluation instant. */
  exchangeDate: string | null;
  provider: {
    accepted: boolean;
    status: MarketStatusReport['status'] | null;
    asOf: string | null;
    source: string | null;
    rejection: ProviderStatusRejection | null;
  };
}

const DEFAULT_STATUS_MAX_AGE_SECONDS = 5 * 60;
/** Tolerance for a provider clock running slightly ahead of ours. */
const FUTURE_TOLERANCE_SECONDS = 60;

const PREMARKET_OPEN_MINUTE = 4 * 60;
const REGULAR_OPEN_MINUTE = 9 * 60 + 30;
const REGULAR_CLOSE_MINUTE = 16 * 60;
const AFTER_HOURS_CLOSE_MINUTE = 20 * 60;

/**
 * The Material Symbols glyph a session is shown with.
 *
 * `event` is reserved for a closure the calendar can EXPLAIN — a published holiday
 * or an unscheduled exchange event — because that is the one closed state where the
 * reason, not the hour, is the useful information. An ordinary evening and a
 * weekend both get `bedtime`: to a reader they are the same fact.
 */
export type SessionIconName = 'wb_twilight' | 'sunny' | 'bedtime' | 'event';

/** Semantic color slot for a session icon. Resolved to a theme token by the UI. */
export type SessionTone = 'pre' | 'regular' | 'post' | 'closed' | 'event';

export interface SessionPresentation {
  icon: SessionIconName;
  tone: SessionTone;
  /** Short Thai status text shown beside the icon. */
  label: string;
  /** Thai accessible name / tooltip; always says what the icon means. */
  description: string;
  /** English session name, for the ⓘ provenance detail. */
  fullName: string;
}

const CURRENT_SESSION_PRESENTATION: Record<CurrentMarketSession, { label: string; fullName: string }> = {
  PREMARKET: { label: 'ก่อนเปิดตลาด', fullName: 'Pre-market Session' },
  REGULAR: { label: 'ตลาดเปิด', fullName: 'Regular Market Session' },
  AFTER_HOURS: { label: 'หลังปิดตลาด', fullName: 'After-hours Session' },
  CLOSED: { label: 'ปิดตลาด', fullName: 'Market Closed' },
  HOLIDAY: { label: 'ตลาดปิด (วันหยุด)', fullName: 'Market Holiday' },
  EARLY_CLOSE: { label: 'ปิดตลาด (ปิดเร็วกว่าปกติ)', fullName: 'Early Close Session' },
  HALTED: { label: 'หยุดซื้อขายชั่วคราว', fullName: 'Trading Halt' },
  UNKNOWN: { label: 'ไม่ทราบสถานะตลาด', fullName: 'Unknown Market Session' },
};

/** Thai status text for a closed market, by the reason it is closed. */
const CLOSED_PRESENTATION: Record<MarketCloseReason, { label: string; description: string; fullName: string }> = {
  NORMAL: {
    label: 'ปิดตลาด',
    description: 'ปิดตลาด — จบช่วงซื้อขายของวันแล้ว ราคาหลักคือราคาปิดจริงของวันซื้อขายล่าสุด',
    fullName: 'Market Closed',
  },
  WEEKEND: {
    label: 'ปิดตลาด (วันหยุดสุดสัปดาห์)',
    description: 'ปิดตลาด — วันหยุดสุดสัปดาห์ ราคาหลักคือราคาปิดจริงของวันซื้อขายล่าสุด',
    fullName: 'Market Closed · Weekend',
  },
  HOLIDAY: {
    label: 'ตลาดปิด (วันหยุด)',
    description: 'ตลาดปิด — วันหยุดตามปฏิทินตลาด ราคาหลักคือราคาปิดจริงของวันซื้อขายล่าสุด',
    fullName: 'Market Holiday',
  },
  EVENT: {
    label: 'ตลาดปิด (เหตุการณ์พิเศษ)',
    description: 'ตลาดปิด — เหตุการณ์พิเศษนอกปฏิทินปกติ ราคาหลักคือราคาปิดจริงของวันซื้อขายล่าสุด',
    fullName: 'Market Closed · Exchange Event',
  },
  EARLY_CLOSE: {
    label: 'ปิดตลาด (ปิดเร็วกว่าปกติ)',
    description: 'ปิดตลาด — วันนี้ตลาดปิดเร็วกว่าปกติ ราคาหลักคือราคาปิดจริงของวันนั้น',
    fullName: 'Market Closed · Early Close',
  },
};

/**
 * Icon, color tone and Thai status text for a resolved session.
 *
 * Keyed on the PHASE plus the close REASON, never on the raw session label, so the
 * icon/text pair is decided by the same two facts the price rules use. The only
 * closed states that get the `event` glyph and tone are the ones the calendar can
 * explain (holiday / exchange event); an evening, a weekend and an early close all
 * read as "the day is over" and share the `bedtime` glyph.
 */
export function sessionPresentation(
  phase: MarketSessionPhase,
  closeReason: MarketCloseReason | null,
  sessionLabel?: CurrentMarketSession,
): SessionPresentation {
  // A symbol halt keeps the REGULAR phase — the market as a whole IS open, and
  // downgrading the phase would swap the live price for a completed close — but the
  // status text must still say the symbol is paused, so both facts are stated. The
  // muted tone carries "nothing is trading right now" without borrowing loss red.
  if (sessionLabel === 'HALTED') {
    return {
      icon: 'sunny',
      tone: 'closed',
      label: 'ตลาดเปิด · หยุดซื้อขายชั่วคราว',
      description: 'ตลาดเปิดอยู่ แต่หุ้นตัวนี้ถูกพักการซื้อขายชั่วคราว (Trading Halt)',
      fullName: 'Regular Market Session · Trading Halt',
    };
  }
  // An unresolved session applies the CLOSED price rules, but saying "ปิดตลาด" would
  // claim a fact we could not establish. The glyph reflects the rule in force; the
  // text states the uncertainty and what the displayed price therefore is.
  if (sessionLabel === 'UNKNOWN') {
    return {
      icon: 'bedtime',
      tone: 'closed',
      label: 'ไม่ทราบสถานะตลาด',
      description: 'ยังตรวจสอบสถานะตลาดไม่ได้ จึงแสดงราคาปิดจริงของวันซื้อขายล่าสุดไว้ก่อน',
      fullName: 'Unknown Market Session',
    };
  }
  switch (phase) {
    case 'PRE':
      return {
        icon: 'wb_twilight',
        tone: 'pre',
        label: 'ก่อนเปิดตลาด',
        description: 'ก่อนเปิดตลาด — ช่วงซื้อขายก่อนตลาดเปิดทำการ (Pre-market) ราคาหลักคือราคาปิดจริงของวันซื้อขายล่าสุด',
        fullName: 'Pre-market Session',
      };
    case 'REGULAR':
      return {
        icon: 'sunny',
        tone: 'regular',
        label: 'ตลาดเปิด',
        description: 'ตลาดเปิด — อยู่ในช่วงเวลาซื้อขายปกติ (Regular Session)',
        fullName: 'Regular Market Session',
      };
    case 'POST':
      return {
        icon: 'bedtime',
        tone: 'post',
        label: 'หลังปิดตลาด',
        description: 'หลังปิดตลาด — ช่วงซื้อขายหลังตลาดปิดทำการ (After-hours) ราคาหลักคือราคาปิดจริงของวันนี้',
        fullName: 'After-hours Session',
      };
    case 'CLOSED': {
      const reason = closeReason ?? 'NORMAL';
      const copy = CLOSED_PRESENTATION[reason];
      const calendarClosure = reason === 'HOLIDAY' || reason === 'EVENT';
      return {
        icon: calendarClosure ? 'event' : 'bedtime',
        tone: calendarClosure ? 'event' : 'closed',
        ...copy,
      };
    }
  }
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zonedFormatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  zonedFormatters.set(timeZone, created);
  return created;
}

/** Exchange-local weekday + minute-of-day. The reader's own zone is never used. */
function exchangeClock(instant: Date, timeZone: string): { weekday: string; minute: number } {
  const parts = Object.fromEntries(
    zonedFormatter(timeZone).formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    weekday: String(parts.weekday),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Sessions in which the exchange is actually trading right now. */
function isLiveSession(session: CurrentMarketSession): boolean {
  return session === 'REGULAR' || session === 'PREMARKET' || session === 'AFTER_HOURS';
}

/**
 * The exchange calendar evaluated at `instant` — the authority every other
 * source is clamped against. Weekends and holidays are non-trading days, full
 * stop, and the four windows come from the ET wall clock alone.
 *
 * On a published half-day the regular session ends at 13:00 ET and the
 * after-hours window runs 13:00–17:00 ET; the pre-market window is unchanged.
 * Half-days are still trading days.
 */
function calendarSession(
  instant: Date,
  timeZone: string,
  holidays: ReadonlySet<string>,
): { session: CurrentMarketSession; tradingDay: boolean; weekend: boolean; pastEarlyClose: boolean } {
  const { weekday, minute } = exchangeClock(instant, timeZone);
  if (weekday === 'Sat' || weekday === 'Sun') {
    return { session: 'CLOSED', tradingDay: false, weekend: true, pastEarlyClose: false };
  }
  const date = exchangeSessionDate(instant.toISOString(), timeZone);
  const usCalendar = timeZone === US_EQUITY_TIMEZONE;
  const earlyClose = usCalendar && date !== null && isUsMarketEarlyClose(date);
  // Only an early close that has already HAPPENED is one: at 03:00 ET on a half-day
  // morning the session has not opened, let alone closed early.
  const pastEarlyClose = earlyClose && minute >= EARLY_CLOSE_MINUTE;
  const base = { weekend: false, pastEarlyClose } as const;
  if (date && (holidays.has(date) || (usCalendar && usMarketHolidays(Number(date.slice(0, 4))).has(date)))) {
    return { session: 'HOLIDAY', tradingDay: false, ...base };
  }
  const regularCloseMinute = earlyClose ? EARLY_CLOSE_MINUTE : REGULAR_CLOSE_MINUTE;
  const afterHoursCloseMinute = earlyClose
    ? EARLY_CLOSE_MINUTE + (AFTER_HOURS_CLOSE_MINUTE - REGULAR_CLOSE_MINUTE)
    : AFTER_HOURS_CLOSE_MINUTE;
  if (minute >= REGULAR_OPEN_MINUTE && minute < regularCloseMinute) {
    return { session: 'REGULAR', tradingDay: true, ...base };
  }
  if (minute >= PREMARKET_OPEN_MINUTE && minute < REGULAR_OPEN_MINUTE) {
    return { session: 'PREMARKET', tradingDay: true, ...base };
  }
  if (minute >= regularCloseMinute && minute < afterHoursCloseMinute) {
    return { session: 'AFTER_HOURS', tradingDay: true, ...base };
  }
  return { session: 'CLOSED', tradingDay: true, ...base };
}

/**
 * The US trading date whose regular-session price is canonical at `now`.
 *
 * PRE / before the open -> the previous finalized trading day.
 * REGULAR              -> today's live regular session.
 * AFTER / after close  -> today's finalized regular close.
 * Weekend / holiday    -> the most recent finalized trading day.
 *
 * The instant is always interpreted in America/New_York. This is also the cache
 * generation key for regular quotes, so a Friday `/prev` response cannot survive
 * into Monday's regular/after-hours state.
 */
export function canonicalRegularTradingDateAt(now: Date | string): string | null {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.valueOf())) return null;
  const date = exchangeSessionDate(instant.toISOString(), US_EQUITY_TIMEZONE);
  if (!date) return null;

  const calendar = calendarSession(instant, US_EQUITY_TIMEZONE, new Set());
  if (calendar.session === 'REGULAR' || calendar.session === 'AFTER_HOURS') return date;

  if (calendar.session === 'CLOSED' && calendar.tradingDay) {
    const closeMinute = isUsMarketEarlyClose(date) ? EARLY_CLOSE_MINUTE : REGULAR_CLOSE_MINUTE;
    if (exchangeClock(instant, US_EQUITY_TIMEZONE).minute >= closeMinute) return date;
  }
  return previousUsTradingDate(date);
}

/**
 * Map a resolved session to the phase its PRICE rule is written against.
 *
 * `HALTED` maps to REGULAR because the market as a whole is still in its regular
 * session — the halt is a symbol-level fact shown separately, and downgrading the
 * phase would swap the live regular price for a completed close.
 *
 * `UNKNOWN` maps to CLOSED deliberately. With no established session the only safe
 * main price is the latest COMPLETED regular close: a live or extended value would
 * be a claim about a session we cannot prove we are in.
 */
export function sessionPhaseOf(session: CurrentMarketSession): MarketSessionPhase {
  switch (session) {
    case 'PREMARKET': return 'PRE';
    case 'REGULAR':
    case 'HALTED': return 'REGULAR';
    case 'AFTER_HOURS': return 'POST';
    case 'CLOSED':
    case 'HOLIDAY':
    case 'EARLY_CLOSE':
    case 'UNKNOWN': return 'CLOSED';
  }
}

/**
 * Why the market is closed, for the session icon and status text.
 *
 * `HOLIDAY` vs `EVENT` is the distinction that decides whether the header shows a
 * calendar closure or an unscheduled one, so it is drawn from real evidence rather
 * than a label: a date the published exchange calendar (or a caller-supplied
 * verified closure set) lists is a `HOLIDAY`; a closure asserted for a day the
 * calendar considers a normal trading day is an `EVENT`. Weekends win over both,
 * because a provider reporting "holiday" on a Sunday is describing a weekend.
 */
function resolveCloseReason(input: {
  session: CurrentMarketSession;
  weekend: boolean;
  pastEarlyClose: boolean;
  exchangeDate: string | null;
  timeZone: string;
  holidays: ReadonlySet<string>;
}): MarketCloseReason | null {
  const { session, weekend, pastEarlyClose, exchangeDate, timeZone, holidays } = input;
  if (sessionPhaseOf(session) !== 'CLOSED') return null;
  if (weekend) return 'WEEKEND';
  const scheduledHoliday = exchangeDate !== null && (
    holidays.has(exchangeDate)
    || (timeZone === US_EQUITY_TIMEZONE && usMarketHolidays(Number(exchangeDate.slice(0, 4))).has(exchangeDate))
  );
  if (session === 'HOLIDAY') return scheduledHoliday ? 'HOLIDAY' : 'EVENT';
  if (session === 'EARLY_CLOSE') return 'EARLY_CLOSE';
  if (scheduledHoliday) return 'HOLIDAY';
  // A published half-day whose session has already ended is an early close, not an
  // ordinary evening — the distinction the icon and status text depend on.
  if (pastEarlyClose) return 'EARLY_CLOSE';
  return 'NORMAL';
}

function providerSession(status: MarketStatusReport['status']): CurrentMarketSession | null {
  switch (status) {
    case 'pre-market': return 'PREMARKET';
    case 'open': return 'REGULAR';
    case 'after-hours': return 'AFTER_HOURS';
    case 'closed': return 'CLOSED';
    case 'holiday': return 'HOLIDAY';
    case 'early-close': return 'EARLY_CLOSE';
    default: return null;
  }
}

/**
 * Judge whether a provider report is admissible evidence about *now*.
 *
 * A report from an earlier trading date is the exact shape of the production
 * bug: Polygon's last cached `market: "open"` from Friday, replayed on Sunday.
 * It is rejected on the trading-date test alone, before any age arithmetic,
 * because an end-of-day-ish report can carry no usable max age.
 */
function judgeProvider(
  report: MarketStatusReport | null | undefined,
  instant: Date,
  timeZone: string,
): { session: CurrentMarketSession; rejection: null } | { session: null; rejection: ProviderStatusRejection } {
  if (!report) return { session: null, rejection: 'missing' };
  if (report.stale) return { session: null, rejection: 'stale' };
  const asOfMs = report.asOf ? Date.parse(report.asOf) : Number.NaN;
  if (!Number.isFinite(asOfMs)) return { session: null, rejection: 'invalid-timestamp' };
  const ageSeconds = (instant.valueOf() - asOfMs) / 1_000;
  if (ageSeconds < -FUTURE_TOLERANCE_SECONDS) return { session: null, rejection: 'future-timestamp' };
  if (
    exchangeSessionDate(new Date(asOfMs).toISOString(), timeZone)
    !== exchangeSessionDate(instant.toISOString(), timeZone)
  ) {
    return { session: null, rejection: 'older-trading-date' };
  }
  const maxAgeSeconds = report.maxAgeSeconds ?? DEFAULT_STATUS_MAX_AGE_SECONDS;
  if (ageSeconds > Math.max(maxAgeSeconds, DEFAULT_STATUS_MAX_AGE_SECONDS)) {
    return { session: null, rejection: 'past-max-age' };
  }
  const session = providerSession(report.status);
  return session ? { session, rejection: null } : { session: null, rejection: 'unknown-status' };
}

export function resolveCurrentMarketSession(
  input: CurrentMarketSessionInput,
): CurrentMarketSessionResult {
  const timeZone = input.timeZone ?? US_EQUITY_TIMEZONE;
  const holidays = input.holidays ?? new Set<string>();
  const instant = input.now instanceof Date ? input.now : new Date(input.now);
  const report = input.marketStatus ?? null;

  if (Number.isNaN(instant.valueOf())) {
    return {
      session: 'UNKNOWN',
      phase: 'CLOSED',
      closeReason: null,
      evaluatedAt: typeof input.now === 'string' ? input.now : '',
      source: 'unresolved',
      exchangeDate: null,
      provider: {
        accepted: false,
        status: report?.status ?? null,
        asOf: report?.asOf ?? null,
        source: report?.source ?? null,
        rejection: 'invalid-timestamp',
      },
    };
  }

  const evaluatedAt = instant.toISOString();
  const exchangeDate = exchangeSessionDate(evaluatedAt, timeZone);
  const calendar = calendarSession(instant, timeZone, holidays);
  const judged = judgeProvider(report, instant, timeZone);

  let session = calendar.session;
  let source: CurrentSessionSource = 'exchange-calendar';
  let rejection = judged.rejection;

  if (judged.session) {
    // The ET calendar decides the window; the provider may only agree with it or
    // add a closure it knows about. Both clamp directions matter:
    //
    //  - a cached "open" must not survive a weekend, a holiday, or 03:00 ET
    //    (invariants G and H);
    //  - a coarse or stale "closed" must not black out a genuinely open market —
    //    the production bug where 15:22 ET read as "ตลาดปิด".
    //
    // HOLIDAY and EARLY_CLOSE remain provider-owned: an unscheduled closure is
    // something only the provider can know.
    const calendarFact = judged.session === 'HOLIDAY' || judged.session === 'EARLY_CLOSE';
    const contradictsCalendar = !calendarFact && (
      isLiveSession(judged.session)
        ? !calendar.tradingDay || judged.session !== calendar.session
        // A plain "closed" never overwrites an open window, nor downgrades the
        // calendar's more specific HOLIDAY label to a generic close.
        : isLiveSession(calendar.session) || calendar.session === 'HOLIDAY'
    );
    if (contradictsCalendar) {
      rejection = 'contradicts-calendar';
    } else {
      session = judged.session;
      source = 'market-status-provider';
    }
  }

  return {
    session,
    phase: sessionPhaseOf(session),
    closeReason: resolveCloseReason({
      session,
      weekend: calendar.weekend,
      pastEarlyClose: calendar.pastEarlyClose,
      exchangeDate,
      timeZone,
      holidays,
    }),
    evaluatedAt,
    source,
    exchangeDate,
    provider: {
      accepted: rejection === null,
      status: report?.status ?? null,
      asOf: report?.asOf ?? null,
      source: report?.source ?? null,
      rejection,
    },
  };
}

/**
 * A symbol-level halt replaces the REGULAR label only.
 *
 * The market as a whole is still open, so downgrading to CLOSED would be a lie
 * in the other direction; and a halt outside regular hours says nothing about
 * the market-wide session.
 */
export function applySymbolHalt(
  session: CurrentMarketSession,
  halted: boolean | null | undefined,
): CurrentMarketSession {
  return halted && session === 'REGULAR' ? 'HALTED' : session;
}

/**
 * English/Thai naming for a raw session label, used in the ⓘ provenance detail
 * where the exact resolved session (including HALTED and UNKNOWN, which have no
 * phase of their own) must stay inspectable.
 */
export function currentSessionPresentation(session: CurrentMarketSession) {
  return CURRENT_SESSION_PRESENTATION[session];
}
