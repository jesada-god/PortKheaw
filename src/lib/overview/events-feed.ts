/**
 * ONE LIST OF THINGS THAT ARE COMING, FROM TWO SOURCES THAT STAY SEPARATE.
 *
 * ===========================================================================
 * WHY THE MERGE HAPPENS HERE AND NOT IN market-overview
 * ===========================================================================
 * `src/lib/market-overview/events.ts` is macro-only and stays that way. Its own
 * header, and the header of the calendar it reads, say why: a macro release
 * moves the whole tape and answers a question about the day, while an earnings
 * date belongs to one company and answers a question about a holding. Putting
 * earnings inside that module would make it the thing it declines to be.
 *
 * But a reader asking "มีอะไรต้องรู้" does not sort their own answer by which
 * subsystem produced it — that is the argument `UpcomingSection` already makes
 * for showing earnings, expiries and alerts in one list. So the two lists are
 * joined HERE, above both, and neither module learns about the other.
 *
 * ===========================================================================
 * NOTHING FROM `UpcomingFeed` IS DROPPED
 * ===========================================================================
 * Merging earnings alone would have silently lost the other two kinds the
 * Upcoming card carries — OPTION EXPIRIES and ALERT PROXIMITY — and losing a
 * contract's expiry date off a page is not a formatting decision. All four
 * kinds are carried: macro from the calendar, and all three of Upcoming's.
 *
 * Each row keeps the sentence its own builder already wrote. This module
 * composes and orders; it does not restate anything, and it computes no date.
 *
 * ===========================================================================
 * EVERY THAI DATE COMES FROM ONE PLACE
 * ===========================================================================
 * Macro rows are labelled by `ovEventDayLabel` / `ovEventTimeLabel`, which go
 * through `src/lib/presentation/datetime.ts`. Upcoming rows arrive with a whole
 * day count already computed by their own builder against the exchange
 * calendar, and are NOT re-dated here — re-deriving a date from a day count
 * would put a second answer to "which day is that" on the same list.
 */

import {
  ovEventCountdownDays,
  ovEventDayLabel,
  ovEventTimeLabel,
  type OvEventImportance,
  type OvEventWindow,
} from '@/src/lib/market-overview/events';
import { ovEventRelevanceFor } from '@/src/lib/market-overview/event-relevance';
import { formatThaiDateOnly } from '@/src/lib/presentation/datetime';
import type { UpcomingEvent, UpcomingFeed } from '@/src/lib/upcoming/types';

export type OverviewEventKind = 'macro' | 'earnings' | 'option-expiry' | 'alert';

/**
 * How many rows EACH GROUP draws before it says how many are left.
 *
 * Per group, not across both. A single budget of six was spent soonest-first
 * over a merged list, so a week with five macro releases in it pushed every
 * expiry and every earnings date off the section entirely — the reader lost a
 * contract's expiry because the government publishes a lot in September, which
 * is not a relationship either of those facts has to the other.
 */
export const OVERVIEW_EVENTS_GROUP_LIMIT = 5;

export interface OverviewEventRow {
  id: string;
  kind: OverviewEventKind;
  /** The finished Thai sentence, from whichever builder produced the row. */
  titleTh: string;
  /** Thai date. Null for a row that genuinely has no date — an alert is "close". */
  dayLabel: string | null;
  /**
   * Bangkok wall clock. MACRO ONLY.
   *
   * A release is published at a stated minute; an earnings date and an expiry
   * are days, and printing 00:00 beside them would invent a precision the
   * source does not have.
   */
  timeLabel: string | null;
  /**
   * The editorial ranking, macro only. Null for the other three kinds.
   *
   * Null rather than a default, because assigning `medium` to every earnings
   * date would be this module inventing a ranking that nothing measured.
   */
  importance: OvEventImportance | null;
  /** Whole days away. Null for an undated row. */
  countdownDays: number | null;
  /** "วันนี้" / "อีก 5 วัน". Null when there is no count to state. */
  countdownText: string | null;
  /**
   * The instrument this row IS ABOUT, for the link a reader opens.
   *
   * At most one, and only for the three kinds that genuinely belong to a single
   * company: an earnings date, an expiry, an alert. A macro release belongs to
   * no company and carries none — see `affectedCount`.
   */
  symbols: string[];
  /**
   * How many of the reader's own symbols a MARKET-WIDE release reaches.
   *
   * Absent on every row that is not one, which is what distinguishes "this is
   * an economy-wide number and you hold seven US names" from "this row is about
   * NVDA". `ovEventRelevanceFor` has always computed it and this module used to
   * drop it on the floor, taking the capped NAME LIST instead — so every macro
   * row printed the same seven tickers and read as a per-stock claim the
   * relevance module explicitly refuses to make.
   *
   * Zero is a real answer (a signed-out reader, an empty watchlist) and must
   * render as nothing at all rather than as "0 ตัว".
   */
  affectedCount?: number;
}

