import type { FeedItem } from '@/src/lib/market-events/feed';
import type { EventFigureView } from '@/src/lib/market-events/figures';
import type { EventReactionView } from '@/src/lib/market-events/reactions';
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

/**
 * The same three ranks as a WASH behind a whole calendar cell.
 *
 * ===========================================================================
 * THE SAME TOKENS AS THE CHIP, ON PURPOSE
 * ===========================================================================
 * `--negative-soft` and `--warning-soft` are what the chip beside the release
 * name is already filled with, so the colour a reader meets behind the 11th in
 * the grid is the colour they meet again on the row when they open it. A wash
 * mixed from anything else would be a fourth vocabulary for a three-word
 * ranking.
 *
 * Both are `color-mix(… 12–14%, transparent)` — a wash, not a fill. That is
 * what keeps the day number at full contrast on top of it, and it is why the
 * cell underneath has to stay opaque: these composite over the surface.
 *
 * `low` gets `--surface-elevated` rather than `--surface-hover`, which is the
 * hovered and the selected background. A low-importance day painted in the
 * hover colour would be a day that looks permanently pointed at.
 */
export const IMPORTANCE_WASH_STYLE: Record<MarketEventImportance, string> = {
  high: 'bg-[var(--negative-soft)]',
  medium: 'bg-[var(--warning-soft)]',
  low: 'bg-[var(--surface-elevated)]',
};

