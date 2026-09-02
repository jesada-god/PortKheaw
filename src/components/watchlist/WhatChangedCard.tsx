import type { MarketSession } from '@/src/lib/market-data/market-session';
import { thaiSessionDate } from '@/src/lib/portfolio/day-change-label';
import type { WhatChangedItem } from '@/src/lib/watchlist/what-changed';
import { StatusMark } from '@/src/components/ui/StatusLabel';
import { STATUS_PRESENTATION } from '@/src/lib/presentation/status';

/**
 * มีอะไรเปลี่ยน — a mark, a symbol, a sentence. Nothing else.
 *
 * ===========================================================================
 * THE SECTION IS ABSENT WHEN NOTHING CHANGED
 * ===========================================================================
 * `null`, not an empty panel and not a line saying nothing happened. A section
 * that is always on the page is a section a reader stops seeing, and the days
 * it does have something to say are exactly the days that costs something.
 * There is no "ยังไม่มีอะไรเปลี่ยน" state to write, which is why this component
 * is the shortest one on the screen.
 *
 * ===========================================================================
 * WHAT EACH LINE IS ALLOWED TO CARRY
 * ===========================================================================
 * The mark, the symbol, and the sentence the detector wrote. That is the whole
 * row. Deliberately absent, each for a reason the product already settled:
 *
 *   NO SCORE and NO CONFIDENCE PERCENTAGE. `trend.ts` has the measurement —
 *   `evidenceAgreement` reads to anybody as a probability and is not one, with
 *   the 90-99 band hitting the same rate as the 20-29 band. A number next to a
 *   sentence about a stock is read as how sure the product is.
 *
 *   NO ADVICE. Nothing here says buy, sell, hold, or wait. Every sentence
 *   states something that happened and stops; what to do about it is the
 *   reader's, and a line that crossed into telling them would turn a list of
 *   observations into a recommendation engine with six rules behind it.
 *
 *   NO RANKING SHOWN. The list is ordered and capped, but the order is by KIND
 *   of event and is not numbered, badged, or described as importance. A reader
 *   who saw "1." beside a symbol would read it as the product's pick.
 *
 * The mark is a data mark and is `aria-hidden`: it is the part that survives a
 * screenshot, and the sentence beside it is the part that carries the meaning
 * for anybody not looking at colours. Same rule as `TrendMark`.
 *
 * It is a direction arrow, taken from the item's own `level` through the shared
 * `StatusMark`, because every line in this list is a thing a price did: it broke
 * a level, it gapped, it moved past two sigma, its trend flipped. The two lines
 * with no direction of their own — a volume surge, an earnings date — are
 * `neutral`, and `neutral` draws the flat arrow, which is the honest shape for
 * "something changed, and it was not a move up or down".
 *
 * ===========================================================================
 * WHEN THE MARKET IS SHUT, THE CARD SAYS WHICH DAY
 * ===========================================================================
 * `sessionDate` comes from `lastCompletedSessionDate` — the same answer the
 * %วันนี้ column's caption is built from, so the two cannot date one render
 * differently. While a session is running there is no date to give and the
 * caption says so instead of implying the figures are final.
 */

/** How many items the cap allows, said plainly rather than left to be inferred. */
function capNote(shown: number, limit: number): string | null {
  return shown < limit ? null : `แสดงได้มากที่สุด ${limit} รายการต่อวัน`;
}

export function WhatChangedCard({
  items,
  session,
  sessionDate,
  limit,
}: {
  items: readonly WhatChangedItem[];
  session: MarketSession;
  sessionDate: string | null;
  limit: number;
}) {
  /*
    The absence rule, enforced at the top so no branch below can accidentally
    render a frame around nothing.
  */
  if (items.length === 0) return null;

  const formatted = sessionDate === null ? null : thaiSessionDate(sessionDate);
  const caption = session === 'OPEN'
    ? 'ตลาดกำลังซื้อขายอยู่ ตัวเลขนี้ขยับตามราคาล่าสุด'
    : formatted === null
      ? 'ตลาดปิดแล้ว ตัวเลขนี้มาจากราคาปิดครั้งล่าสุด แต่ยังระบุวันที่ไม่ได้'
      : `ตลาดปิดแล้ว ตัวเลขนี้คือสรุปของ${formatted}`;
  const note = capNote(items.length, limit);

  return (
    <section className="panel min-w-0 overflow-hidden" data-testid="what-changed">
      <div className="border-b border-[var(--hairline)] px-3.5 py-3 sm:px-4">
        <h2 className="text-sm font-bold text-[var(--text)]">มีอะไรเปลี่ยน</h2>
        <p className="text-[11px] text-[var(--text-muted)]" data-testid="what-changed-caption">
          {caption}
        </p>
      </div>
      <ul className="divide-y divide-[var(--hairline)]">
        {items.map((item) => (
          <li
            key={`${item.symbol}-${item.detector}`}
            className="flex min-w-0 items-start gap-2.5 px-3.5 py-2.5 sm:px-4"
            data-testid={`what-changed-${item.symbol}-${item.detector}`}
          >
            <span
              className="shrink-0 leading-6"
              style={{ color: `var(${STATUS_PRESENTATION[item.level].token})` }}
            >
              <StatusMark level={item.level} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-sm font-bold text-[var(--text)]">{item.symbol}</span>
              {' '}
              <span className="text-sm leading-6 text-[var(--text-secondary)]">{item.text}</span>
            </span>
          </li>
        ))}
      </ul>
      {note && (
        <p className="px-3.5 pb-3 text-[11px] text-[var(--text-muted)] sm:px-4" data-testid="what-changed-cap">
          {note}
        </p>
      )}
    </section>
  );
}
