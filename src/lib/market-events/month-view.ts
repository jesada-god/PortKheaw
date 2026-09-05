import {
  coverageOfMonth,
  MARKET_EVENTS,
  monthRangeOf,
  type MonthCoverageState,
} from './calendar';
import { IMPORTANCE_LABEL_TH, toFeedItem, type FeedItem } from './feed';
import { reactionsFor, type EventReactionView, type ReactionRow } from './reactions';
import { figuresFor, type EventFigureView, type FigureRow } from './figures';
import type { ReleaseTiming } from './release-timing';
import { buildMonthGrid, WEEKDAY_HEADINGS_TH } from './month-grid';
import {
  addDays,
  addMonths,
  bangkokDayKey,
  monthKeyOf,
  thaiDayLabel,
  thaiMonthLabel,
  thaiShortDayLabel,
} from './time';
import type { MarketEvent, MarketEventImportance } from './types';

/**
 * THE WHOLE CALENDAR PAGE, RESOLVED ON THE SERVER FROM TWO URL PARAMETERS.
 *
 * ===========================================================================
 * THE MONTH AND THE DAY ARE IN THE URL, NOT IN A COMPONENT
 * ===========================================================================
 * `?m=2026-10&d=2026-10-13` is the entire state of this page. That is a
 * deliberate choice over a `useState` in a client component, and it buys four
 * things at once:
 *
 *   The calendar JSON and the `Intl` formatters stay on the server. A reader
 *   downloads the month they asked for, not the file it came from — the same
 *   argument `card-view.ts` makes, and it would be given up the moment cell
 *   selection moved into the browser.
 *
 *   "Today" is decided once, by the server, from one `now`. A component that
 *   asked the browser would disagree with the HTML it hydrated over for every
 *   reader whose Bangkok day had turned since the response was generated —
 *   React #418, on a calendar cell, seen by nobody who could report it.
 *
 *   Back, forward, refresh and share all work, because a day is a location.
 *
 *   And there is no JavaScript to ship for a grid whose only interaction is
 *   navigation.
 *
 * ===========================================================================
 * A MALFORMED PARAMETER IS A FALLBACK, NEVER A THROW
 * ===========================================================================
 * These values arrive from a URL bar, a stale bookmark and a crawler, so every
 * one of them is untrusted input. `?m=banana` renders the current month;
 * `?d=2026-02-30` — well formed, not a real date — renders the month with no
 * day pre-selected rather than a day that does not exist. Nothing here throws:
 * a 500 on a calendar because somebody edited the address bar is a worse answer
 * than the calendar.
 *
 * A well-formed month OUTSIDE the file's range is NOT a malformed one, and is
 * not corrected. `?m=2027-03` draws March 2027 with the coverage note saying
 * where the calendar actually stops — which is the honest answer, and the one
 * `coverageOfMonth` exists to give. Silently bouncing the reader back to
 * September would leave them believing they had visited March and found it
 * empty.
 */

/** The month a grid can be drawn for: `YYYY-MM` with a real month number. */
const MONTH_KEY = /^\d{4}-(?:0[1-9]|1[0-2])$/;
/** The shape of a day key. Whether the DATE exists is checked separately. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export interface MonthViewCell {
  dayKey: string;
  dayNumber: number;
  /** False for the leading/trailing days that only exist to square the grid. */
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  /** The name the cell prints from `sm:` up. Null on a quiet day. */
  leadShortTh: string | null;
  /** Rendered as "+N" beside the name. Zero means no badge. */
  extraCount: number;
  total: number;
  /**
   * ONE ENTRY PER EVENT, most important first — the marks the narrow cell draws
   * instead of a name.
   *
   * At 375px a seven-column grid gives each cell about fifty pixels, which is
   * not a width a Thai release name survives: `ยอดขอรับสวัสดิการว่างงาน`
   * clipped to fit is not shorter, it is unreadable. So the phone gets a count
   * it can see at a glance and a colour it can learn, and the name arrives at
   * `sm:` where there is room for it.
   */
  marks: MarketEventImportance[];
  /**
   * The HIGHEST importance on the day, or null on a quiet one — what the cell's
   * background is washed with.
   *
   * Read off `marks[0]` rather than recomputed: `month-grid.ts` already orders
   * the day's releases most-important-first by a total order, so taking the
   * front of that list is the same answer the lead name and the first dot are
   * already using. A second `Math.max` over importances here would be a second
   * ranking to disagree with the first.
   */
  topImportance: MarketEventImportance | null;
  /**
   * What a screen reader hears, and the reason the marks are allowed to be
   * coloured dots at all.
   *
   * COLOUR IS NEVER THE ONLY CHANNEL. The label names the date, the count and
   * each importance in words, so a reader who cannot separate the three dot
   * colours — or cannot see them — loses nothing the sighted reader has. The
   * visible legend under the grid is the third channel, for the reader who can
   * see the dots but has not met them before.
   */
  ariaLabelTh: string;
}