export function MarketEventRow({
  item,
  reaction = null,
  figure = null,
  testIdPrefix = 'market-events',
}: {
  item: FeedItem;
  /**
   * What the index did the last few times this release was published, or null.
   *
   * NULL RENDERS NOTHING — not a heading, not a dash, not an empty row. A
   * "ไม่มีข้อมูล" line would be a permanent apology on every row until somebody
   * backfills the calendar, and it would invite a reader to wonder what is
   * broken when the answer is that nothing is. Today the shipped history file
   * is empty, so this is null everywhere and the block appears nowhere.
   *
   * The feed below the calendar never passes it. The feed answers "what is
   * still coming"; past percentages under a future release would be answering a
   * question nobody on that list asked.
   */
  reaction?: EventReactionView | null;
  /**
   * What this release actually published, and what it published the month
   * before — or null.
   *
   * NULL RENDERS NOTHING, for the same reason `reaction` does, and it is the
   * common case rather than an edge one: the calendar runs months ahead of what
   * BLS has published, so a release that has not happened has no figure. A dash
   * there would read as a failure instead of as a future date.
   *
   * Only CPI, PPI and NFP can ever carry one. The calendar's other four kinds
   * come from DOL, the BEA and the Federal Reserve, which this feature does not
   * read — see `docs/market-events-figures.md`.
   */
  figure?: EventFigureView | null;
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
        {figure && <FigureBlock figure={figure} testId={`${testIdPrefix}-figure-${item.id}`} />}
        {reaction && <ReactionBlock reaction={reaction} testId={`${testIdPrefix}-reaction-${item.id}`} />}
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

/**
 * WHAT THE RELEASE PUBLISHED, AND WHAT IT PUBLISHED THE MONTH BEFORE.
 *
 * ===========================================================================
 * EVERY NUMBER CARRIES ITS MONTH AND ITS UNIT
 * ===========================================================================
 * "332.813" is a digit string. "ส.ค. 2569 · ดัชนี 332.813" is a fact somebody
 * can check against the agency. Both readings print both, because the whole
 * point of putting two months side by side is that a reader can tell which is
 * which — and the change between them prints its own unit too, since an index
 * moves in points and a headcount moves in people.
 *
 * ===========================================================================
 * A NUMBER THAT WILL BE REVISED SAYS SO, ON THE ROW
 * ===========================================================================
 * BLS marks NFP "preliminary" and PPI "subject to monthly revisions up to four
 * months after original publication". A reader who writes today's figure down
 * and checks the same cell in December will find a different number, so the
 * warning is rendered rather than tucked into a tooltip — and the agency's own
 * wording is kept underneath it, because "preliminary" and "revisable for four
 * months" are different promises.
 *
 * ===========================================================================
 * NO FORECAST, ANYWHERE
 * ===========================================================================
 * There is no consensus estimate in this codebase, so there is nothing here to
 * beat or miss. `EVENT_FIGURE_MUST_NOT_SAY` bans the vocabulary that would
 * imply otherwise and the tests assert it over what this renders.
 */
function FigureBlock({ figure, testId }: { figure: EventFigureView; testId: string }) {
  return (
    <span className="mt-1.5 block" data-testid={testId}>
      <span className="block text-[11px] font-medium leading-4 text-[var(--text-secondary)]">
        {figure.headingTh}
      </span>
      <span className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <Reading reading={figure.latest} strong testId={`${testId}-latest`} />
        {figure.previous && (
          <>
            <span aria-hidden="true" className="text-[10px] text-[var(--text-muted)]">·</span>
            <Reading reading={figure.previous} testId={`${testId}-previous`} />
          </>
        )}
        {figure.changeLabel && (
          <span
            className="text-[11px] tabular-nums text-[var(--text-secondary)]"
            data-testid={`${testId}-change`}
          >
            ({figure.changeLabel})
          </span>
        )}
      </span>
      {figure.preliminaryNoteTh && (
        <span className="mt-1 block" data-testid={`${testId}-preliminary`}>
          <span className="inline-block rounded-full bg-[var(--warning-soft)] px-2 py-0.5 text-[10px] leading-4 text-[var(--warning)]">
            {figure.preliminaryNoteTh}
          </span>
          {/*
            BLS's own sentence, under the short warning. The badge is what a
            reader takes in at a glance; this is what tells them for how long.
          */}
          {figure.latest.footnotesTh.length > 0 && (
            <span className="mt-0.5 block text-[10px] leading-4 text-[var(--text-muted)]">
              {figure.latest.footnotesTh.join(' · ')}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/** One month: its label, then its value with the unit that makes it readable. */
function Reading({
  reading,
  strong = false,
  testId,
}: {
  reading: EventFigureView['latest'];
  strong?: boolean;
  testId: string;
}) {
  return (
    <span className="whitespace-nowrap text-[11px] leading-4" data-testid={testId}>
      <span className="text-[var(--text-muted)]">{reading.periodLabelTh}</span>
      {' · '}
      <span className="text-[var(--text-muted)]">{reading.unitLabelTh}</span>{' '}
      <span
        className={`tabular-nums ${strong ? 'font-semibold text-[var(--text)]' : 'text-[var(--text-secondary)]'}`}
      >
        {reading.valueLabel}
      </span>
    </span>
  );
}

/**
 * WHAT THE INDEX DID, THE LAST FEW TIMES THIS RELEASE WAS PUBLISHED.
 *
 * ===========================================================================
 * EACH NUMBER KEEPS ITS DATE
 * ===========================================================================
 * The brief's line is `ครั้งก่อน ๆ — S&P 500 วันนั้น: +0.4% / -1.1% / +0.2%`,
 * and `reactionSentenceTh` is exactly that. What is rendered adds one thing to
 * it: the session each number came from, under the number.
 *
 * That is not decoration. Every figure in this product is meant to be traceable
 * to something a reader can go and look at — it is why the calendar carries a
 * `_provenance` block and why the page names four agencies at the bottom — and
 * "+0.42%" with no date attached is a number nobody can check. Three dated
 * closes are three facts; three undated percentages are an assertion.
 *
 * ===========================================================================
 * THE COLOUR IS NEVER THE CLAIM
 * ===========================================================================
 * Green and red say up and down, and so does the sign, which is printed. A
 * reader who cannot separate the two hues loses nothing.
 *
 * And neither the colour nor the copy says WHY. That the index fell on a day
 * CPI was published is a fact; "because of CPI" is a claim nobody here
 * computed. The vocabulary that would cross the line is banned by eslint over
 * this folder — see `EVENT_REACTION_MUST_NOT_SAY`.
 */
const DIRECTION_STYLE: Record<EventReactionView['samples'][number]['direction'], string> = {
  up: 'text-[var(--positive)]',
  down: 'text-[var(--negative)]',
  flat: 'text-[var(--text-secondary)]',
};

function ReactionBlock({ reaction, testId }: { reaction: EventReactionView; testId: string }) {
  return (
    <span className="mt-1.5 block min-w-0" data-testid={testId}>
      <span className="block text-[10px] leading-4 text-[var(--text-muted)]">
        {reaction.headingTh} — {reaction.measureLabelTh}
      </span>
      <span className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        {reaction.samples.map((sample) => (
          <span key={sample.eventId} className="inline-flex min-w-0 flex-col">
            <span className={`font-mono text-[11px] leading-4 tabular-nums ${DIRECTION_STYLE[sample.direction]}`}>
              {sample.changeLabel}
            </span>
            <span className="text-[10px] leading-3 text-[var(--text-muted)]">
              {sample.dayLabelTh}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}
