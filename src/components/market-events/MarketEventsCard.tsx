import Link from 'next/link';
import { CalendarDays } from 'lucide-react';
import type { MarketEventsCardView } from '@/src/lib/market-events/card-view';

/**
 * ปฏิทินเศรษฐกิจ — one month, seven columns, Monday first.
 *
 * ===========================================================================
 * THE GRID IS THAI DAYS, NOT AMERICAN ONES
 * ===========================================================================
 * Every cell was filled by `bangkokDayKey`, so a release at 2:00 p.m. in New
 * York sits in the NEXT day's cell — which is where a reader in Bangkok will
 * actually be when it happens. That is the entire reason this feature has a
 * time module with a lint rule guarding it, and the grid is where being wrong
 * about it would be most visible and least noticed.
 *
 * ===========================================================================
 * ONE NAME PER CELL, AND A COUNT FOR THE REST
 * ===========================================================================
 * A day can hold three releases; a cell on a 390px handset fits one word. So
 * the most-watched one is named and the others are counted as "+N", rather than
 * shrinking three names until none of them is readable. Which one gets named is
 * decided by a total order in `month-grid.ts`, so it is the same on every
 * machine — and the "+N" is what stops the cell implying it was the only thing
 * happening that day.
 *
 * The importance ranking behind that choice is editorial: it is how widely a
 * release is watched, not a measurement of anything, and nothing on this card
 * or the page behind it says otherwise.
 *
 * ===========================================================================
 * MOBILE IS THE DESIGN, NOT AN ADAPTATION OF IT
 * ===========================================================================
 * Seven equal columns in a CSS grid with `min-w-0` on every cell, so the month
 * fits the width it is given instead of overflowing it. There is no horizontal
 * scroller here — a calendar that scrolls sideways has lost the one property
 * that makes it a calendar, which is that you can see the shape of the month at
 * once. The event name is clipped rather than wrapped for the same reason: a
 * wrapping cell would make rows different heights and the grid stop reading as
 * a month.
 *
 * ===========================================================================
 * AN UNCOVERED MONTH SAYS SO
 * ===========================================================================
 * `coverageNoteTh` is present exactly when the calendar cannot speak for the
 * month on screen. Without it, a reader past the end of the file would see a
 * correctly drawn month with nothing in it and conclude that nothing is
 * scheduled — the opposite of what is true.
 */
export function MarketEventsCard({ view }: { view: MarketEventsCardView }) {
  return (
    <section className="panel min-w-0 overflow-hidden" data-testid="market-events-card">
      <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-[var(--hairline)] px-3.5 py-3 sm:px-4">
        <div className="min-w-0">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-bold text-[var(--text)]">
            <CalendarDays size={16} aria-hidden="true" className="shrink-0 text-[var(--accent)]" />
            <span className="truncate">ปฏิทินเศรษฐกิจ</span>
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]" data-testid="market-events-month">
            {view.monthLabelTh} · {view.totalInMonth} รายการ
          </p>
        </div>
        <Link
          href="/market-events"
          className="shrink-0 text-xs font-medium text-[var(--accent)] hover:underline"
          data-testid="market-events-all"
        >
          ดูทั้งหมด
        </Link>
      </div>

      {view.coverageNoteTh && (
        <p
          className="border-b border-[var(--hairline)] bg-[var(--surface-hover)] px-3.5 py-2 text-[11px] leading-5 text-[var(--text-secondary)] sm:px-4"
          data-testid="market-events-coverage"
        >
          {view.coverageNoteTh}
        </p>
      )}

      <div className="min-w-0 px-2 py-3 sm:px-3">
        <div className="grid grid-cols-7 gap-px" role="presentation">
          {view.weekdayHeadingsTh.map((heading) => (
            <div
              key={heading}
              className="min-w-0 pb-1 text-center text-[10px] font-medium text-[var(--text-muted)]"
            >
              {heading}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px">
          {view.weeks.flat().map((cell) => (
            <DayCell key={cell.dayKey} cell={cell} />
          ))}
        </div>
      </div>
    </section>
  );
}

function DayCell({ cell }: { cell: MarketEventsCardView['weeks'][number][number] }) {
  /*
    A padding day is drawn faintly and is not a link. It exists to keep the
    columns aligned to real weekdays; making it tappable would send a reader to
    a day this month's card was never about.
  */
  if (!cell.inMonth) {
    return (
      <div
        className="min-w-0 rounded-md px-0.5 py-1 text-center"
        aria-hidden="true"
        data-testid="market-events-cell-outside"
      >
        <span className="text-[11px] text-[var(--text-muted)] opacity-30">{cell.dayNumber}</span>
      </div>
    );
  }

  const body = (
    <>
      <span
        className={[
          'mx-auto flex h-5 w-5 items-center justify-center rounded-full text-[11px] leading-none',
          /*
            Today is a filled disc rather than a colour on the number. Colour
            alone is not a distinction for a reader who cannot see it, and the
            grid already spends colour on the importance dot.
          */
          cell.isToday
            ? 'bg-[var(--accent)] font-bold text-[var(--accent-fg)]'
            : 'text-[var(--text-secondary)]',
        ].join(' ')}
      >
        {cell.dayNumber}
      </span>
      {cell.leadShortTh ? (
        <span className="mt-0.5 block min-w-0 truncate text-center text-[9px] font-medium leading-tight text-[var(--text)] sm:text-[10px]">
          {cell.leadShortTh}
          {cell.extraCount > 0 && (
            <span className="text-[var(--text-muted)]"> +{cell.extraCount}</span>
          )}
        </span>
      ) : (
        /*
          A quiet day is BLANK. A dash or a dot would be a mark a reader has to
          learn to ignore, on the majority of the cells in the month.
        */
        <span className="mt-0.5 block h-[12px] sm:h-[13px]" aria-hidden="true" />
      )}
    </>
  );

  if (cell.total === 0) {
    return (
      <div
        className="min-w-0 rounded-md px-0.5 py-1"
        data-testid={`market-events-cell-${cell.dayKey}`}
        data-today={cell.isToday ? 'true' : undefined}
      >
        {body}
      </div>
    );
  }

  return (
    <Link
      href={`/market-events#${cell.dayKey}`}
      className="min-w-0 rounded-md px-0.5 py-1 hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      data-testid={`market-events-cell-${cell.dayKey}`}
      data-today={cell.isToday ? 'true' : undefined}
      aria-label={`${cell.dayNumber} — ${cell.total} รายการ`}
    >
      {body}
    </Link>
  );
}
