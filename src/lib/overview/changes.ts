import { statusFromChangePercent, type StatusLevel } from '@/src/lib/presentation/status';
import type { OverviewPrice } from './types';

/**
 * "สิ่งที่เปลี่ยนไป" — the few things worth saying out loud, from data this page
 * already holds.
 *
 * A pure function of the watchlist rows the overview has already loaded. It
 * makes no request, reads no clock, holds no state, and computes no indicator:
 * every line it produces is one number the page is already printing, restated as
 * a sentence with a threshold applied to it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, and why the list is one rule long.
 *
 * Three rules were planned. Two of them cannot be built from this page without
 * new requests, and building them anyway would have meant inventing the very
 * engine Phase 1 is not allowed to add:
 *
 *  - "ราคาแตะ/ทะลุแนวรับ-แนวต้าน" needs the market-signal engine's
 *    `nearestSupport` / `nearestResistance`. That result is Elite-gated,
 *    computed per symbol on the stock page, and is not in the overview payload.
 *    The watchlist rows carry `sparkline: []` — literally empty, see
 *    `loadWatchlistPrices` — so there is no series here to derive levels from
 *    either, and deriving them would be a second support/resistance
 *    implementation disagreeing with the first.
 *  - "label สถานะเปลี่ยนจากบาร์ก่อน" needs `readSignalHistory`, which is one
 *    admin query per symbol and returns rows only for symbols somebody has
 *    already opened on the stock page. Ten watchlist entries would mean ten
 *    queries per render, most of them empty.
 *
 * Both are recorded in PLAN.md against the data they are waiting on. What
 * remains is the rule that needs nothing the page does not have, and it is the
 * one that fires most often anyway.
 */

/** How big a day's move has to be before it is worth interrupting a reader. */
export const NOTABLE_MOVE_PERCENT = 4;

export interface OverviewChange {
  /** Stable across renders, so React keys never collide on one symbol. */
  id: string;
  symbol: string;
  level: StatusLevel;
  /** One short sentence. Carries the number, because the number is the point. */
  text: string;
}

function formatPercent(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

/**
 * The lines to draw, strongest move first.
 *
 * An EMPTY ARRAY is the normal outcome on a quiet day, and the section is
 * required to render nothing at all when it gets one. "ไม่มีการเปลี่ยนแปลง" is
 * a sentence that occupies the same space as real news while carrying none, and
 * a reader who sees it three days running stops reading the block entirely.
 */
export function buildOverviewChanges(
  watchlist: readonly OverviewPrice[],
  { limit = 4 }: { limit?: number } = {},
): OverviewChange[] {
  return watchlist
    .filter((item) => {
      /*
       * A row whose quote did not arrive is not a row that did not move. Both
       * would read as "nothing to say about this symbol", and only one of them
       * is true — so an unusable percentage is dropped here rather than being
       * allowed to fall through the threshold test as a zero.
       */
      const percent = item.changePercent;
      return percent !== null
        && Number.isFinite(percent)
        && Math.abs(percent) >= NOTABLE_MOVE_PERCENT;
    })
    .sort((left, right) => Math.abs(right.changePercent!) - Math.abs(left.changePercent!))
    .slice(0, limit)
    .map((item) => {
      const percent = item.changePercent!;
      return {
        id: `move:${item.symbol}`,
        symbol: item.symbol,
        level: statusFromChangePercent(percent),
        /*
         * "ขึ้นแรง" / "ลงแรง" — the words the brief's vocabulary list allows,
         * and a plain restatement of the number beside them. Nothing here says
         * why it moved or what to do about it: this module has no idea, and a
         * sentence that implied otherwise would be the invention the whole
         * overview is written to avoid.
         */
        text: `${item.symbol} ${percent > 0 ? 'ขึ้นแรง' : 'ลงแรง'} ${formatPercent(percent)}`,
      };
    });
}
