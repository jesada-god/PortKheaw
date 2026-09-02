import Link from 'next/link';
import { StatusLabel } from '@/src/components/ui/StatusLabel';
import { stockDetailHref } from '@/src/lib/instruments/routes';
import type {
  OverviewEventGroup,
  OverviewEventRow,
  OverviewEventsView,
} from '@/src/lib/overview/events-feed';
import type { OvEventImportance } from '@/src/lib/market-overview/events';
import type { StatusLevel } from '@/src/lib/presentation/status';

/**
 * Events — the macro calendar and everything that used to be "สิ่งที่ควรรู้
 * เร็ว ๆ นี้", in one list.
 *
 * ===========================================================================
 * WHAT THE MARK MEANS HERE, AND WHAT IT DOES NOT
 * ===========================================================================
 * A scheduled date is not good news or bad news. Nothing on this list is
 * coloured by direction, because nothing here has one — a CPI print is not
 * bullish, and an expiry in three days is not bearish. The mark carries the
 * editorial IMPORTANCE of a macro release and nothing else, and the three rows
 * that have no importance (earnings, expiry, alert) get the neutral one.
 *
 * That is the only use of colour in this section, and it is a status use: how
 * widely a release is watched is a property the calendar publishes, not a
 * prediction this list is making.
 *
 * ===========================================================================
 * THE CALENDAR SAYS WHERE IT STOPS
 * ===========================================================================
 * `coverageNoteTh` is drawn whenever the shipped calendar does not reach the end
 * of the window, and it is NEVER hidden. Past the last row the list is still
 * perfectly drawable — it simply has fewer macro rows in it — and a reader would
 * take that to mean nothing is scheduled, which is the opposite of what is true.
 */

const IMPORTANCE_LEVEL: Readonly<Record<OvEventImportance, StatusLevel>> = {
  high: 'weak',
  medium: 'neutral',
  low: 'neutral',
};

const IMPORTANCE_WORD: Readonly<Record<OvEventImportance, string>> = {
  high: 'ตลาดจับตา',
  medium: 'ปานกลาง',
  low: 'ทั่วไป',
};

function levelOf(row: OverviewEventRow): StatusLevel {
  return row.importance === null ? 'neutral' : IMPORTANCE_LEVEL[row.importance];
}

/**
 * The line under a row: when it happens, and who it concerns.
 *
 * Two shapes, because the two kinds of row answer different questions. A macro
 * release concerns the whole tape, so it states HOW MANY of the reader's
 * symbols that reaches and names none of them — the same seven tickers under
 * every release read as a per-stock claim, and `event-relevance.ts` refuses to
 * make one. A row that genuinely belongs to one company keeps its link.
 *
 * The count carries no verb. "กระทบ" would be the causal claim the relevance
 * module declines; the reader is told what is true — this is an economy-wide
 * number, and seven of the names in front of it are theirs — and draws their
 * own conclusion. Zero prints nothing, never "0 ตัว".
 */
function metaParts(row: OverviewEventRow): string[] {
  const when = [row.dayLabel, row.timeLabel].filter(Boolean).join(' · ');
  const affected = row.affectedCount && row.affectedCount > 0
    ? `${row.affectedCount} ตัวในลิสต์คุณ`
    : null;
  return [when, affected].filter((part): part is string => Boolean(part));
}

