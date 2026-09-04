import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type {
  MarketEventsMonthView,
  MonthViewCell,
} from '@/src/lib/market-events/month-view';
import { MARK_LEGEND_TH } from '@/src/lib/market-events/month-view';
import { IMPORTANCE_MARK_STYLE, MarketEventRow } from './MarketEventRow';
import {
  dayCellBody,
  dayCellFrame,
  MONTH_GRID_CLASS,
  WeekdayHeadings,
} from './calendar-grid';

/**
 * ปฏิทินเศรษฐกิจ — a walkable month, and the day underneath it.
 *
 * ===========================================================================
 * A SERVER COMPONENT WITH NO STATE, BECAUSE THE URL IS THE STATE
 * ===========================================================================
 * Every cell is a LINK to `?m=…&d=…`, every arrow is a link to another month,
 * and there is not one line of JavaScript shipped for either. That is not
 * frugality for its own sake — the reasoning is in the header of
 * `month-view.ts` — but the consequence worth naming here is that a reader can
 * bookmark 13 October, send it to somebody, and press Back out of it.
 *
 * ===========================================================================
 * THE PHONE GETS MARKS; THE DESKTOP GETS NAMES
 * ===========================================================================
 * Seven columns at 375px is about fifty pixels a cell, and fifty pixels is not
 * a width `ยอดขอรับสวัสดิการว่างงาน` survives — clipped to fit it is not
 * shorter, it is unreadable. So below `sm:` a cell carries the day number and
 * one solid mark per release, and the name arrives at `sm:` where there is room
 * for it. The count a reader wants at a glance ("is the 25th busy?") is exactly
 * what a row of marks answers and a truncated word does not.
 *
 * There is NO horizontal scroller, here or anywhere in this feature. A calendar
 * that scrolls sideways has given up the one property that makes it a calendar,
 * which is that the shape of the month is visible at once —
 * `MarketEventsCard.test.tsx` asserts the same thing about the card.
 *
 * ===========================================================================
 * COLOUR IS NEVER THE ONLY CHANNEL
 * ===========================================================================
 * The marks are coloured, and three things make that safe. Every cell carries
 * an `aria-label` naming the date, the count and each importance in Thai words
 * (built in `month-view.ts`). The number of marks is itself the count, which
 * survives any colour vision. And a legend under the grid names the three
 * ranks, for the reader who can see the dots and has not met them before — it
 * sits under the phone layout only, because from `sm:` up the cell prints the
 * release name and the marks are gone.
 *
 * Today is a filled disc and the selected day is a ring. Two different shapes,
 * so a cell that is both is still legibly both.
 *
 * ===========================================================================
 * AN UNCOVERED MONTH IS DRAWN FAINT AND SAYS WHY
 * ===========================================================================
 * Past the end of the file a month is still perfectly drawable: thirty-one
 * numbered, eventless cells, which a reader would take to mean nothing is
 * scheduled. So the note says where the calendar actually reaches, the grid is
 * dimmed to say it is not speaking, and the cells stop being links — there is
 * no day behind them to open.
 */
export function MonthCalendar({ view }: { view: MarketEventsMonthView }) {
  const covered = view.coverage === 'covered';

  return (
    <section className="panel min-w-0 overflow-hidden" data-testid="market-events-calendar">
      <div className="flex min-w-0 items-center gap-2 border-b border-[var(--hairline)] px-2 py-2 sm:px-3">
        <MonthStep
          monthKey={view.prevMonthKey}
          direction="prev"
          labelTh="เดือนก่อนหน้า"
        />
        <div className="min-w-0 flex-1 text-center">
          <h2
            className="truncate text-sm font-bold text-[var(--text)]"
            data-testid="market-events-month"
          >
            {view.monthLabelTh}
          </h2>
          {/*
            THE COUNT IS ONLY PRINTED WHERE IT MEANS SOMETHING. On a month the
            file does not reach, "0 รายการ" is the exact sentence this feature
            spends a coverage note refusing to say — a reader would take it as
            "nothing is scheduled" rather than "this calendar stops earlier",
            and it would be sitting directly above the note that says otherwise.
          */}
          {covered && (
            <p className="text-[11px] text-[var(--text-muted)]" data-testid="market-events-month-total">
              {view.totalInMonth} รายการ
            </p>
          )}
        </div>
        <MonthStep
          monthKey={view.nextMonthKey}
          direction="next"
          labelTh="เดือนถัดไป"
        />
      </div>

      {view.coverageNoteTh && (
        <p
          className="border-b border-[var(--hairline)] bg-[var(--surface-hover)] px-3.5 py-2 text-[11px] leading-5 text-[var(--text-secondary)] sm:px-4"
          data-testid="market-events-coverage"
        >
          {view.coverageNoteTh}
        </p>
      )}

      <div className={`min-w-0 px-2 py-3 sm:px-3 ${covered ? '' : 'opacity-40'}`}>
        {/*
          The weekday row, the grid rules and the wash behind a busy day are
          all shared with `MarketEventsCard` — see `calendar-grid.tsx` for why
          the appearance is shared while the two view models stay apart.
        */}
        <WeekdayHeadings headings={view.weekdayHeadingsTh} />
        <div className={MONTH_GRID_CLASS}>
          {view.weeks.flat().map((cell) => (
            <DayCell
              key={cell.dayKey}
              cell={cell}
              monthKey={view.monthKey}
              interactive={covered}
            />
          ))}
        </div>
      </div>

      {covered && (
        <ul
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--hairline)] px-3.5 pb-2.5 pt-2 sm:hidden"
          data-testid="market-events-legend"
        >
          {MARK_LEGEND_TH.map((entry) => (
            <li key={entry.importance} className="flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${IMPORTANCE_MARK_STYLE[entry.importance]}`}
                aria-hidden="true"
              />
              <span className="text-[10px] text-[var(--text-muted)]">{entry.labelTh}</span>
            </li>
          ))}
        </ul>
      )}

      <SelectedDayPanel view={view} />
    </section>
  );
}