/**
 * A panel row: the feed row, plus what the index did the last few times this
 * release was published.
 *
 * An INTERSECTION rather than a new shape, so a `SelectedDayItem` is still a
 * `FeedItem` everywhere one is wanted — `MarketEventRow` takes the narrower
 * type and neither knows nor cares that the panel hands it more.
 *
 * The history hangs off the PANEL row and not off `FeedItem`, which is what
 * keeps it out of the feed below. The feed answers "what is still coming", and
 * a column of past percentages under every future release would be answering a
 * question nobody on that list asked.
 */
export type SelectedDayItem = FeedItem & {
  /** Null when this release has no recorded history — the block then renders nothing. */
  reaction: EventReactionView | null;
  /**
   * What the release published, and what it published the month before, or
   * null — which is the usual answer, because the calendar runs months ahead of
   * the data. Built on the SERVER like everything else in this view: the file
   * behind it is a static import and a component asking for it would carry the
   * whole thing into the browser bundle.
   */
  figure: EventFigureView | null;
};

export interface SelectedDayView {
  dayKey: string;
  /** "วันศุกร์ที่ 11 กันยายน 2569". Never relative — see `headingTh`. */
  dateLabelTh: string;
  /** "วันนี้" / "พรุ่งนี้" / the full date. */
  headingTh: string;
  relative: 'today' | 'tomorrow' | 'other';
  count: number;
  /** Built by `toFeedItem`, so a panel row and a feed row cannot disagree. */
  items: SelectedDayItem[];
}

export interface MarketEventsMonthView {
  monthKey: string;
  monthLabelTh: string;
  weekdayHeadingsTh: readonly string[];
  weeks: MonthViewCell[][];
  totalInMonth: number;
  coverage: MonthCoverageState;
  /** Why the month looks the way it does. Null while the file covers it. */
  coverageNoteTh: string | null;
  /**
   * The month one step back, or NULL when there is nothing that way.
   *
   * Null is what makes the button dead rather than hidden: a control that
   * vanishes at the edge moves the other one under the reader's thumb, and a
   * calendar whose arrows change places is worse than one whose arrow greys
   * out.
   */
  prevMonthKey: string | null;
  nextMonthKey: string | null;
  /** The day the panel is showing. Null when the month offers nothing to show. */
  selected: SelectedDayView | null;
}

/** The three marks, in rank order, for the legend under the grid. */
export const MARK_LEGEND_TH: ReadonlyArray<{
  importance: MarketEventImportance;
  labelTh: string;
}> = [
  { importance: 'high', labelTh: IMPORTANCE_LABEL_TH.high },
  { importance: 'medium', labelTh: IMPORTANCE_LABEL_TH.medium },
  { importance: 'low', labelTh: IMPORTANCE_LABEL_TH.low },
];

/**
 * The month to draw, given whatever arrived in `?m=`.
 *
 * Exported because the page needs the SAME answer twice — once to build the
 * view and once to know which month the cell links should carry — and deriving
 * it in two places is how the two stop agreeing.
 */
export function resolveMonthKey(raw: string | null | undefined, todayKey: string): string {
  return typeof raw === 'string' && MONTH_KEY.test(raw) ? raw : monthKeyOf(todayKey);
}

/**
 * Whether a `?d=` value is a day that exists, in the month being drawn.
 *
 * The round trip is the real-date check: `addDays(dayKey, 0)` normalises
 * through `Date.UTC`, so 2026-02-30 comes back as 2026-03-02 and fails the
 * comparison. A regex alone would accept it and the panel would head a section
 * with a date nobody has ever lived through.
 */