export interface OverviewEventGroup {
  /** Ordered, soonest first, cut to {@link OVERVIEW_EVENTS_GROUP_LIMIT}. */
  rows: OverviewEventRow[];
  /** Rows before the cut, so the group can say how many of ITS OWN are left. */
  total: number;
}

/**
 * TWO GROUPS, BECAUSE THEY ANSWER TWO QUESTIONS.
 *
 * The merge that produced this section was right about one thing — a reader
 * asking "มีอะไรต้องรู้" does not sort their answer by subsystem — and wrong
 * about the consequence. It put "IREN Call · หมดอายุในอีก 2 วัน" between CPI and
 * NFP, on the sole grounds that its date fell there, and the two rows have
 * nothing to do with each other: one is an economy-wide number published on a
 * schedule, the other is a contract the reader personally owns running out.
 *
 * This module already had them as two arrays; the fix is to stop concatenating.
 * Nothing downstream of `fromUpcoming` changes and neither source module learns
 * about the other — the split is a property of the VIEW, which is the only
 * layer that has ever known both exist.
 */
export interface OverviewEventsView {
  /** Macro releases: the published economic calendar. */
  calendar: OverviewEventGroup;
  /** Earnings, expiries and alerts: things about instruments the reader holds. */
  holdings: OverviewEventGroup;
  /**
   * Where the shipped calendar stops, when it stops short of the window.
   *
   * Null while it covers the window. NOT null-when-empty: a run of empty months
   * is perfectly drawable and reads as "nothing is scheduled", which is the
   * opposite of what is true. It belongs to the CALENDAR group and says nothing
   * about the other one.
   */
  coverageNoteTh: string | null;
}

function countdownTextOf(days: number | null): string | null {
  if (days === null || !Number.isFinite(days)) return null;
  if (days < 0) return null;
  return days === 0 ? 'วันนี้' : `อีก ${days} วัน`;
}

/** An Upcoming row, kept whole. Its sentence and its day count are already right. */
function fromUpcoming(event: UpcomingEvent): OverviewEventRow {
  return {
    id: event.id,
    kind: event.kind,
    titleTh: event.text,
    /*
      No date label. `UpcomingEvent` carries a day COUNT, and the two dated
      kinds also carry their own `reportDate` / `expirationDate` — but those are
      exchange-local dates, and turning one into a Thai calendar day here would
      be a second conversion path beside the one in `datetime.ts`. The count is
      what the row is about, so the count is what it prints.
    */
    dayLabel: null,
    timeLabel: null,
    importance: null,
    countdownDays: event.days,
    countdownText: countdownTextOf(event.days),
    symbols: [event.symbol],
  };
}

const IMPORTANCE_RANK: Readonly<Record<OvEventImportance, number>> = {
  high: 0, medium: 1, low: 2,
};

/**
 * Soonest first, then most-watched, then by id so the order is total.
 *
 * An undated row sorts LAST rather than first. An alert that is close has no
 * day attached to it, and letting a null read as zero would put it above a
 * release happening this morning.
 */