/**
 * One arrow. A dead one is DISABLED, not missing.
 *
 * A control that vanishes at the edge of the calendar slides the other one
 * under the reader's thumb, so the button that meant "back" last month means
 * "forward" this month. Greying out keeps both in place.
 */
function MonthStep({
  monthKey,
  direction,
  labelTh,
}: {
  monthKey: string | null;
  direction: 'prev' | 'next';
  labelTh: string;
}) {
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight;
  const testId = `market-events-${direction}-month`;
  /*
    44 SQUARE, AND THE SAME 44 WHETHER IT IS A LINK OR A DEAD BUTTON.
    `app/globals.css` gives every `button` a 44px minimum height, so a `h-9`
    pair would render 36px as a link and 44px as a disabled button — the header
    would change height at the ends of the calendar, which is exactly where the
    reader is looking. Sizing both at the tap target settles it and is the size
    a thumb wanted anyway.
  */
  const shape = 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg';

  if (!monthKey) {
    return (
      <button
        type="button"
        disabled
        aria-label={labelTh}
        data-testid={testId}
        className={`${shape} cursor-not-allowed text-[var(--text-muted)] opacity-30`}
      >
        <Icon size={18} aria-hidden="true" />
      </button>
    );
  }

  return (
    <Link
      href={`/market-events?m=${monthKey}`}
      aria-label={labelTh}
      data-testid={testId}
      className={`${shape} text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]`}
    >
      <Icon size={18} aria-hidden="true" />
    </Link>
  );
}

