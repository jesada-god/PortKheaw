import Link from 'next/link';
import { StatusLabel } from '@/src/components/ui/StatusLabel';
import { stockDetailHref } from '@/src/lib/instruments/routes';
import type { OvChangeEvent, OvChangeKind } from '@/src/lib/market-overview/what-changed';

/**
 * สิ่งที่เปลี่ยนไป — a flat list, not a stack of cards.
 *
 * ===========================================================================
 * WHY THERE IS NO CARD PER ROW
 * ===========================================================================
 * Eight bordered boxes inside a bordered section is a card inside a card eight
 * times over, and the border stops meaning "this is a thing" the moment
 * everything has one. The rows are separated by the hairline the rest of the
 * product uses for lists, and what distinguishes a row is its status mark and
 * its number — which is what the reader came for.
 *
 * ===========================================================================
 * A QUIET DAY IS ONE LINE
 * ===========================================================================
 * Not an illustration, not an empty-state card, not a mascot. A reader who sees
 * a large friendly nothing three days running learns to skip the block, and
 * then misses the day it has something to say. One sentence, in the same type
 * as everything else.
 *
 * The order arrives already correct — `capWhatChanged` sorts by importance and
 * `ovChanges` preserves that — so this component sorts nothing. Re-sorting here
 * would let the page and the watchlist disagree about which change matters
 * most.
 */

/** What each kind is called on screen. One phrase per kind, no synonyms. */
const KIND_LABEL_TH: Readonly<Record<OvChangeKind, string>> = {
  price_move: 'ราคา',
  level_break: 'แนวรับ/แนวต้าน',
  volume: 'ปริมาณซื้อขาย',
  trend_flip: 'แนวโน้ม',
  earnings: 'ผลประกอบการ',
  news: 'ข่าว',
};

export function ChangesList({ changes }: { changes: readonly OvChangeEvent[] }) {
  if (changes.length === 0) {
    return (
      <p className="py-3 text-sm leading-6 text-[var(--text-secondary)]" data-testid="overview-changes-empty">
        วันนี้ยังไม่มีอะไรเปลี่ยนชัดเจน
      </p>
    );
  }
  return (
    <ul className="divide-y divide-[var(--border)]" data-testid="overview-changes-list">
      {changes.map((change) => (
        <li key={`${change.symbol}:${change.kind}`} className="min-w-0">
          <Link
            href={stockDetailHref(change.symbol)}
            data-testid={`overview-change-${change.kind}`}
            className="flex min-h-14 min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <StatusLabel level={change.level} label={change.symbol} className="shrink-0 text-sm" />
            <span className="shrink-0 text-xs text-[var(--text-muted)]">
              {KIND_LABEL_TH[change.kind]}
            </span>
            {/*
              The detector's own sentence, verbatim. It already carries the
              measurement that made the rule fire, which is the part a reader
              can check — restating it here would separate the wording from the
              threshold it quotes.
            */}
            <span className="figure min-w-0 flex-1 break-words text-sm font-semibold text-[var(--text)]">
              {change.valueText}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
