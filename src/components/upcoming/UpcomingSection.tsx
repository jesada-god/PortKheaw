import Link from 'next/link';
import { BellRing, CalendarClock, ChevronRight, Hourglass } from 'lucide-react';
import { stockDetailHref } from '@/src/lib/instruments/routes';
import type { UpcomingEvent, UpcomingEventKind, UpcomingFeed } from '@/src/lib/upcoming/types';

const KIND_ICON: Record<UpcomingEventKind, typeof CalendarClock> = {
  earnings: CalendarClock,
  'option-expiry': Hourglass,
  alert: BellRing,
};

function EventRow({ event }: { event: UpcomingEvent }) {
  const Icon = KIND_ICON[event.kind];
  return <li className="min-w-0">
    <Link
      href={stockDetailHref(event.symbol)}
      data-testid={`upcoming-event-${event.kind}`}
      className="flex min-h-14 min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
        <Icon size={17} />
      </span>
      <span className="min-w-0 flex-1 break-words text-sm leading-6 text-[var(--text-secondary)]">{event.text}</span>
      <ChevronRight aria-hidden="true" size={16} className="shrink-0 text-[var(--text-muted)]" />
    </Link>
  </li>;
}

/**
 * Earnings, expiries and alerts in ONE list.
 *
 * Deliberately not three sections and not three routes: a reader asking "มีอะไร
 * ต้องรู้?" does not sort their own answer by which subsystem produced it. The
 * card shows the first few and defers the rest to `/upcoming`, which renders
 * this very component with nothing held back.
 */
export function UpcomingSection({
  feed,
  variant = 'card',
}: {
  feed: UpcomingFeed;
  /** `card` truncates and links onward; `full` is the whole list. */
  variant?: 'card' | 'full';
}) {
  const remaining = feed.total - feed.events.length;
  return <section
    className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
    data-testid="upcoming-section"
  >
    <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
      <h2 className="flex min-w-0 items-center gap-2 text-base font-bold text-[var(--text)] sm:text-lg">
        <CalendarClock aria-hidden="true" size={19} className="shrink-0 text-[var(--accent)]" />
        สิ่งที่ควรรู้เร็ว ๆ นี้
      </h2>
    </div>
    {feed.events.length === 0
      ? <p className="py-4 text-sm leading-6 text-[var(--text-secondary)]">
        ตอนนี้ยังไม่มีวันประกาศผลประกอบการ วันหมดอายุสัญญา หรือการแจ้งเตือนที่ใกล้ถึง
      </p>
      : <ul className="grid min-w-0 gap-2">
        {feed.events.map((event) => <EventRow key={event.id} event={event} />)}
      </ul>}
    {variant === 'card' && remaining > 0 && <Link
      href="/upcoming"
      data-testid="upcoming-see-all"
      className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-[var(--accent)]"
    >
      ดูทั้งหมด {feed.total} รายการ
      <ChevronRight aria-hidden="true" size={16} />
    </Link>}
  </section>;
}
