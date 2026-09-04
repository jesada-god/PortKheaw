import { groupByBangkokDay, MARKET_EVENTS } from './calendar';
import {
  addDays,
  bangkokDayKey,
  bangkokTimeLabel,
  newYorkDayKey,
  thaiDayLabel,
  thaiShortDayLabel,
} from './time';
import type { MarketEvent, MarketEventImportance } from './types';

export const IMPORTANCE_LABEL_TH: Record<MarketEventImportance, string> = {
  high: 'สำคัญมาก',
  medium: 'สำคัญปานกลาง',
  low: 'ติดตามได้',
};

export interface FeedItem {
  id: string;
  /** Bangkok wall clock, `HH:mm`. The time the reader sets an alarm by. */
  timeLabel: string;
  titleTh: string;
  importance: MarketEventImportance;
  importanceLabelTh: string;
  /**
   * "ตามเวลาสหรัฐ 9 ธ.ค." — present only when the ET day DIFFERS from the Thai
   * day the row is filed under.
   *
   * Printing it on every row would be noise; printing it on none of them is the
   * bug it exists to fix. A reader looking for coverage of the December FOMC
   * decision will find it datelined the 9th in New York while this feed files
   * it under the 10th, and without this line the two look like different
   * events.
   */
  etNoteTh: string | null;
  referencePeriod: string;
  source: MarketEvent['source'];
}

export interface FeedDay {
  dayKey: string;
  /** "วันนี้", "พรุ่งนี้", or the Buddhist-era date. */
  headingTh: string;
  /** The full B.E. date, always — the heading may be relative, this never is. */
  dateLabelTh: string;
  relative: 'today' | 'tomorrow' | 'other';
  count: number;
  items: FeedItem[];
}

/**
 * The detail feed: every upcoming day that has something on it, in day order.
 *
 * ===========================================================================
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ===========================================================================
 * It does not say which of the reader's holdings a release will move. A macro
 * print lands on the whole tape, and the only honest quantity this product has
 * is HOW MANY symbols the reader holds — which the page prints. Anything past
 * that ("CPI tends to hit tech harder") is a correlation nobody here computed,
 * and the fact that it is a widely repeated one does not make it a measurement.
 */
export function buildEventFeed({
  now,
  events = MARKET_EVENTS,
  includePast = false,
}: {
  now: string | Date;
  events?: readonly MarketEvent[];
  includePast?: boolean;
}): FeedDay[] {
  const todayKey = bangkokDayKey(now);
  if (!todayKey) return [];
  const tomorrowKey = addDays(todayKey, 1);

  return groupByBangkokDay(events)
    .filter(({ dayKey }) => includePast || dayKey >= todayKey)
    .map(({ dayKey, events: dayEvents }) => {
      const relative = dayKey === todayKey
        ? 'today' as const
        : dayKey === tomorrowKey
          ? 'tomorrow' as const
          : 'other' as const;
      const dateLabelTh = thaiDayLabel(dayKey);
      return {
        dayKey,
        relative,
        dateLabelTh,
        headingTh: relative === 'today'
          ? 'วันนี้'
          : relative === 'tomorrow'
            ? 'พรุ่งนี้'
            : dateLabelTh,
        count: dayEvents.length,
        items: dayEvents.map((event) => toFeedItem(event, dayKey)),
      };
    });
}

/**
 * THE FEED, MINUS THE DAY THE PANEL IS ALREADY SHOWING IN FULL.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * `/market-events` drew the same day twice, one block under the other: the
 * panel under the grid opens on today by default, and the feed under THAT
 * starts at today. "วันนี้ · 4 ก.ย. · NFP" appeared, and then appeared again,
 * and a reader has no way to tell whether the second one is a repeat or a
 * second release they need to look at.
 *
 * ===========================================================================
 * WHY THE DAY IS REMOVED AND THE FEED IS NOT TRUNCATED
 * ===========================================================================
 * The obvious fix — start the feed the day AFTER the selected one — is wrong
 * for every selection except today's. A reader who taps the 25th would lose the
 * 5th through the 24th from a list whose whole job is answering "what is
 * coming", and those days are still coming; they are simply not the day being
 * inspected. Removing exactly the one day the panel has already expanded keeps
 * that answer complete and removes the duplicate wherever it falls, rather than
 * only at the top.
 *
 * ===========================================================================
 * AN EMPTY FEED HAS TWO DIFFERENT CAUSES AND MUST NOT SAY ONE SENTENCE
 * ===========================================================================
 * "The calendar has nothing left" and "the only thing left is in the panel
 * above" are different facts, and the second one is what a reader meets in the
 * last week the file covers. So `hiddenDayKey` reports whether a day was
 * actually taken out, and the component says which of the two happened. It is
 * null when nothing was removed — a selection with no rows, or none at all —
 * so an empty feed cannot blame a removal that did not occur.
 */
export function splitFeedForPanel({
  days,
  panelDayKey,
}: {
  days: readonly FeedDay[];
  /** The day the panel is showing, or null when there is no panel. */
  panelDayKey: string | null;
}): { days: FeedDay[]; hiddenDayKey: string | null } {
  if (!panelDayKey) return { days: [...days], hiddenDayKey: null };
  const kept = days.filter((day) => day.dayKey !== panelDayKey);
  return {
    days: kept,
    hiddenDayKey: kept.length === days.length ? null : panelDayKey,
  };
}

/**
 * One event turned into the row a reader sees, filed under a Bangkok day.
 *
 * EXPORTED SO THERE IS STILL EXACTLY ONE OF THESE. The calendar page's
 * selected-day panel shows the same facts as a feed row — the Thai clock time,
 * the importance wording, and the ET note that only appears where the two
 * datelines disagree. A second builder would be a second place for the ET rule
 * to drift, and that rule is the one this feature is least able to notice
 * getting wrong.
 *
 * `dayKey` is the day the row is FILED under, not one derived here: the caller
 * already grouped by it, and re-deriving it would put a second answer to "which
 * day is this on" inside the function that renders the first.
 */
export function toFeedItem(event: MarketEvent, dayKey: string): FeedItem {
  const etDay = newYorkDayKey(event.at);
  return {
    id: event.id,
    timeLabel: bangkokTimeLabel(event.at) ?? '—',
    titleTh: event.titleTh,
    importance: event.importance,
    importanceLabelTh: IMPORTANCE_LABEL_TH[event.importance],
    etNoteTh: etDay && etDay !== dayKey
      ? `ตามเวลาสหรัฐคือ ${thaiShortDayLabel(etDay)}`
      : null,
    referencePeriod: event.referencePeriod,
    source: event.source,
  };
}

/**
 * How the page states the reader's exposure to a market-wide release.
 *
 * A COUNT, and nothing that resembles a prediction. Zero holdings is a real
 * answer and gets its own sentence rather than a "0" the reader has to
 * interpret.
 */
export function exposureNoteTh(holdingCount: number): string {
  if (holdingCount <= 0) return 'ยังไม่มีหุ้นในพอร์ต';
  return `กระทบทั้งตลาด — คุณถือหุ้นอยู่ ${holdingCount} ตัว`;
}
