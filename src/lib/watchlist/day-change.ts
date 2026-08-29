/**
 * The %วันนี้ column, and the words that say which day "today" was.
 *
 * ===========================================================================
 * THIS COMPOSES. IT DOES NOT DECIDE.
 * ===========================================================================
 * Every rule here already exists and is called rather than restated:
 *
 *   `marketSession`            which of the four states the market is in
 *   `resolveDayChangeBasis`    WHICH TWO PRICES the figure is the difference of
 *   `dayChangePerUnit`         the signed move of that pair
 *   `dayChangeCopy`            the label and the sentence under it
 *
 * The portfolio day figure, the Market Status card and this column are three
 * surfaces answering one question — "what did this move today, and is today
 * still running?" — and the product has been through what happens when two of
 * them answer it separately. `day-change.ts` opens with that history: the
 * figure used to be `price − quote.previousClose` and nothing else, which has
 * no answer outside the regular session, so the row deleted itself every
 * evening and all weekend. Writing a fourth version of the rule for a watchlist
 * column would reintroduce exactly that, one surface at a time.
 *
 * So this file owns one thing the shared rules do not: turning a resolved basis
 * into a PERCENTAGE, because the portfolio wants an amount and this column
 * wants a percent, and that is the whole of the difference between them.
 *
 * ===========================================================================
 * WHEN THE MARKET IS SHUT THE COLUMN SAYS WHICH DAY
 * ===========================================================================
 * `dayChangeCopy` already draws the distinction that matters and it is not
 * "open vs closed" — it is whether the completed close IS today's. The market
 * having shut for the evening does not move today's move to another day, so a
 * reader at 21:00 ICT still sees วันนี้ with "ตลาดปิดแล้ว …" under it; on a
 * Saturday the same figure is labelled วันศุกร์ and says so. Both come from the
 * shared copy module, which is why this column and the portfolio card cannot
 * caption the same session differently.
 *
 * A null is never a zero. "Did not move" is a claim about the market and an
 * absent pair is an absence of information about it — the column prints the
 * sentence saying which half is missing instead of a calm 0.00%.
 */

import {
  dayChangePerUnit,
  resolveDayChangeBasis,
  type DayChangeBasis,
  type DaySnapshotInput,
} from '@/src/lib/portfolio/day-change';
import { dayChangeCopy, type DayChangeCopy } from '@/src/lib/portfolio/day-change-label';
import type { MarketSession } from '@/src/lib/market-data/market-session';

export interface WatchlistDayChange {
  /** Signed move per share, or null when no pair of prices existed. */
  change: number | null;
  /** The same move as a percentage of the earlier price. Null for the same reason. */
  changePercent: number | null;
  /** The completed trading date the figure is about; null while it is live. */
  sessionDate: string | null;
  /** Where the two prices came from. Null when there was no basis at all. */
  source: DayChangeBasis['source'] | null;
  /** Short label and the sentence under it. Always present, both ways. */
  copy: DayChangeCopy;
}

/**
 * What the column says when neither a live pair nor a captured close exists.
 *
 * Deliberately NOT `dayChangeUnavailableCopy` — that sentence is about a
 * portfolio ("ยังไม่ได้ราคาปิดของบางรายการในพอร์ต") and would be a lie on a row
 * that is not in one. Same discipline, own scope: name which part is missing,
 * and imply the fix, so the blank is a wait rather than a dead end.
 */
export function watchlistDayChangeUnavailableCopy(): DayChangeCopy {
  return {
    label: 'วันนี้',
    caption: 'ยังไม่ได้ราคาปิดของหุ้นตัวนี้ จึงยังคำนวณตัวเลขวันนี้ไม่ได้ ระบบจะอัปเดตให้เมื่อได้ราคามา',
  };
}

/**
 * One symbol's day figure, with the words that date it.
 *
 * `todayExchangeDate` is the exchange-local date of the reader's now, passed
 * straight through to `dayChangeCopy`, which is what lets a completed close
 * that IS today's keep the วันนี้ label instead of being relabelled to a
 * weekday and looking to a reader like the number had been replaced.
 */
export function watchlistDayChange(input: {
  session: MarketSession;
  price: number | null | undefined;
  previousClose?: number | null;
  snapshot?: DaySnapshotInput | null;
  todayExchangeDate?: string | null;
}): WatchlistDayChange {
  const basis = resolveDayChangeBasis({
    session: input.session,
    price: input.price,
    previousClose: input.previousClose,
    snapshot: input.snapshot ?? null,
  });

  if (basis === null) {
    return {
      change: null,
      changePercent: null,
      sessionDate: null,
      source: null,
      copy: watchlistDayChangeUnavailableCopy(),
    };
  }

  const change = dayChangePerUnit(basis);
  /*
    `resolveDayChangeBasis` only ever returns a pair whose halves are finite and
    positive — its own `usable` guard — so the division is safe. Guarded anyway,
    because a non-finite percentage reaching the column would render as the text
    "NaN%" beside a real price, which is worse than the blank it replaced.
  */
  const changePercent = Number.isFinite(change) && basis.prevClose > 0
    ? (change / basis.prevClose) * 100
    : null;

  return {
    change: Number.isFinite(change) ? change : null,
    changePercent,
    sessionDate: basis.sessionDate,
    source: basis.source,
    copy: dayChangeCopy({
      source: basis.source,
      sessionDate: basis.sessionDate,
      todayExchangeDate: input.todayExchangeDate ?? null,
    }),
  };
}