function DayCell({
  cell,
  monthKey,
  interactive,
}: {
  cell: MonthViewCell;
  monthKey: string;
  interactive: boolean;
}) {
  /*
    A padding day is drawn faintly and is never tappable. It exists to keep the
    columns aligned to real weekdays; opening it would send a reader to a day
    this month is not about.
  */
  if (!cell.inMonth) {
    return (
      <div
        className="min-h-11 min-w-0 bg-[var(--surface)] px-0.5 py-1 text-center"
        aria-hidden="true"
        data-testid="market-events-cell-outside"
      >
        <span className="text-[11px] text-[var(--text-muted)] opacity-30">{cell.dayNumber}</span>
      </div>
    );
  }

  const body = (
    <span className={dayCellBody(cell.topImportance)}>
      <span
        data-day-number="true"
        className={[
          'mx-auto flex h-5 w-5 items-center justify-center rounded-full text-[11px] leading-none',
          cell.isToday
            ? 'bg-[var(--accent)] font-bold text-[var(--accent-fg)]'
            : 'text-[var(--text-secondary)]',
        ].join(' ')}
      >
        {cell.dayNumber}
      </span>

      {/*
        THE PHONE LAYOUT. One mark per release, and a spacer on a quiet day so
        every row of the month keeps the same height — a grid whose rows breathe
        with their content stops reading as a month.
      */}
      <span
        className="mt-1 flex h-1.5 items-center justify-center gap-0.5 sm:hidden"
        aria-hidden="true"
      >
        {cell.marks.map((importance, index) => (
          <span
            key={`${cell.dayKey}-${index}`}
            className={`h-1.5 w-1.5 rounded-full ${IMPORTANCE_MARK_STYLE[importance]}`}
          />
        ))}
      </span>

      {/*
        THE DESKTOP LAYOUT. The name, clipped rather than wrapped, for the same
        reason: a wrapping cell makes rows different heights.
      */}
      {cell.leadShortTh ? (
        <span
          data-day-name="true"
          className="mt-0.5 hidden min-w-0 truncate text-center text-[10px] font-medium leading-tight text-[var(--text)] sm:block"
        >
          {cell.leadShortTh}
          {cell.extraCount > 0 && (
            <span className="text-[var(--text-muted)]"> +{cell.extraCount}</span>
          )}
        </span>
      ) : (
        <span className="mt-0.5 hidden h-[13px] sm:block" aria-hidden="true" />
      )}
    </span>
  );

  /*
    ONE BACKGROUND DECISION, NOT TWO CLASSES RACING.

    `bg-[var(--surface)]` and `bg-[var(--surface-hover)]` are the same
    specificity, so which one won would depend on the order Tailwind happened to
    emit them in — a coin toss that renders correctly until the day it does not.
    The selected day picks its background instead of layering a second one.

    The corners are square now. A rounded cell inside a ruled grid leaves four
    little wedges of rule colour at every intersection, and the ring on the
    selected day follows the same shape so the two agree.
  */
  /*
    A SELECTED DAY KEEPS ITS WASH and is marked by the ring instead. Overriding
    the background would mean the busiest day in the month loses the colour that
    said so at the moment a reader points at it, which is when they are most
    likely to be comparing it against its neighbours.
  */
  const frame = dayCellFrame({ selected: cell.isSelected });

  /*
    In a month the calendar cannot speak for there is no day to open, so the
    cells are plain boxes. Everywhere else EVERY day is tappable, quiet ones
    included: somebody who taps the 14th is owed the answer "nothing is
    scheduled", not a cell that ignores them.
  */
  if (!interactive) {
    return (
      <div
        className={frame}
        data-testid={`market-events-cell-${cell.dayKey}`}
        data-today={cell.isToday ? 'true' : undefined}
        data-importance={cell.topImportance ?? undefined}
      >
        {body}
      </div>
    );
  }

  return (
    <Link
      href={`/market-events?m=${monthKey}&d=${cell.dayKey}`}
      scroll={false}
      className={`${frame} focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]`}
      data-testid={`market-events-cell-${cell.dayKey}`}
      data-today={cell.isToday ? 'true' : undefined}
      data-selected={cell.isSelected ? 'true' : undefined}
      data-importance={cell.topImportance ?? undefined}
      aria-label={cell.ariaLabelTh}
      aria-current={cell.isSelected ? 'date' : undefined}
    >
      {body}
    </Link>
  );
}

/**
 * The day under the grid — a PANEL, not a modal.
 *
 * A sheet over the calendar would hide the thing the reader is comparing
 * against: tapping the 25th to see what is on it, then the 26th, then back to
 * the 25th, means opening and dismissing three times to answer one question.
 * Underneath, the grid stays visible and the next tap just changes what is
 * written here.
 *
 * It renders nothing at all when there is no day to show. A heading over empty
 * space reads as a panel that failed to load, when the truth is either that the
 * month holds nothing or that the calendar does not reach it — and in the
 * second case the coverage note above has already said so.
 */
function SelectedDayPanel({ view }: { view: MarketEventsMonthView }) {
  const day = view.selected;
  if (!day) return null;

  return (
    <div
      className="min-w-0 border-t border-[var(--hairline)]"
      data-testid="market-events-day-panel"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-3 px-3.5 py-3 sm:px-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-bold text-[var(--text)]">{day.headingTh}</h3>
          {/*
            The relative heading is convenient and the date is checkable, so a
            reader gets both — "วันนี้" alone would leave somebody returning to
            a stale tab with no way to notice.
          */}
          {day.relative !== 'other' && (
            <p className="text-[11px] text-[var(--text-muted)]">{day.dateLabelTh}</p>
          )}
        </div>
        <span
          className="shrink-0 text-[11px] text-[var(--text-muted)]"
          data-testid="market-events-panel-count"
        >
          {day.count} รายการ
        </span>
      </div>

      {day.count === 0 ? (
        <p
          className="px-3.5 pb-3.5 text-xs leading-5 text-[var(--text-secondary)] sm:px-4"
          data-testid="market-events-panel-quiet"
        >
          ไม่มีตัวเลขเศรษฐกิจตามกำหนดในวันที่เลือก
        </p>
      ) : (
        <ul className="divide-y divide-[var(--hairline)] border-t border-[var(--hairline)]">
          {day.items.map((item) => (
            <MarketEventRow
              key={item.id}
              item={item}
              reaction={item.reaction}
              testIdPrefix="market-events-panel"
            />
          ))}
        </ul>
      )}
    </div>
  );
}
