import { US_EQUITY_TIMEZONE, exchangeSessionDate } from './session';

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
 * Accepted evidence, in priority order:
 *
 *  1. a **verified market-status provider report that is still fresh** — same
 *     New York trading date, not flagged stale, not older than its own max age
 *     and not from the future;
 *  2. the **exchange calendar** evaluated at the current instant in
 *     America/New_York.
 *
 * Rejected as evidence, always: the browser's local time zone (the instant is
 * used, the zone never is), any quote/candle/extended timestamp, and a cached
 * provider status whose `asOf` no longer belongs to the current trading date.
 *
 * The calendar additionally CLAMPS the provider: a weekend or a verified
 * holiday can never resolve to REGULAR/PREMARKET/AFTER_HOURS no matter what a
 * cached "open" says.
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
  /** Verified exchange holidays (`YYYY-MM-DD`, exchange-local). Never guessed. */
  holidays?: ReadonlySet<string>;
  timeZone?: string;
}

export interface CurrentMarketSessionResult {
  session: CurrentMarketSession;
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

const CURRENT_SESSION_PRESENTATION: Record<
  CurrentMarketSession,
  { emoji: string; label: string; fullName: string }
> = {
  PREMARKET: { emoji: '🌅', label: 'ก่อนตลาดเปิด', fullName: 'Pre-market Session' },
  REGULAR: { emoji: '☀️', label: 'ตลาดเปิด', fullName: 'Regular Market Session' },
  AFTER_HOURS: { emoji: '🌙', label: 'หลังเวลาทำการ', fullName: 'After-hours Session' },
  CLOSED: { emoji: '🌙', label: 'ตลาดปิด', fullName: 'Market Closed' },
  HOLIDAY: { emoji: '🌙', label: 'ตลาดปิด · วันหยุดตลาด', fullName: 'Market Holiday' },
  EARLY_CLOSE: { emoji: '⏱️', label: 'ตลาดปิดเร็ว', fullName: 'Early Close Session' },
  HALTED: { emoji: '⏸️', label: 'หยุดซื้อขายชั่วคราว', fullName: 'Trading Halt' },
  UNKNOWN: { emoji: '⚠️', label: 'ไม่ทราบสถานะตลาด', fullName: 'Unknown Market Session' },
};

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

/**
 * The exchange calendar evaluated at `instant` — the floor every other source is
 * clamped against. Weekends and verified holidays are non-trading days, full stop.
 */
function calendarSession(
  instant: Date,
  timeZone: string,
  holidays: ReadonlySet<string>,
): { session: CurrentMarketSession; tradingDay: boolean } {
  const { weekday, minute } = exchangeClock(instant, timeZone);
  if (weekday === 'Sat' || weekday === 'Sun') return { session: 'CLOSED', tradingDay: false };
  const date = exchangeSessionDate(instant.toISOString(), timeZone);
  if (date && holidays.has(date)) return { session: 'HOLIDAY', tradingDay: false };
  if (minute >= REGULAR_OPEN_MINUTE && minute < REGULAR_CLOSE_MINUTE) {
    return { session: 'REGULAR', tradingDay: true };
  }
  if (minute >= PREMARKET_OPEN_MINUTE && minute < REGULAR_OPEN_MINUTE) {
    return { session: 'PREMARKET', tradingDay: true };
  }
  if (minute >= REGULAR_CLOSE_MINUTE && minute < AFTER_HOURS_CLOSE_MINUTE) {
    return { session: 'AFTER_HOURS', tradingDay: true };
  }
  return { session: 'CLOSED', tradingDay: true };
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
    // A live session claim is only admissible on a real trading day. This is the
    // clamp behind invariants G and H: no cached "open" can survive a weekend or
    // a verified holiday. HOLIDAY/EARLY_CLOSE are calendar facts the provider
    // knows better than we do, so those are always taken.
    const liveClaim = judged.session === 'REGULAR'
      || judged.session === 'PREMARKET'
      || judged.session === 'AFTER_HOURS';
    if (liveClaim && !calendar.tradingDay) {
      rejection = 'contradicts-calendar';
    } else {
      session = judged.session;
      source = 'market-status-provider';
    }
  }

  return {
    session,
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

export function currentSessionPresentation(session: CurrentMarketSession) {
  return CURRENT_SESSION_PRESENTATION[session];
}

/** The one session in which the header shows a live regular price and no extended row. */
export function isRegularSession(session: CurrentMarketSession): boolean {
  return session === 'REGULAR';
}

/** Sessions whose primary row is the latest COMPLETED regular close. */
export function usesLatestRegularClose(session: CurrentMarketSession): boolean {
  return session !== 'REGULAR' && session !== 'HALTED';
}
