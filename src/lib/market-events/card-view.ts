import { coverageOf, MARKET_EVENTS } from './calendar';
import { buildMonthGrid, WEEKDAY_HEADINGS_TH } from './month-grid';
import { bangkokDayKey, monthKeyOf, thaiMonthLabel, thaiShortDayLabel } from './time';
import type { MarketEvent, MarketEventImportance } from './types';

/**
 * The overview card's whole payload, resolved on the SERVER.
 *
 * Two things follow from building it here rather than in the component.
 *
 * The calendar JSON and the `Intl` formatters stay out of the client bundle —
 * the card receives finished strings and renders them, so a reader downloads
 * the month they are looking at rather than the file it came from.
 *
 * And "today" is decided once, by the server, from the same `generatedAt` the
 * rest of the page is built against. A component that asked the browser would
 * disagree with the HTML it hydrated over for every reader whose day had turned
 * since the response was generated, which is React #418 on a calendar cell.
 */
export interface MarketEventsCardCell {
  dayKey: string;
  dayNumber: number;
  inMonth: boolean;
  isToday: boolean;
  /** The name the cell prints, already chosen. Null on a quiet day. */
  leadShortTh: string | null;
  leadImportance: MarketEventImportance | null;
  /** Rendered as "+N". Zero means no badge at all. */
  extraCount: number;
  total: number;
}

export interface MarketEventsCardView {
  monthKey: string;
  monthLabelTh: string;
  weekdayHeadingsTh: readonly string[];
  weeks: MarketEventsCardCell[][];
  coverage: 'covered' | 'exhausted' | 'before' | 'empty';
  /**
   * Why the grid looks the way it does, when it needs saying. Null while the
   * calendar covers the month, because a note on a working card is noise.
   */
  coverageNoteTh: string | null;
  totalInMonth: number;
}

export function buildMarketEventsCardView({
  now,
  events = MARKET_EVENTS,
}: {
  now: string | Date;
  events?: readonly MarketEvent[];
}): MarketEventsCardView | null {
  const todayKey = bangkokDayKey(now);
  if (!todayKey) return null;
  const monthKey = monthKeyOf(todayKey);
  const grid = buildMonthGrid({ monthKey, todayKey, events });
  const coverage = coverageOf(now, events);

  return {
    monthKey,
    monthLabelTh: thaiMonthLabel(monthKey),
    weekdayHeadingsTh: WEEKDAY_HEADINGS_TH,
    weeks: grid.weeks.map((week) => week.map(toCell)),
    coverage: coverage.state,
    coverageNoteTh: coverageNoteOf(coverage),
    totalInMonth: grid.total,
  };
}

function toCell(cell: ReturnType<typeof buildMonthGrid>['weeks'][number][number]): MarketEventsCardCell {
  return {
    dayKey: cell.dayKey,
    dayNumber: cell.dayNumber,
    inMonth: cell.inMonth,
    isToday: cell.isToday,
    leadShortTh: cell.lead?.shortTh ?? null,
    leadImportance: cell.lead?.importance ?? null,
    extraCount: cell.extraCount,
    total: cell.total,
  };
}

/**
 * AN EMPTY MONTH AND AN UNCOVERED ONE MUST NOT LOOK THE SAME.
 *
 * Past the last row in the file the grid is still perfectly drawable: thirty-one
 * numbered, eventless cells. A reader would take that to mean nothing is
 * scheduled, which is the opposite of what is true — what is true is that this
 * calendar stops before their month begins. So the card says so, and names the
 * date it reaches, which is the fact that makes the sentence checkable.
 */
function coverageNoteOf(coverage: ReturnType<typeof coverageOf>): string | null {
  if (coverage.state === 'covered') return null;
  if (coverage.state === 'empty') return 'ยังไม่มีข้อมูลปฏิทินเศรษฐกิจในระบบ';
  if (coverage.state === 'exhausted') {
    return `ปฏิทินนี้มีข้อมูลถึง ${thaiShortDayLabel(coverage.lastDayKey)} จึงยังไม่ครอบคลุมเดือนนี้`;
  }
  return `ปฏิทินนี้เริ่มบันทึกตั้งแต่ ${thaiShortDayLabel(coverage.firstDayKey)}`;
}