function resolveSelectedDayKey(
  raw: string | null | undefined,
  monthKey: string,
): string | null {
  if (typeof raw !== 'string' || !DAY_KEY.test(raw)) return null;
  if (addDays(raw, 0) !== raw) return null;
  if (monthKeyOf(raw) !== monthKey) return null;
  return raw;
}

export function buildMarketEventsMonthView({
  now,
  monthParam,
  dayParam,
  events = MARKET_EVENTS,
  reactionBuckets,
  figureRows,
}: {
  now: string | Date;
  /** Raw `?m=`, untrusted. */
  monthParam?: string | null;
  /** Raw `?d=`, untrusted. */
  dayParam?: string | null;
  events?: readonly MarketEvent[];
  /**
   * Overrides the shipped reaction file. Every caller in the product omits it;
   * it exists so a test and the 375px capture can show the block at all, since
   * the shipped file is empty until releases are backfilled.
   */
  reactionBuckets?: Record<ReleaseTiming, readonly ReactionRow[]>;
  /**
   * Overrides the shipped figures file. Every caller in the product omits it;
   * it exists so a test and the 375px capture can show the block on a release
   * whose numbers are not published yet.
   */
  figureRows?: readonly FigureRow[];
}): MarketEventsMonthView | null {
  const todayKey = bangkokDayKey(now);
  if (!todayKey) return null;

  const monthKey = resolveMonthKey(monthParam, todayKey);
  const grid = buildMonthGrid({ monthKey, todayKey, events });
  const coverage = coverageOfMonth(monthKey, events);
  const range = monthRangeOf(events);

  const selectedDayKey = pickSelectedDay({
    requested: resolveSelectedDayKey(dayParam, monthKey),
    covered: coverage.state === 'covered',
    monthKey,
    todayKey,
    grid,
  });

  return {
    monthKey,
    monthLabelTh: thaiMonthLabel(monthKey),
    weekdayHeadingsTh: WEEKDAY_HEADINGS_TH,
    weeks: grid.weeks.map((week) => week.map((cell) => toViewCell(cell, selectedDayKey))),
    totalInMonth: grid.total,
    coverage: coverage.state,
    coverageNoteTh: coverageNoteOf(coverage),
    /*
     * One step is offered exactly when there is calendar on that side. Written
     * as a comparison against the range rather than as a clamp, so a reader who
     * typed their way OUT of the range is still offered the step that walks
     * back toward it — `?m=2027-03` keeps its back arrow and loses its forward
     * one, which is the shape that lets them find their way home.
     */
    prevMonthKey: range && monthKey > range.firstMonthKey ? addMonths(monthKey, -1) : null,
    nextMonthKey: range && monthKey < range.lastMonthKey ? addMonths(monthKey, 1) : null,
    selected: selectedDayKey
      ? toSelectedDay(selectedDayKey, findCell(grid, selectedDayKey), todayKey, reactionBuckets, figureRows)
      : null,
  };
}

/**
 * WHICH DAY THE PANEL OPENS ON, in order of what the reader most likely meant.
 *
 * 0. NOTHING AT ALL in a month the file does not cover — including the day they
 *    explicitly asked for, and including today. This is the case that took a
 *    failing test to see. "วันนี้ · ไม่มีรายการ" is a claim that the day is
 *    quiet; on a month past the end of the calendar the truth is that this
 *    calendar cannot speak for the day, which is what the coverage note says
 *    two lines above. Printing both would put a quiet-day answer and a
 *    no-data answer on the same screen and let the reader pick.
 * 1. The day they asked for. Including a QUIET one — somebody who tapped the
 *    14th of a covered month is owed the answer "nothing is scheduled", not a
 *    silent redirect to the 15th that leaves them thinking they mis-tapped.
 * 2. Today, when today is in the month on screen. It is the day the grid
 *    already marks with a disc, so opening anywhere else would make the two
 *    highlights argue.
 * 3. Otherwise the first day in the month that has anything, because a reader
 *    who paged forward to November came to see November's releases.
 * 4. And null for a covered month that genuinely holds nothing.
 */
function pickSelectedDay({
  requested,
  covered,
  monthKey,
  todayKey,
  grid,
}: {
  requested: string | null;
  covered: boolean;
  monthKey: string;
  todayKey: string;
  grid: ReturnType<typeof buildMonthGrid>;
}): string | null {
  if (!covered) return null;
  if (requested) return requested;
  if (monthKeyOf(todayKey) === monthKey) return todayKey;
  for (const week of grid.weeks) {
    for (const cell of week) {
      if (cell.inMonth && cell.total > 0) return cell.dayKey;
    }
  }
  return null;
}

