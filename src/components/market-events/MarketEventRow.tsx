import type { FeedItem } from '@/src/lib/market-events/feed';
import type { MarketEventImportance } from '@/src/lib/market-events/types';

/**
 * ONE RELEASE, AS A READER MEETS IT — the row the feed and the day panel share.
 *
 * ===========================================================================
 * WHY IT IS ONE COMPONENT AND NOT TWO THAT LOOK ALIKE
 * ===========================================================================
 * The calendar page shows the same release twice: once in the panel under the
 * grid, once in the feed of everything upcoming. The facts are identical, and
 * three of them are ones this feature is bad at noticing it has got wrong — the
 * Bangkok clock time, the importance WORDING, and the ET note that appears only
 * where the two datelines disagree. A second copy of this markup would drift on
 * exactly those three and look completely fine while doing it.
 *
 * `toFeedItem` in `feed.ts` is the other half of the same argument: one builder
 * for the data, one component for the pixels.
 *
 * ===========================================================================
 * THE IMPORTANCE CHIP IS A WORD, NOT A SCORE
 * ===========================================================================
 * It is an editorial note about how widely a release is watched — nothing here
 * measured anything — so it is labelled in Thai words rather than as a number
 * or a count of stars, both of which read as something that was computed.
 */

export const IMPORTANCE_CHIP_STYLE: Record<MarketEventImportance, string> = {
  high: 'bg-[var(--negative-soft)] text-[var(--negative)]',
  medium: 'bg-[var(--warning-soft)] text-[var(--warning)]',
  low: 'bg-[var(--surface-hover)] text-[var(--text-secondary)]',
};

/**
 * The same three ranks as a solid mark, for the grid cell that has no room for
 * a word. The hues match the chip above so the dot a reader learns in the grid
 * is the colour they meet again in the panel.
 */
export const IMPORTANCE_MARK_STYLE: Record<MarketEventImportance, string> = {
  high: 'bg-[var(--negative)]',
  medium: 'bg-[var(--warning)]',
  low: 'bg-[var(--text-muted)]',
};

export function MarketEventRow({
  item,
  testIdPrefix = 'market-events',
}: {
  item: FeedItem;
  /**
   * Why this is a prop: the panel and the feed can both be on screen showing
   * the same day, and two elements answering to `market-events-item-cpi` would
   * make every `querySelector` in a test or a QA probe find whichever came
   * first. The prefix keeps the two addressable apart.
   */
  testIdPrefix?: string;
}) {
  return (
    <li
      className="flex min-w-0 items-start gap-3 px-3.5 py-2.5 sm:px-4"
      data-testid={`${testIdPrefix}-item-${item.id}`}
    >
      <span className="shrink-0 pt-0.5 font-mono text-xs tabular-nums text-[var(--text-secondary)]">
        {item.timeLabel}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-6 text-[var(--text)]">
          {item.titleTh}
        </span>
        <span className="mt-0.5 block text-[11px] leading-4 text-[var(--text-muted)]">
          {item.source} · {item.referencePeriod}
          {item.etNoteTh && (
            <>
              {' · '}
              <span data-testid={`${testIdPrefix}-et-${item.id}`}>{item.etNoteTh}</span>
            </>
          )}
        </span>
      </span>
      <span
        className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] ${IMPORTANCE_CHIP_STYLE[item.importance]}`}
        data-testid={`${testIdPrefix}-importance-${item.id}`}
      >
        {item.importanceLabelTh}
      </span>
    </li>
  );
}