function EventRow({ row }: { row: OverviewEventRow }) {
  const meta = metaParts(row);
  return (
    <li className="min-w-0">
      <div
        className="flex min-h-14 min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2.5"
        data-testid={`overview-event-${row.kind}`}
      >
        {/*
          The countdown is the number a reader plans by, so it is the biggest
          thing on the row. An undated row — an alert that is close — prints no
          countdown at all rather than a zero.
        */}
        {row.countdownText && (
          <span className="figure shrink-0 text-sm font-bold text-[var(--text)]">
            {row.countdownText}
          </span>
        )}
        <span className="min-w-0 flex-1 break-words text-sm leading-6 text-[var(--text-secondary)]">
          {row.titleTh}
        </span>
        {row.importance !== null && (
          <StatusLabel
            level={levelOf(row)}
            label={IMPORTANCE_WORD[row.importance]}
            className="shrink-0 text-[11px]"
          />
        )}
      </div>
      {(meta.length > 0 || row.symbols.length > 0) && (
        <p className="-mt-1 pb-2 text-[11px] leading-4 text-[var(--text-muted)]">
          {meta.join(' · ')}
          {meta.length > 0 && row.symbols.length > 0 ? ' · ' : ''}
          {row.symbols.map((symbol, index) => (
            <span key={symbol}>
              {index > 0 && ' '}
              <Link
                href={stockDetailHref(symbol)}
                className="underline-offset-2 hover:underline"
                data-testid={`overview-event-symbol-${symbol}`}
              >
                {symbol}
              </Link>
            </span>
          ))}
        </p>
      )}
    </li>
  );
}

/**
 * One group, or nothing at all.
 *
 * A HEADING WITH NOTHING UNDER IT IS WORSE THAN NO HEADING: "เรื่องของหุ้นที่
 * ถืออยู่" over empty space reads as a section that failed to load, when the
 * truth is that the reader has no expiry, no earnings date and no alert coming
 * up. An empty group returns null and takes its own title with it.
 *
 * The tail is per group. "และอีก N รายการ" counts only what THIS group had
 * before its own cut, because a number that pooled both would tell a reader
 * looking at the calendar how many contract expiries they were not being shown.
 */
function EventGroup({
  group,
  titleTh,
  testId,
  children,
}: {
  group: OverviewEventGroup;
  titleTh: string;
  testId: string;
  children?: React.ReactNode;
}) {
  if (group.rows.length === 0) return null;
  const remaining = group.total - group.rows.length;
  return (
    <section className="min-w-0" data-testid={testId}>
      {/*
        A quiet label, not a second SectionTitle. The section already has one
        heading — "วันสำคัญที่ใกล้ถึง" — and two more at the same weight would
        turn one card into three.
      */}
      <h3
        className="figure-label pt-1"
        data-testid={`${testId}-heading`}
      >
        {titleTh}
      </h3>
      <ul className="divide-y divide-[var(--border)]">
        {group.rows.map((row) => <EventRow key={row.id} row={row} />)}
      </ul>
      {remaining > 0 && (
        <p className="mt-1 text-[11px] text-[var(--text-muted)]" data-testid={`${testId}-remaining`}>
          และอีก {remaining} รายการ
        </p>
      )}
      {children}
    </section>
  );
}

export function EventsList({ view }: { view: OverviewEventsView }) {
  const empty = view.calendar.rows.length === 0 && view.holdings.rows.length === 0;
  return (
    <div className="min-w-0 space-y-3" data-testid="overview-events">
      {empty ? (
        <p className="py-3 text-sm leading-6 text-[var(--text-secondary)]" data-testid="overview-events-empty">
          ยังไม่มีวันสำคัญที่ใกล้ถึง
        </p>
      ) : (
        <>
          <EventGroup
            group={view.calendar}
            titleTh="ปฏิทินเศรษฐกิจ"
            testId="overview-events-calendar"
          >
            {/*
              The coverage note belongs to THIS group and to nothing else: it
              says how far the shipped economic calendar reaches, and an expiry
              date has never depended on that file. At the foot of the whole
              section it read as a limit on everything above it.
            */}
            {view.coverageNoteTh && (
              <p
                className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]"
                data-testid="overview-events-coverage"
              >
                {view.coverageNoteTh}
              </p>
            )}
          </EventGroup>
          <EventGroup
            group={view.holdings}
            titleTh="เรื่องของหุ้นที่ถืออยู่"
            testId="overview-events-holdings"
          />
        </>
      )}
    </div>
  );
}
