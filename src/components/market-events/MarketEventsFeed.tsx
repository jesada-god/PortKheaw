import type { FeedDay } from '@/src/lib/market-events/feed';
import { MarketEventRow } from './MarketEventRow';

/**
 * The detail feed: every upcoming day, in day order, with what is on it.
 *
 * ===========================================================================
 * TWO CLOCKS ON PURPOSE
 * ===========================================================================
 * The time on each row is BANGKOK — it is the clock the reader is actually
 * living in, and the one they would set a reminder by. The ET note beside it
 * appears only where the two datelines disagree, which is exactly where a
 * reader needs it: the December FOMC statement is filed here under Thursday the
 * 10th and was reported in New York on Wednesday the 9th, and without the note
 * those look like two different events.
 *
 * Putting the note on every row instead would be noise; putting it on none is
 * the bug it exists to fix.
 *
 * ===========================================================================
 * WHAT THE EXPOSURE LINE IS ALLOWED TO SAY
 * ===========================================================================
 * A COUNT OF HOLDINGS, and nothing that resembles a relationship. A macro
 * release lands on the whole tape, and how many symbols a reader holds is a
 * fact this product actually knows. Which of those symbols a given release
 * moves more is not — no correlation was computed anywhere in this codebase,
 * and the fact that "CPI hits tech harder" is a widely repeated sentence does
 * not turn it into a measurement. So the page states the count and stops.
 *
 * The importance chip is on the same footing: it is an editorial note about how
 * widely a release is watched, labelled in words rather than as a score, so it
 * cannot be mistaken for something that was measured.
 *
 * ===========================================================================
 * THE ROW ITSELF LIVES NEXT DOOR
 * ===========================================================================
 * `MarketEventRow` draws it, because the calendar page's day panel draws the
 * same release with the same three facts and a second copy of that markup would
 * drift on exactly the ones nobody would notice. This component owns the DAY —
 * its heading, its anchor and its count — and nothing below it.
 */

export function MarketEventsFeed({
  days,
  exposureNoteTh,
  hiddenDayKey = null,
}: {
  days: readonly FeedDay[];
  /** How many symbols the reader holds, already turned into a sentence. */
  exposureNoteTh: string;
  /**
   * The day taken out because the panel above is already showing it in full,
   * or null when nothing was removed. See `splitFeedForPanel`.
   */
  hiddenDayKey?: string | null;
}) {
  if (days.length === 0) {
    /*
      AN EMPTY FEED HAS TWO CAUSES AND THEY ARE NOT THE SAME NEWS.

      "The calendar has nothing upcoming left" tells a reader the file has run
      out and they should not expect more. "Everything left is in the panel
      above" tells them to look up. Printing the first sentence in the second
      situation would send somebody away from a release that is on the screen —
      which is what happens in the last week the calendar covers, the exact
      week a reader is most likely to be checking.

      Either way it is a SENTENCE. The section never renders as nothing: a feed
      that vanished silently would read as a page that failed to finish
      loading.
    */
    return (
      <section className="panel min-w-0 p-6 text-center" data-testid="market-events-feed-empty">
        <p className="text-sm text-[var(--text-secondary)]">
          {hiddenDayKey
            ? 'ไม่มีวันอื่นที่ยังมาไม่ถึง — รายการที่เหลืออยู่ในแผงด้านบนแล้ว'
            : 'ปฏิทินนี้ไม่มีรายการที่ยังมาไม่ถึงแล้ว'}
        </p>
      </section>
    );
  }

  return (
    <div className="min-w-0 space-y-4" data-testid="market-events-feed">
      <p
        className="panel-quiet px-3.5 py-2.5 text-xs leading-5 text-[var(--text-secondary)] sm:px-4"
        data-testid="market-events-exposure"
      >
        ตัวเลขเศรษฐกิจเหล่านี้กระทบตลาดโดยรวม ไม่เจาะจงหุ้นตัวใดตัวหนึ่ง · {exposureNoteTh}
      </p>

      {days.map((day) => (
        <section
          key={day.dayKey}
          id={day.dayKey}
          className="panel min-w-0 scroll-mt-24 overflow-hidden"
          data-testid={`market-events-day-${day.dayKey}`}
        >
          <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-[var(--hairline)] px-3.5 py-3 sm:px-4">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold text-[var(--text)]">{day.headingTh}</h2>
              {/*
                The relative heading is convenient and the date is checkable, so
                a reader gets both. "วันนี้" alone would leave somebody
                returning to a stale tab with no way to notice.
              */}
              {day.relative !== 'other' && (
                <p className="text-[11px] text-[var(--text-muted)]">{day.dateLabelTh}</p>
              )}
            </div>
            <span
              className="shrink-0 text-[11px] text-[var(--text-muted)]"
              data-testid={`market-events-count-${day.dayKey}`}
            >
              {day.count} รายการ
            </span>
          </div>

          <ul className="divide-y divide-[var(--hairline)]">
            {day.items.map((item) => (
              <MarketEventRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