function compareRows(left: OverviewEventRow, right: OverviewEventRow): number {
  const leftDays = left.countdownDays ?? Number.POSITIVE_INFINITY;
  const rightDays = right.countdownDays ?? Number.POSITIVE_INFINITY;
  if (leftDays !== rightDays) return leftDays - rightDays;
  const leftRank = left.importance === null ? 3 : IMPORTANCE_RANK[left.importance];
  const rightRank = right.importance === null ? 3 : IMPORTANCE_RANK[right.importance];
  if (leftRank !== rightRank) return leftRank - rightRank;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export interface OverviewEventsInput {
  /** The macro window, or null when the calendar could not be read. */
  window: OvEventWindow | null;
  /** The Upcoming feed, or null when the reader is signed out. */
  upcoming: UpcomingFeed | null;
  portfolioSymbols?: readonly string[];
  watchlistSymbols?: readonly string[];
  now?: string | Date;
  /** Rows per group, not across both. */
  limit?: number;
}

/**
 * The section's whole payload, built on the server.
 *
 * An empty `rows` with a `coverageNoteTh` is a real state and must still
 * render: it says the calendar does not reach here, which is different from
 * saying nothing is scheduled.
 */
export function buildOverviewEvents({
  window,
  upcoming,
  portfolioSymbols = [],
  watchlistSymbols = [],
  now = new Date(),
  limit = OVERVIEW_EVENTS_GROUP_LIMIT,
}: OverviewEventsInput): OverviewEventsView {
  const macroEvents = window?.events ?? [];
  const relevance = ovEventRelevanceFor(macroEvents, { portfolioSymbols, watchlistSymbols });

  const macroRows: OverviewEventRow[] = macroEvents.flatMap((event) => {
    const days = ovEventCountdownDays(event.startsAtUtc, now);
    /*
      A release that has already happened is not something coming up. The window
      opens on today's Bangkok day, so this only ever drops a row whose instant
      passed earlier today.
    */
    if (days === null || days < 0) return [];
    return [{
      id: event.id,
      kind: 'macro' as const,
      titleTh: event.titleTh,
      dayLabel: ovEventDayLabel(event),
      timeLabel: ovEventTimeLabel(event),
      importance: event.importance,
      countdownDays: days,
      countdownText: countdownTextOf(days),
      /*
        NO NAMES ON A MACRO ROW.

        `affectedSymbols` is the same alphabetical list on every market-wide
        release — all seven codes are — because that is what the relevance
        module means by breadth. Printed as bare linked tickers under a CPI row
        it read as "these seven stocks are affected by CPI", which is precisely
        the per-symbol claim `event-relevance.ts` says it is not making. The
        count says the true part and cannot say the false one.
      */
      symbols: [],
      affectedCount: relevance.get(event.id)?.total ?? 0,
    }];
  });

  const upcomingRows = (upcoming?.events ?? []).map(fromUpcoming);

  /*
    Sorted WITHIN each group and never across them. Soonest-first is the right
    order for a list a reader plans by; it is not a reason to interleave a
    contract expiry with a jobs report, which is what one merged sort did.
  */
  const group = (rows: OverviewEventRow[]): OverviewEventGroup => {
    const ordered = [...rows].sort(compareRows);
    return { rows: ordered.slice(0, Math.max(0, limit)), total: ordered.length };
  };

  return {
    calendar: group(macroRows),
    holdings: group(upcomingRows),
    coverageNoteTh: coverageNoteOf(window),
  };
}

/**
 * The line that closes the list when the calendar runs out.
 *
 * It names the date the file actually reaches, which is the part that makes the
 * sentence checkable. `formatThaiDateOnly` is the product's own Thai date
 * formatter — a month-only form would need a second formatter for one string.
 */
function coverageNoteOf(window: OvEventWindow | null): string | null {
  if (!window) return null;
  if (window.coversThrough) return null;
  if (window.lastDayKey === null) return 'ยังไม่มีข้อมูลปฏิทินเศรษฐกิจในระบบ';
  return `ปฏิทินถึง ${formatThaiDateOnly(window.lastDayKey)} · เดือนถัดไปรอประกาศ`;
}
