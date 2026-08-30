import Link from 'next/link';
import { StatusLabel } from '@/src/components/ui/StatusLabel';
import { stockDetailHref } from '@/src/lib/instruments/routes';
import type { OverviewEventRow, OverviewEventsView } from '@/src/lib/overview/events-feed';
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

function EventRow({ row }: { row: OverviewEventRow }) {
  const when = [row.dayLabel, row.timeLabel].filter(Boolean).join(' · ');
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
      {(when || row.symbols.length > 0) && (
        <p className="-mt-1 pb-2 text-[11px] leading-4 text-[var(--text-muted)]">
          {when}
          {when && row.symbols.length > 0 ? ' · ' : ''}
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

export function EventsList({ view }: { view: OverviewEventsView }) {
  const remaining = view.total - view.rows.length;
  return (
    <div className="min-w-0" data-testid="overview-events">
      {view.rows.length === 0 ? (
        <p className="py-3 text-sm leading-6 text-[var(--text-secondary)]" data-testid="overview-events-empty">
          ยังไม่มีวันสำคัญที่ใกล้ถึง
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {view.rows.map((row) => <EventRow key={row.id} row={row} />)}
        </ul>
      )}
      {remaining > 0 && (
        <p className="mt-2 text-[11px] text-[var(--text-muted)]" data-testid="overview-events-remaining">
          และอีก {remaining} รายการ
        </p>
      )}
      {view.coverageNoteTh && (
        <p className="mt-2 text-[11px] leading-4 text-[var(--text-muted)]" data-testid="overview-events-coverage">
          {view.coverageNoteTh}
        </p>
      )}
    </div>
  );
}
