import { calendarDaysUntil } from './normalize';
import type {
  EarningsProviderId,
  EarningsSchedule,
  EarningsScheduleAvailable,
  EarningsTimeOfDay,
} from './types';

/**
 * A remembered earnings date, and the rules for when it may still be used.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The earnings date is the only Options Signal input whose ABSENCE improves the
 * published numbers. Every other factor that goes missing is dropped from both
 * sides of the coverage fraction, so it costs coverage and cannot flatter
 * anything. Event risk is different: it is a PENALTY subtracted from confidence,
 * so a calendar that fails to load does not reduce the signal's confidence, it
 * RAISES it — the card moved from 53 to 60 on a symbol whose earnings were eight
 * days out, purely because a provider stopped answering.
 *
 * That is the worst failure shape a risk gate can have, and it happened for a
 * mundane reason: both calendar providers are rate- and plan-limited, and the
 * only thing standing behind them was a process-local cache that resets on every
 * deploy and on every cold start. Measured against the live providers on
 * 2026-08-19:
 *
 *   * Alpha Vantage answers `EARNINGS_CALENDAR` with HTTP 200 and a CSV body of
 *     `symbol,name,reportDate,...` followed by `I,n,f,o,r,m,a` — its JSON notice
 *     rendered one character per field and truncated to the header width. The
 *     same key on `GLOBAL_QUOTE` returns that notice in full: "our standard API
 *     rate limit is 25 requests per day". The documented `demo` key returns a
 *     real calendar from the same endpoint, so the endpoint is entitled and the
 *     key is simply exhausted — every symbol, for the rest of the day.
 *   * Financial Modeling Prep, the secondary, answers HTTP 402 "Premium Query
 *     Parameter" for any symbol outside the free plan's coverage (RKLB, IONQ and
 *     AFRM among the regression tickers).
 *
 * So the primary is exhausted daily and the secondary covers only some symbols.
 * An earnings date changes about four times a year; it does not need to be
 * fetched on every card. This is where it is kept so that it is not.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS MODULE ENFORCES
 * ---------------------------------------------------------------------------
 * A date that was once known is never given up because a provider blinked. It is
 * re-served, disclosed as STALE, and the penalty it carries STAYS. Losing the
 * ability to fetch is not evidence that the risk went away.
 *
 * The one thing a remembered date may not do is outlive its own report. A stored
 * `reportDate` before today is not "the next report" any more — it is history —
 * and serving it would print a negative countdown and apply the imminent-earnings
 * penalty to an event that already happened. Past dates are refused as a
 * fallback, which is the single case where the cache correctly gives up.
 */

/** One remembered calendar row. Exactly what is needed to re-publish a schedule. */
export interface EarningsScheduleEntry {
  symbol: string;
  /** Exchange-local (America/New_York) report date, `YYYY-MM-DD`. */
  reportDate: string;
  timeOfDay: EarningsTimeOfDay;
  epsEstimate: number | null;
  provider: EarningsProviderId;
  /** When a provider last actually answered with this row. */
  fetchedAt: string;
}

export interface EarningsScheduleStore {
  /**
   * The remembered row for `symbol`.
   *
   * `null` means "could not answer OR nothing remembered". Unlike the signal
   * history store there is no third state here, because the two are treated
   * identically at every call site: with no remembered date there is nothing to
   * fall back to and the provider chain has to run either way.
   */
  read(symbol: string): Promise<EarningsScheduleEntry | null>;
  /** `false` when the write did not land. Never a reason to fail a page. */
  write(entry: EarningsScheduleEntry): Promise<boolean>;
}

/**
 * How long a remembered date is served WITHOUT calling a provider at all.
 *
 * 24 hours, because that is the resolution of the thing being cached: a report
 * date is a calendar day, `daysToEarnings` is recomputed against today on every
 * read, and a company that moves its date announces it days or weeks ahead. The
 * only thing a shorter window would buy is more requests against a 25-per-day
 * quota that is already the reason this module exists.
 */
export const EARNINGS_SCHEDULE_TTL_MS = 24 * 60 * 60_000;

/** Process-local fallback, so a cold instance with no database still improves. */
export function createInMemoryEarningsScheduleStore(): EarningsScheduleStore {
  const rows = new Map<string, EarningsScheduleEntry>();
  return {
    read: (symbol) => Promise.resolve(rows.get(symbol) ?? null),
    write: (entry) => {
      rows.set(entry.symbol, entry);
      return Promise.resolve(true);
    },
  };
}

/**
 * Durable first, process-local behind it.
 *
 * Writes go to BOTH: the durable store is what survives a deploy, and the buffer
 * is what answers when the database cannot. A durable read that throws is the
 * same as one that found nothing — the buffer is asked either way.
 */
export function createResilientEarningsScheduleStore(
  durable: EarningsScheduleStore,
  fallback: EarningsScheduleStore = createInMemoryEarningsScheduleStore(),
): EarningsScheduleStore {
  return {
    async read(symbol) {
      const stored = await durable.read(symbol).catch(() => null);
      return stored ?? fallback.read(symbol).catch(() => null);
    },
    async write(entry) {
      const landed = await durable.write(entry).catch(() => false);
      await fallback.write(entry).catch(() => false);
      return landed;
    },
  };
}

/**
 * May this remembered row still stand in for a provider?
 *
 * Only the report date decides. Age does not: a row fetched a week ago naming a
 * date still in the future is a correct statement about event risk, and refusing
 * it is exactly the behaviour that let a provider outage raise a confidence
 * score.
 */
export function isUsableEarningsFallback(
  entry: EarningsScheduleEntry | null,
  today: string,
): entry is EarningsScheduleEntry {
  if (!entry) return false;
  const days = calendarDaysUntil(today, entry.reportDate);
  return days !== null && days >= 0;
}

/** True when the row is recent enough to serve without calling a provider. */
export function isFreshEarningsEntry(
  entry: EarningsScheduleEntry | null,
  today: string,
  now: number,
  ttlMs = EARNINGS_SCHEDULE_TTL_MS,
): entry is EarningsScheduleEntry {
  if (!isUsableEarningsFallback(entry, today)) return false;
  const fetchedAt = Date.parse(entry.fetchedAt);
  return Number.isFinite(fetchedAt) && now - fetchedAt < ttlMs;
}

/**
 * Re-publish a remembered row as a schedule, counting the days from `today`.
 *
 * `stale` is the caller's to state, because the two cases that reach here are
 * genuinely different: a row inside its TTL is the normal, cheap path and is not
 * stale at all, while a row served because both providers refused is, and the
 * card must say so.
 */
export function scheduleFromEntry(
  entry: EarningsScheduleEntry,
  today: string,
  options: { stale: boolean },
): EarningsScheduleAvailable {
  return {
    status: 'available',
    symbol: entry.symbol,
    reportDate: entry.reportDate,
    timeOfDay: entry.timeOfDay,
    epsEstimate: entry.epsEstimate,
    daysToEarnings: calendarDaysUntil(today, entry.reportDate) ?? 0,
    provider: entry.provider,
    asOf: entry.fetchedAt,
    stale: options.stale,
  };
}

/** The row to remember from a schedule a provider just answered with. */
export function entryFromSchedule(
  schedule: EarningsSchedule,
  fetchedAt: string,
): EarningsScheduleEntry | null {
  if (schedule.status !== 'available') return null;
  return {
    symbol: schedule.symbol,
    reportDate: schedule.reportDate,
    timeOfDay: schedule.timeOfDay,
    epsEstimate: schedule.epsEstimate,
    provider: schedule.provider,
    fetchedAt,
  };
}
