import type { MarketEventImportance } from '@/src/lib/market-events/types';
import { IMPORTANCE_LABEL_TH } from '@/src/lib/market-events/types';
import { IMPORTANCE_WASH_STYLE } from './MarketEventRow';

/**
 * THE PARTS THAT MAKE SEVEN COLUMNS LOOK LIKE A CALENDAR.
 *
 * ===========================================================================
 * WHY THIS EXISTS, AND WHAT IT DELIBERATELY DOES NOT DO
 * ===========================================================================
 * Two components draw a month: `MonthCalendar` on `/market-events` and
 * `MarketEventsCard` on the Overview. They are two components ON PURPOSE and
 * this module does not merge them — the calendar page's month is walkable, has
 * a selected day and a detail panel underneath, while the card's is read-only
 * and is built by `card-view.ts` precisely so the calendar JSON and the Intl
 * formatters stay out of the client bundle. Those are different jobs and the
 * split between `month-view.ts` and `card-view.ts` is load-bearing.
 *
 * What was NOT different, and had drifted anyway, is how the grid LOOKS: the
 * rules between the cells, the wash behind a day that has something on it, and
 * the weekday row reading as a layer above the dates rather than the top of
 * it. Those landed on the calendar page and not on the card, so one reader
 * looking at two months in the same product saw two different tables.
 *
 * So this module owns the appearance and nothing else. No data, no view model,
 * no month arithmetic — every value here is a class string or a Thai sentence,
 * and either component can render whatever it likes inside a cell.
 *
 * ===========================================================================
 * WHY THE RULES ARE A BACKGROUND AND NOT SEVEN BORDERS
 * ===========================================================================
 * `gap-px` reserves a pixel between every cell; painting the CONTAINER makes
 * the gaps visible as rules. No cell gains a border, so no number moves off the
 * baseline its neighbours sit on, and the grid costs exactly what it did.
 *
 * The rules are INNER ONLY: the container is the size of the cells it holds, so
 * its colour shows between them and nowhere else. A rule around the whole month
 * would read as a card inside a card, which is the one thing a panel must not
 * become.
 *
 * The consequence is that EVERY cell has to be opaque, padding days included. A
 * translucent cell composites over `--border` and goes grey, which is also why
 * the wash below rides on a box INSIDE the cell rather than on the cell itself.
 */

/** The seven-column container whose background shows through as the rules. */
export const MONTH_GRID_CLASS = 'grid grid-cols-7 gap-px bg-[var(--border)]';

/**
 * THE WEEKDAY ROW, AND THE THREE THINGS THAT MAKE IT A DIFFERENT LAYER.
 *
 * It used to sit one pixel above the first row of dates, in the same weight,
 * at a LARGER size than the dates themselves — `app/globals.css` floors
 * `.text-[10px]` at 12px for readability, so `จ. อ. พ.` rendered at 12 and the
 * day numbers at 11. The hierarchy was upside down and the two read as one
 * block.
 *
 * Size is not the lever available: going under that floor would fight a rule
 * that exists so small Thai labels stay legible. So the separation is a RULE in
 * `--border` (the same token the grid lines use, so the row is closed off by
 * the line that already separates the cells rather than by a second kind of
 * edge), AIR, and WEIGHT — `font-normal` against the dates' `font-medium`,
 * keeping `--text-muted` against their `--text-secondary`, so the headings are
 * now both lighter and fainter than the numbers under them.
 *
 * `tracking-wide` finishes it. Thai has no uppercase to reach for, and
 * letter-spacing is the register shift that reads as a label in either script.
 */
/*
 * THE AIR IS 12px, NOT 6px.
 *
 * The first attempt gave the row a rule and 6px under it, which measured as a
 * separation and did not read as one: on the real page the headings still sat
 * close enough to the first week to be taken for part of it. Doubling it is the
 * whole change, and it is affordable — the grid goes to 261px at 375px against
 * an original 244px, which is 1.07x of a 1.20x budget.
 *
 * Air rather than a heavier rule on purpose. A second, darker line inside a
 * panel starts to read as a box around the month, and the rules between the
 * cells are already drawn in this exact token — making one of them louder than
 * the others would say the row above is a different KIND of edge rather than
 * the same edge with more room around it.
 */
export const WEEKDAY_ROW_CLASS =
  'grid grid-cols-7 gap-px border-b border-[var(--border)] pb-2 mb-3';

const WEEKDAY_CELL_CLASS =
  'min-w-0 text-center text-[10px] font-normal tracking-wide text-[var(--text-muted)]';

export function WeekdayHeadings({ headings }: { headings: readonly string[] }) {
  return (
    <div
      className={WEEKDAY_ROW_CLASS}
      role="presentation"
      data-testid="market-events-weekdays"
    >
      {headings.map((heading) => (
        <div key={heading} className={WEEKDAY_CELL_CLASS}>{heading}</div>
      ))}
    </div>
  );
}

/**
 * The opaque base every cell needs, and the one background decision it makes.
 *
 * `bg-[var(--surface)]` and `bg-[var(--surface-hover)]` have equal specificity,
 * so a cell carrying both renders whichever Tailwind happened to emit last — a
 * coin toss that looks correct until the build order changes. A cell picks one.
 */
export function dayCellFrame({ selected = false }: { selected?: boolean } = {}): string {
  return [
    'group flex min-h-11 min-w-0 flex-col',
    selected
      ? 'bg-[var(--surface-hover)] ring-1 ring-inset ring-[var(--accent)]'
      : 'bg-[var(--surface)]',
  ].join(' ');
}

/**
 * The box inside a cell that carries the importance wash.
 *
 * `--negative-soft` and `--warning-soft` are the same tokens the importance
 * chip beside a release name is filled with, so the colour behind the 11th in
 * the grid is the colour on the row when the reader opens it. Both are 12–14%
 * mixes against transparent — a wash, not a fill — which is what keeps the text
 * on top at full strength.
 *
 * The hover state rides here too: underneath the wash it would never be seen.
 */
export function dayCellBody(importance: MarketEventImportance | null): string {
  return [
    'flex flex-1 flex-col px-0.5 py-1',
    importance ? IMPORTANCE_WASH_STYLE[importance] : '',
    'group-hover:bg-[var(--surface-hover)]',
  ].join(' ');
}

/**
 * What a screen reader hears on a cell that has a wash behind it.
 *
 * COLOUR IS NEVER THE ONLY CHANNEL. The card has one importance per day — the
 * lead, which is the highest — so the label names that one in Thai words. The
 * calendar page builds a richer label in `month-view.ts`, naming every release
 * on the day, and keeps it; this is for the surface that has less to say.
 */
export function cardDayLabelTh(
  dayNumber: number,
  total: number,
  importance: MarketEventImportance | null,
): string {
  const base = `${dayNumber} — ${total} รายการ`;
  return importance ? `${base} · ${IMPORTANCE_LABEL_TH[importance]}` : base;
}