function findCell(
  grid: ReturnType<typeof buildMonthGrid>,
  dayKey: string,
): ReturnType<typeof buildMonthGrid>['weeks'][number][number] | null {
  for (const week of grid.weeks) {
    for (const cell of week) {
      if (cell.inMonth && cell.dayKey === dayKey) return cell;
    }
  }
  return null;
}

function toViewCell(
  cell: ReturnType<typeof buildMonthGrid>['weeks'][number][number],
  selectedDayKey: string | null,
): MonthViewCell {
  return {
    dayKey: cell.dayKey,
    dayNumber: cell.dayNumber,
    inMonth: cell.inMonth,
    isToday: cell.isToday,
    isSelected: cell.inMonth && cell.dayKey === selectedDayKey,
    leadShortTh: cell.lead?.shortTh ?? null,
    extraCount: cell.extraCount,
    total: cell.total,
    marks: cell.events.map((event) => event.importance),
    topImportance: cell.events[0]?.importance ?? null,
    ariaLabelTh: ariaLabelOf(cell.dayKey, cell.events),
  };
}

function ariaLabelOf(dayKey: string, events: readonly MarketEvent[]): string {
  const date = thaiShortDayLabel(dayKey);
  if (events.length === 0) return `${date} ไม่มีรายการ`;
  const kinds = events.map((event) => IMPORTANCE_LABEL_TH[event.importance]).join(', ');
  return `${date} ${events.length} รายการ: ${kinds}`;
}

/**
 * The panel's payload for one day.
 *
 * A day with nothing on it still produces a view — an empty `items` and a count
 * of zero. The panel says so in a sentence, which is the answer a reader who
 * tapped a blank cell actually asked for.
 */
function toSelectedDay(
  dayKey: string,
  cell: ReturnType<typeof buildMonthGrid>['weeks'][number][number] | null,
  todayKey: string,
  reactionBuckets?: Record<ReleaseTiming, readonly ReactionRow[]>,
  figureRows?: readonly FigureRow[],
): SelectedDayView {
  const events = cell?.events ?? [];
  const relative = dayKey === todayKey
    ? 'today' as const
    : dayKey === addDays(todayKey, 1)
      ? 'tomorrow' as const
      : 'other' as const;
  const dateLabelTh = thaiDayLabel(dayKey);
  return {
    dayKey,
    dateLabelTh,
    relative,
    headingTh: relative === 'today'
      ? 'วันนี้'
      : relative === 'tomorrow'
        ? 'พรุ่งนี้'
        : dateLabelTh,
    count: events.length,
    items: events.map((event) => ({
      ...toFeedItem(event, dayKey),
      reaction: reactionsFor(event, reactionBuckets ? { buckets: reactionBuckets } : {}),
      figure: figuresFor(event, figureRows ? { rows: figureRows } : {}),
    })),
  };
}

/**
 * AN EMPTY MONTH AND AN UNCOVERED ONE MUST NOT LOOK THE SAME.
 *
 * The wording is the month-shaped twin of `card-view.ts`'s day-shaped one, and
 * says the same thing for the same reason: past the end of the file a month is
 * still perfectly drawable — thirty-one numbered, eventless cells — and a
 * reader would take that to mean nothing is scheduled, which is the opposite of
 * what is true. So the page names the month the calendar actually reaches,
 * because that is the fact that makes the sentence checkable.
 */
function coverageNoteOf(coverage: ReturnType<typeof coverageOfMonth>): string | null {
  if (coverage.state === 'covered') return null;
  if (coverage.state === 'empty') return 'ยังไม่มีข้อมูลปฏิทินเศรษฐกิจในระบบ';
  if (coverage.state === 'exhausted') {
    return `ปฏิทินนี้มีข้อมูลถึงเดือน ${thaiMonthLabel(coverage.lastMonthKey)} จึงยังไม่ครอบคลุมเดือนนี้`;
  }
  return `ปฏิทินนี้เริ่มบันทึกตั้งแต่เดือน ${thaiMonthLabel(coverage.firstMonthKey)}`;
}
